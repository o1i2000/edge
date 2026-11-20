// core.js - pure logic (no DOM, no Bluetooth). Everything here is unit-tested in node.

/* ---------- Progressor protocol (from Tindeq's public API + example client) ---------- */
export const SERVICE_UUID = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57';
export const DATA_UUID = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57';
export const CONTROL_UUID = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57';

export const CMD = {
  TARE: 100,
  START: 101,
  STOP: 102,
  GET_VERSION: 107,
  GET_ERROR: 108,
  CLEAR_ERROR: 109,
  SLEEP: 110,
  GET_BATTERY: 111,
};
export const RES = { CMD: 0, WEIGHT: 1, RFD_PEAK: 2, RFD_SERIES: 3, LOW_POWER: 4 };

const toView = (buf) =>
  buf instanceof DataView
    ? buf
    : new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);

/**
 * Stateful packet decoder. Weight packets are [1, len, (float32 kg, uint32 us) x N], little endian.
 * The device clock is a 32-bit microsecond counter, so it is unwrapped here (wraps every ~71 min).
 */
export function createDecoder() {
  let wraps = 0;
  let last = -1;
  return {
    reset() {
      wraps = 0;
      last = -1;
    },
    decode(buf) {
      const dv = toView(buf);
      if (dv.byteLength < 2) return { kind: 'empty' };
      const code = dv.getUint8(0);
      if (code === RES.WEIGHT) {
        const samples = [];
        for (let off = 2; off + 8 <= dv.byteLength; off += 8) {
          const f = dv.getFloat32(off, true);
          const us = dv.getUint32(off + 4, true);
          if (last >= 0 && us + wraps * 2 ** 32 < last - 2 ** 31) wraps++;
          const total = us + wraps * 2 ** 32;
          last = total;
          if (Number.isFinite(f)) samples.push({ t: total / 1e6, f });
        }
        return { kind: 'samples', samples };
      }
      if (code === RES.LOW_POWER) return { kind: 'lowPower' };
      if (code === RES.CMD)
        return {
          kind: 'response',
          payload: new Uint8Array(dv.buffer, dv.byteOffset + 2, dv.byteLength - 2),
        };
      return { kind: 'other', code };
    },
  };
}

export const decodeText = (payload) => new TextDecoder().decode(payload).replace(/\0+$/, '');
export const decodeU32 = (payload) =>
  new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);

/* ---------- Pull metrics ---------- */
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/**
 * Metrics for one pull. t/f are parallel arrays (seconds, kg); onset/end are times in the same
 * frame as t. Samples before onset are pre-roll, used only to catch the start of the force rise.
 */
export function computeMetrics(t, f, onset, end) {
  const n = t.length;
  const s = new Float64Array(n); // 5-point centred moving average, so one noisy sample can't set the peak
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(n - 1, i + 2);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += f[k];
    s[i] = sum / (hi - lo + 1);
  }
  let i0 = 0;
  while (i0 < n - 1 && t[i0] < onset) i0++;
  let i1 = n - 1;
  while (i1 > i0 && t[i1] > end) i1--;

  let peak = -Infinity;
  let pi = i0;
  for (let i = i0; i <= i1; i++) {
    if (s[i] > peak) {
      peak = s[i];
      pi = i;
    }
  }

  let area = 0;
  for (let i = i0; i < i1; i++) area += ((f[i] + f[i + 1]) / 2) * (t[i + 1] - t[i]);
  const span = t[i1] - t[i0];
  const avg = span > 0 ? area / span : f[i0];

  // Best 1 s: highest mean force over any 1 second window (a steadier "max" than a single peak sample).
  let best1s = avg;
  if (span >= 1) {
    const P = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) P[i + 1] = P[i] + f[i];
    let best = -Infinity;
    let j = i0;
    for (let i = i0; i <= i1; i++) {
      while (t[i] - t[j] > 1) j++;
      if (t[i] - t[j] >= 0.95) best = Math.max(best, (P[i + 1] - P[j]) / (i - j + 1));
    }
    if (best > -Infinity) best1s = best;
  }

  // Rate of force development: steepest 100 ms rise between the start of the pull and the peak.
  let rfd = null;
  let j = 0;
  for (let i = 0; i <= pi; i++) {
    if (j < i) j = i;
    while (j <= pi && t[j] - t[i] < 0.1) j++;
    if (j > pi) break;
    const slope = (s[j] - s[i]) / (t[j] - t[i]);
    if (rfd === null || slope > rfd) rfd = slope;
  }

  let t90 = null;
  for (let i = i0; i <= pi; i++) {
    if (s[i] >= 0.9 * peak) {
      t90 = t[i] - onset;
      break;
    }
  }

  return {
    peak,
    peakT: t[pi] - onset,
    mean: avg,
    best1s,
    rfd,
    t90,
    impulse: area,
    duration: end - onset,
  };
}

