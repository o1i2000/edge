import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecoder, PullDetector, computeMetrics, linreg, weeklyTrend, DAY,
  pullsCsv, rawCsv, serializeSession, reviveSession, trendPoints, decodeText, decodeU32,
} from '../js/core.js';
import { pullProfile, scenarioForce, seedSessions, mulberry32 } from '../js/demo.js';

const packet = (samples) => {
  const dv = new DataView(new ArrayBuffer(2 + samples.length * 8));
  dv.setUint8(0, 1);
  dv.setUint8(1, samples.length * 8);
  samples.forEach(([f, us], i) => {
    dv.setFloat32(2 + i * 8, f, true);
    dv.setUint32(6 + i * 8, us, true);
  });
  return dv;
};

const run = (det, fn, seconds, hz = 80) => {
  const out = [];
  for (let i = 0; i < seconds * hz; i++) out.push(...det.push(i / hz, fn(i / hz)));
  return out;
};

test('decoder reads float32 kg + uint32 microseconds, little endian', () => {
  const d = createDecoder();
  const msg = d.decode(packet([[12.5, 1_000_000], [13.25, 1_012_500]]));
  assert.equal(msg.kind, 'samples');
  assert.deepEqual(msg.samples, [{ t: 1, f: 12.5 }, { t: 1.0125, f: 13.25 }]);
});

test('decoder unwraps the 32-bit clock', () => {
  const d = createDecoder();
  d.decode(packet([[1, 4_294_000_000]]));
  const { samples } = d.decode(packet([[1, 5_000]]));
  assert.ok(samples[0].t > 4294, `got ${samples[0].t}`);
  assert.ok(Math.abs(samples[0].t - (2 ** 32 + 5000) / 1e6) < 1e-6);
});

test('decoder ignores partial trailing samples, NaN, and handles other packet types', () => {
  const d = createDecoder();
  const dv = new DataView(new ArrayBuffer(2 + 8 + 3));
  dv.setUint8(0, 1);
  dv.setFloat32(2, NaN, true);
  assert.equal(d.decode(dv).samples.length, 0);
  assert.equal(d.decode(new Uint8Array([4, 0]).buffer).kind, 'lowPower');
  const resp = d.decode(new Uint8Array([0, 4, 0xb6, 0x0b, 0, 0]).buffer);
  assert.equal(resp.kind, 'response');
  assert.equal(decodeU32(resp.payload), 2998);
  const txt = d.decode(new Uint8Array([0, 5, 49, 46, 50, 46, 51]).buffer);
  assert.equal(decodeText(txt.payload), '1.2.3');
});

test('detector finds one pull with sensible metrics', () => {
  const det = new PullDetector();
  const ev = run(det, (t) => pullProfile(t - 1, { peak: 36, dur: 6 }), 10);
  const ends = ev.filter((e) => e.type === 'end');
  assert.equal(ends.length, 1);
  const p = ends[0].pull;
  assert.ok(Math.abs(p.peak - 36) < 0.5, `peak ${p.peak}`);
  assert.ok(p.duration > 5.5 && p.duration < 6.5, `duration ${p.duration}`);
  assert.ok(p.best1s < p.peak && p.best1s > 30, `best1s ${p.best1s}`);
  assert.ok(p.mean < p.peak && p.mean > 30);
  assert.ok(p.t90 > 0.2 && p.t90 < 0.8, `t90 ${p.t90}`);
  assert.ok(p.rfd > 30 && p.rfd < 120, `rfd ${p.rfd}`);
  assert.equal(p.t.length, p.f.length);
  assert.ok(p.onsetOffset > 0.3 && p.onsetOffset <= 0.5 + 1e-6, `pre-roll ${p.onsetOffset}`);
});

test('detector ignores bumps shorter than a second and brief spikes', () => {
  const det = new PullDetector();
  const ev = run(det, (t) => pullProfile(t - 1, { peak: 20, dur: 0.4, rise: 0.1 }), 5);
  assert.equal(ev.filter((e) => e.type === 'end').length, 0);
  const det2 = new PullDetector();
  const spike = run(det2, (t) => (Math.abs(t - 2) < 0.02 ? 40 : 0), 5);
  assert.equal(spike.filter((e) => e.type === 'start').length, 0);
});

