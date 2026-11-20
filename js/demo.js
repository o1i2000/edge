// demo.js - a scripted fake Progressor and sample history, so the app can be tried (and tested) without hardware.
import { PullDetector, computeMetrics, DAY } from './core.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (x) => x * x * (3 - 2 * x);

/** Force (kg) of one pull, t seconds after onset: quick rise, slow fade, short release. */
export function pullProfile(t, { peak, dur, rise = 0.6, decay = 0.1 }) {
  if (t < 0 || t > dur + 0.25) return 0;
  const up = t < rise ? smooth(t / rise) : 1;
  const hold = 1 - decay * Math.min(1, Math.max(0, (t - rise) / (dur - rise)));
  const down = t > dur ? 1 - (t - dur) / 0.25 : 1;
  return peak * up * hold * down;
}

const noise = (rng, sd) => (rng() + rng() + rng() - 1.5) * sd * 1.6;

/** What the demo Progressor feels at time t: three 6 s pulls with a 6 s rest between. */
export function scenarioForce(t, rng) {
  let f = 0;
  const peaks = [36, 37.5, 35.5];
  for (let k = 0; k < 3; k++) f = Math.max(f, pullProfile(t - (2 + 12 * k), { peak: peaks[k], dur: 6 }));
  return f + noise(rng, f > 1 ? 0.12 : 0.02);
}

/** Fourteen weeks-ish of believable history for the charts. Runs real traces through the real detector. */
export function seedSessions(now = Date.now(), bodyweight = 72) {
  const rng = mulberry32(42);
  const sessions = [];
  for (let k = 0; k < 14; k++) {
    const startedAt = now - (13 - k) * 5 * DAY - 3600e3 * (k % 4);
    const pulls = [];
    for (const [hand, base, gain] of [['L', 29, 0.55], ['R', 31, 0.45]]) {
      for (let rep = 0; rep < 2; rep++) {
        const peak = base + k * gain + noise(rng, 1.1) - rep * 0.6;
        const det = new PullDetector();
        let got = null;
        for (let i = 0; i < 80 * 9; i++) {
          const t = i / 80;
          const f = pullProfile(t - 1, { peak, dur: 6 }) + noise(rng, 0.12);
          for (const e of det.push(t, f)) if (e.type === 'end') got = e.pull;
        }
        for (const e of det.flush()) if (e.type === 'end') got = e.pull;
        if (got) pulls.push({ ...got, hand });
      }
    }
    sessions.push({ id: `seed-${k}`, startedAt, type: 'peak', edge: 20, bodyweight, notes: '', pulls });
  }
  return sessions;
}

export { computeMetrics };