/**
 * Streaming pull detector. Feed it (t, f) samples; it emits {type:'start'|'end'|'discard'} events.
 * A pull starts when smoothed force stays above startKg for riseSec, and ends once it stays
 * below endKg (60% of start by default, for hysteresis) for releaseSec. Works on device time only.
 */
export class PullDetector {
  constructor(opts = {}) {
    this.o = { startKg: 5, riseSec: 0.1, releaseSec: 0.4, minPullSec: 1, preSec: 0.5, smooth: 3, ...opts };
    this.o.endKg = opts.endKg ?? this.o.startKg * 0.6;
    this.reset();
  }
  reset() {
    this.state = 'idle';
    this.recent = [];
    this.win = [];
    this.cand = null;
    this.below = null;
    this.samples = [];
    this.peak = 0;
    this.last = 0;
  }
  get pulling() {
    return this.state === 'active';
  }
  get elapsed() {
    return this.state === 'active' ? this.last - this.cand : 0;
  }
  push(t, f) {
    const o = this.o;
    const ev = [];
    this.last = t;
    this.win.push(f);
    if (this.win.length > o.smooth) this.win.shift();
    const s = mean(this.win);
    this.recent.push({ t, f });
    const horizon = o.preSec + o.riseSec + 0.2;
    while (this.recent.length > 1 && t - this.recent[0].t > horizon) this.recent.shift();

    if (this.state === 'idle') {
      if (s >= o.startKg) {
        this.state = 'rising';
        this.cand = t;
      }
    } else if (this.state === 'rising') {
      if (s < o.startKg) {
        this.state = 'idle';
        this.cand = null;
      } else if (t - this.cand >= o.riseSec) {
        this.state = 'active';
        this.samples = this.recent.filter((x) => x.t >= this.cand - o.preSec);
        this.peak = s;
        this.below = null;
        ev.push({ type: 'start', t: this.cand });
      }
    } else {
      this.samples.push({ t, f });
      if (s > this.peak) this.peak = s;
      if (s < o.endKg) {
        if (this.below === null) this.below = t;
        if (t - this.below >= o.releaseSec) this._finish(this.below, ev);
      } else {
        this.below = null;
      }
    }
    return ev;
  }
  /** Call when the stream stops: closes a pull that is still in progress. */
  flush() {
    const ev = [];
    if (this.state === 'active') this._finish(this.last, ev);
    else this.state = 'idle';
    return ev;
  }
  _finish(endT, ev) {
    const duration = endT - this.cand;
    if (duration < this.o.minPullSec || this.samples.length < 3) {
      ev.push({ type: 'discard' });
    } else {
      const t0 = this.samples[0].t;
      const ts = this.samples.map((x) => x.t - t0);
      const fs = this.samples.map((x) => x.f);
      const m = computeMetrics(ts, fs, this.cand - t0, endT - t0);
      ev.push({
        type: 'end',
        pull: {
          ...m,
          onset: this.cand,
          onsetOffset: this.cand - t0,
          t: Float32Array.from(ts),
          f: Float32Array.from(fs),
        },
      });
    }
    this.state = 'idle';
    this.cand = null;
    this.below = null;
    this.samples = [];
    this.peak = 0;
  }
}