test('the demo script produces exactly three pulls through the detector', () => {
  const det = new PullDetector();
  const rng = mulberry32(3);
  const ev = run(det, (t) => scenarioForce(t, rng), 40);
  const pulls = ev.filter((e) => e.type === 'end').map((e) => e.pull);
  assert.equal(pulls.length, 3);
  pulls.forEach((p) => assert.ok(p.peak > 35 && p.peak < 38, `peak ${p.peak}`));
});

test('flush closes a pull that is still going when the stream stops', () => {
  const det = new PullDetector();
  run(det, (t) => (t > 1 ? 30 : 0), 4);
  assert.ok(det.pulling);
  const ev = det.flush();
  assert.equal(ev[0].type, 'end');
  assert.ok(Math.abs(ev[0].pull.peak - 30) < 0.1);
});

test('metrics: linear 20 kg ramp over 1 s has an RFD of about 20 kg/s', () => {
  const t = Array.from({ length: 160 }, (_, i) => i / 80);
  const f = t.map((x) => Math.min(20, 20 * x));
  const m = computeMetrics(t, f, 0, 1.9);
  assert.ok(Math.abs(m.rfd - 20) < 1, `rfd ${m.rfd}`);
  assert.ok(Math.abs(m.peak - 20) < 0.01);
});

test('metrics: flat 30 kg for 5 s', () => {
  const t = Array.from({ length: 400 }, (_, i) => i / 80);
  const f = t.map(() => 30);
  const m = computeMetrics(t, f, 0, 4.9);
  assert.ok(Math.abs(m.best1s - 30) < 1e-9);
  assert.ok(Math.abs(m.mean - 30) < 1e-9);
  assert.ok(Math.abs(m.impulse - 30 * 4.9) < 0.2, `impulse ${m.impulse}`);
});

test('linreg recovers a known line and gives a CI', () => {
  const x = [0, 1, 2, 3, 4, 5];
  const y = x.map((v) => 30 + 0.5 * v + (v % 2 ? 0.1 : -0.1));
  const r = linreg(x, y);
  assert.ok(Math.abs(r.slope - 0.5) < 0.05);
  assert.ok(r.ci95 > 0 && r.ci95 < 0.2);
  assert.equal(linreg([1, 2], [1, 2]), null);
});

test('weekly trend needs 4+ sessions over 2+ weeks', () => {
  const now = 100 * DAY;
  const mk = (days) => days.map((d) => ({ x: now - d * DAY, y: 30 + (30 - d) * 0.05 }));
  assert.equal(weeklyTrend(mk([20, 18, 16]), 8, now), null);
  assert.equal(weeklyTrend(mk([5, 4, 3, 2]), 8, now), null);
  const t = weeklyTrend(mk([30, 24, 18, 12, 6, 1]), 8, now);
  assert.ok(Math.abs(t.perWeek - 0.35) < 0.02, `slope ${t.perWeek}`);
});

test('seeded history is detected cleanly: 4 pulls per session, left and right', () => {
  const sessions = seedSessions(Date.UTC(2026, 10, 20));
  assert.equal(sessions.length, 14);
  for (const s of sessions) {
    assert.equal(s.pulls.length, 4, `${s.id} has ${s.pulls.length} pulls`);
    assert.equal(s.pulls.filter((p) => p.hand === 'L').length, 2);
  }
  const L = trendPoints(sessions, 'peak', 'L', 'kg');
  assert.equal(L.length, 14);
  assert.ok(L[13].y > L[0].y + 4, 'left hand should trend up');
  const bw = trendPoints(sessions, 'peak', 'L', 'bw');
  assert.ok(Math.abs(bw[0].y - (L[0].y / 72) * 100) < 1e-9);
});

test('exports and JSON round trip', () => {
  const s = seedSessions(Date.UTC(2026, 10, 20))[0];
  const csv = pullsCsv([s]).trim().split('\n');
  assert.equal(csv.length, 5);
  assert.match(csv[1], /,Left,/);
  const raw = rawCsv(s).trim().split('\n');
  assert.equal(raw[0], 'pull,hand,time_s,force_kg');
  assert.ok(raw.length > 1000);
  const back = reviveSession(JSON.parse(JSON.stringify(serializeSession(s))));
  assert.equal(back.pulls[0].t.length, s.pulls[0].t.length);
  assert.ok(back.pulls[0].f instanceof Float32Array);
  assert.ok(Math.abs(back.pulls[0].peak - s.pulls[0].peak) < 1e-9);
});