/* ---------- Statistics ---------- */
const T95 = [
  [1, 12.71], [2, 4.3], [3, 3.18], [4, 2.78], [5, 2.57], [6, 2.45], [7, 2.36], [8, 2.31],
  [9, 2.26], [10, 2.23], [12, 2.18], [15, 2.13], [20, 2.09], [30, 2.04], [1e9, 1.96],
];
const t95 = (df) => T95.find(([d]) => df <= d)[1];

/** Least squares line with a 95% confidence half-width on the slope. Needs 3+ points. */
export function linreg(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    sse += (y[i] - (intercept + slope * x[i])) ** 2;
    sst += (y[i] - my) ** 2;
  }
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { slope, intercept, r2: sst ? 1 - sse / sst : 0, ci95: t95(n - 2) * se, n };
}

export const DAY = 86400000;

/** The one number a session contributes to the trend: the best peak for that hand. */
export function sessionValue(session, hand) {
  const peaks = session.pulls.filter((p) => p.hand === hand).map((p) => p.peak);
  if (!peaks.length) return null;
  return Math.max(...peaks);
}

export function trendPoints(sessions, type, hand, metric, fallbackBw) {
  const pts = [];
  for (const s of sessions) {
    if (s.type !== type) continue;
    const v = sessionValue(s, hand);
    if (v === null) continue;
    const bw = s.bodyweight || fallbackBw;
    if (metric === 'bw' && !bw) continue;
    pts.push({ x: s.startedAt, y: metric === 'bw' ? (v / bw) * 100 : v, id: s.id, raw: v, bw });
  }
  return pts.sort((a, b) => a.x - b.x);
}

/** Weekly trend over the last `weeks` weeks. Returns null until there is enough data to say anything. */
export function weeklyTrend(points, weeks = 8, now = Date.now()) {
  const recent = points.filter((p) => p.x >= now - weeks * 7 * DAY);
  if (recent.length < 4) return null;
  if (recent[recent.length - 1].x - recent[0].x < 14 * DAY) return null;
  const r = linreg(recent.map((p) => p.x / DAY / 7), recent.map((p) => p.y));
  return r && { perWeek: r.slope, ci95: r.ci95, n: r.n };
}

/* ---------- Export ---------- */
const r = (x, d) => (x === null || x === undefined ? '' : Number(x).toFixed(d));
export const HAND_NAME = { L: 'Left', R: 'Right', B: 'Both' };

export function pullsCsv(sessions) {
  const rows = [
    'date,session,type,edge_mm,bodyweight_kg,pull,hand,peak_kg,best_1s_kg,mean_kg,duration_s,rfd_kg_per_s,time_to_90pct_s,impulse_kg_s',
  ];
  for (const s of sessions) {
    s.pulls.forEach((p, i) =>
      rows.push(
        [
          new Date(s.startedAt).toISOString(), s.id, s.type, s.edge, s.bodyweight ?? '', i + 1,
          HAND_NAME[p.hand], r(p.peak, 2), r(p.best1s, 2), r(p.mean, 2), r(p.duration, 2),
          r(p.rfd, 1), r(p.t90, 2), r(p.impulse, 2),
        ].join(','),
      ),
    );
  }
  return rows.join('\n') + '\n';
}

export function rawCsv(session) {
  const rows = ['pull,hand,time_s,force_kg'];
  session.pulls.forEach((p, i) => {
    for (let k = 0; k < p.t.length; k++)
      rows.push(`${i + 1},${HAND_NAME[p.hand]},${(p.t[k] - p.onsetOffset).toFixed(4)},${p.f[k].toFixed(3)}`);
  });
  return rows.join('\n') + '\n';
}

const round = (arr, d) => Array.from(arr, (x) => Number(x.toFixed(d)));
export const serializeSession = (s) => ({
  ...s,
  pulls: s.pulls.map((p) => ({ ...p, t: round(p.t, 4), f: round(p.f, 3) })),
});
export const reviveSession = (s) => ({
  ...s,
  pulls: s.pulls.map((p) => ({ ...p, t: Float32Array.from(p.t), f: Float32Array.from(p.f) })),
});
