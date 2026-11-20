// charts.js - the live canvas trace plus small SVG charts. Colours come from CSS variables so light/dark just work.
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.append(n);
  return n;
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function niceTicks(lo, hi, count = 4) {
  const raw = (hi - lo) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const fmtDate = (ms) =>
  new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) +
  ', ' + new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------------ live trace */
export class LiveChart {
  constructor(canvas, { windowSec = 10 } = {}) {
    this.c = canvas;
    this.win = windowSec;
    this.data = [];
    this.pulls = [];
    this.color = '--blue';
    this.pb = null;
    this.ymax = 25;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.c.clientWidth;
    this.h = this.c.clientHeight;
    this.c.width = Math.round(this.w * dpr);
    this.c.height = Math.round(this.h * dpr);
    this.ctx = this.c.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  push(samples) {
    for (const s of samples) this.data.push(s);
    const cutoff = this.data[this.data.length - 1].t - this.win - 1;
    let k = 0;
    while (k < this.data.length && this.data[k].t < cutoff) k++;
    if (k) this.data.splice(0, k);
  }
  pullStart(t) {
    this.pulls.push({ s: t, e: null });
  }
  pullEnd(t) {
    const p = this.pulls[this.pulls.length - 1];
    if (p && p.e === null) p.e = t;
  }
  frame() {
    if (!this.c.isConnected) return this.destroy();
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }
  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const L = 30, R = 8, T = 8, B = 4;
    const pw = w - L - R, ph = h - T - B;
    const now = this.data.length ? this.data[this.data.length - 1].t : 0;
    const t0 = now - this.win;
    const vis = this.data.filter((d) => d.t >= t0);
    const vmax = vis.reduce((m, d) => Math.max(m, d.f), 0);
    const target = Math.max(20, Math.ceil((Math.max(vmax * 1.15, (this.pb || 0) * 1.1)) / 5) * 5);
    this.ymax += (target - this.ymax) * 0.15;
    const X = (t) => L + ((t - t0) / this.win) * pw;
    const Y = (v) => T + ph * (1 - Math.max(0, v) / this.ymax);
    const col = css(this.color), text3 = css('--text-3'), line = css('--line'), surface = css('--surface');

    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const ticks = niceTicks(0, this.ymax, 4).filter((v) => v <= this.ymax);
    for (const v of ticks) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L, Math.round(Y(v)) + 0.5);
      ctx.lineTo(w - R, Math.round(Y(v)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = text3;
      ctx.fillText(String(v), L - 6, Y(v));
    }
    // the pull Edge has detected, as a faint wash behind the trace
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = col;
    for (const p of this.pulls) {
      const x1 = Math.max(L, X(p.s)), x2 = Math.min(w - R, X(p.e ?? now));
      if (x2 > x1) ctx.fillRect(x1, T, x2 - x1, ph);
    }
    ctx.restore();
    while (this.pulls.length && this.pulls[0].e !== null && this.pulls[0].e < t0) this.pulls.shift();

    if (this.pb) {
      ctx.strokeStyle = css('--text-2');
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(L, Math.round(Y(this.pb)) + 0.5);
      ctx.lineTo(w - R, Math.round(Y(this.pb)) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const label = `Best ${this.pb.toFixed(1)}`;
      const ly = Math.max(T + 8, Y(this.pb) - 9);
      ctx.textAlign = 'left';
      ctx.fillStyle = surface; // backing so a gridline never strikes through the label
      ctx.fillRect(L + 3, ly - 8, ctx.measureText(label).width + 6, 16);
      ctx.fillStyle = css('--text-2');
      ctx.fillText(label, L + 6, ly);
    }
    if (vis.length > 1) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      vis.forEach((d, i) => (i ? ctx.lineTo(X(d.t), Y(d.f)) : ctx.moveTo(X(d.t), Y(d.f))));
      ctx.stroke();
      const last = vis[vis.length - 1];
      ctx.fillStyle = col;
      ctx.strokeStyle = surface;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(last.t), Y(last.f), 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------------ shared SVG scaffolding */
function scaffold(root, { H, margin, xDomain, yDomain, xTicks, yTicks, yFmt, xFmt }) {
  root.querySelector('svg')?.remove();
  const W = Math.max(280, root.clientWidth - 16);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  root.append(svg);
  const pw = W - margin.l - margin.r, ph = H - margin.t - margin.b;
  const X = (v) => margin.l + ((v - xDomain[0]) / (xDomain[1] - xDomain[0] || 1)) * pw;
  const Y = (v) => margin.t + ph * (1 - (v - yDomain[0]) / (yDomain[1] - yDomain[0] || 1));
  const grid = el('g', { class: 'grid' }, svg);
  const axis = el('g', { class: 'axis' }, svg);
  for (const v of yTicks) {
    const y = Math.round(Y(v)) + 0.5;
    el('line', { x1: margin.l, x2: W - margin.r, y1: y, y2: y }, grid);
    const t = el('text', { x: margin.l - 8, y: y + 4, 'text-anchor': 'end' }, axis);
    t.textContent = yFmt(v);
  }
  for (const v of xTicks) {
    const t = el('text', { x: X(v), y: H - 6, 'text-anchor': 'middle' }, axis);
    t.textContent = xFmt(v);
  }
  return { svg, W, H, X, Y, pw, ph, margin };
}

function tooltip(root) {
  let tip = root.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    root.append(tip);
  }
  return tip;
}

function placeTip(tip, root, svg, W, px, py) {
  tip.hidden = false;
  const k = svg.getBoundingClientRect().width / W;
  const off = svg.getBoundingClientRect().left - root.getBoundingClientRect().left;
  const top = svg.getBoundingClientRect().top - root.getBoundingClientRect().top;
  const w = tip.offsetWidth;
  let left = off + px * k - w / 2;
  left = Math.max(4, Math.min(root.clientWidth - w - 4, left));
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(4, top + py * k - tip.offsetHeight - 14)}px`;
}

/* ------------------------------------------------------------------ trend over sessions */
export function trendChart(root, { series, yFmt = (v) => v.toFixed(0), tipHtml, onOpen }) {
  const all = series.flatMap((s) => s.points);
  const H = 230;
  const margin = { l: 40, r: 44, t: 12, b: 26 };
  let x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x));
  if (x1 - x0 < 1) { x0 -= 7 * 86400000; x1 += 7 * 86400000; }
  const ys = all.map((p) => p.y);
  const span = Math.max(...ys) - Math.min(...ys) || Math.max(...ys) * 0.1 || 5;
  const yTicks = niceTicks(Math.min(...ys) - span * 0.25, Math.max(...ys) + span * 0.25, 4);
  const yDomain = [yTicks[0], yTicks[yTicks.length - 1]];
  const xTicks = [0, 1 / 3, 2 / 3, 1].map((k) => x0 + (x1 - x0) * k);
  const S = scaffold(root, { H, margin, xDomain: [x0, x1], yDomain, xTicks, yTicks, yFmt, xFmt: fmtDay });
  const { svg, X, Y, W } = S;

  const placed = [];
  for (const s of series) {
    const col = `var(${s.color})`;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    el('path', { d, fill: 'none', style: `stroke:${col};stroke-width:2;stroke-linejoin:round;stroke-linecap:round` }, svg);
    for (const p of s.points)
      el('circle', { cx: X(p.x), cy: Y(p.y), r: 4, style: `fill:${col};stroke:var(--surface);stroke-width:2` }, svg);
    const last = s.points[s.points.length - 1];
    const ly = Y(last.y);
    if (placed.every((yy) => Math.abs(yy - ly) > 14)) {
      placed.push(ly);
      const t = el('text', { class: 'endlabel', x: X(last.x) + 10, y: ly + 4 }, svg);
      t.textContent = yFmt(last.y);
    }
  }

  const cross = el('line', { y1: margin.t, y2: H - margin.b, style: 'stroke:var(--text-3);stroke-width:1' }, svg);
  const ring = el('circle', { r: 7, fill: 'none', style: 'stroke-width:2' }, svg);
  cross.style.display = ring.style.display = 'none';
  const tip = tooltip(root);
  const hit = el('rect', { x: margin.l - 8, y: 0, width: S.pw + 16, height: H - margin.b, fill: 'transparent' }, svg);
  hit.style.cursor = 'pointer';
  const flat = series.flatMap((s) => s.points.map((p) => ({ ...p, s })));
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W, py = ((ev.clientY - r.top) / r.width) * W;
    let best = null, bd = Infinity;
    for (const p of flat) {
      const d = Math.abs(X(p.x) - px) + Math.abs(Y(p.y) - py) * 0.35;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    cross.setAttribute('x1', X(best.x)); cross.setAttribute('x2', X(best.x));
    ring.setAttribute('cx', X(best.x)); ring.setAttribute('cy', Y(best.y));
    ring.style.stroke = `var(${best.s.color})`;
    cross.style.display = ring.style.display = '';
    tip.className = 'tip act';
    tip.replaceChildren();
    tip.insertAdjacentHTML('afterbegin', tipHtml(best, best.s));
    const btn = document.createElement('button');
    btn.textContent = 'Open session';
    btn.addEventListener('click', () => onOpen(best.id));
    tip.append(btn);
    placeTip(tip, root, svg, W, X(best.x), Y(best.y));
  };
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && show(e));
  svg.setAttribute('aria-label', `Trend chart with ${series.map((s) => `${s.label} (${s.points.length} sessions)`).join(' and ')}`);
}

/* ------------------------------------------------------------------ one bar per pull */
export function barChart(root, { bars, selected, onSelect, yFmt = (v) => v.toFixed(0), valFmt = (v) => v.toFixed(1) }) {
  const H = 170;
  const margin = { l: 34, r: 8, t: 18, b: 24 };
  const ymax = Math.max(...bars.map((b) => b.value));
  const yTicks = niceTicks(0, ymax * 1.08, 4);
  const yDomain = [0, yTicks[yTicks.length - 1]];
  const n = bars.length;
  const S = scaffold(root, { H, margin, xDomain: [0, n], yDomain, xTicks: [], yTicks, yFmt, xFmt: String });
  const { svg, X, Y, pw } = S;
  const slot = pw / n;
  const bw = Math.max(3, Math.min(24, slot - 2));
  bars.forEach((b, i) => {
    const cx = X(i + 0.5);
    const x0 = cx - bw / 2, x1 = cx + bw / 2, yTop = Y(b.value), yBase = Y(0);
    const r = Math.min(4, bw / 2, yBase - yTop);
    const dim = selected !== null && selected !== undefined && selected !== i;
    el('path', {
      d: `M${x0},${yBase}L${x0},${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}L${x1 - r},${yTop}Q${x1},${yTop} ${x1},${yTop + r}L${x1},${yBase}Z`,
      style: `fill:var(${b.color});opacity:${dim ? 0.4 : 1}`,
    }, svg);
    if (n <= 12) {
      const t = el('text', { x: cx, y: yTop - 5, 'text-anchor': 'middle', class: 'endlabel' }, svg);
      t.textContent = valFmt(b.value);
    }
    if (n <= 12 || i % 5 === 4 || i === 0) {
      const t = el('text', { x: cx, y: H - 6, 'text-anchor': 'middle', style: 'fill:var(--text-3);font-size:11px' }, svg);
      t.textContent = String(i + 1);
    }
    const hit = el('rect', {
      x: cx - slot / 2, y: 0, width: slot, height: H - margin.b, fill: 'transparent',
      tabindex: 0, role: 'button', 'aria-label': `Pull ${i + 1}, ${valFmt(b.value)} kilograms`,
    }, svg);
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', () => onSelect(i));
    hit.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && onSelect(i));
  });
  svg.setAttribute('aria-label', `Peak force for each of ${n} pulls`);
}

/* ------------------------------------------------------------------ one pull's force curve */
export function traceChart(root, { t, f, onsetOffset, color, peak, peakT }) {
  const H = 190;
  const margin = { l: 34, r: 14, t: 16, b: 26 };
  const xs = Array.from(t, (v) => v - onsetOffset);
  const xmin = Math.min(0, xs[0]), xmax = xs[xs.length - 1];
  const stepSec = xmax > 12 ? 4 : xmax > 6 ? 2 : 1;
  const xTicks = [];
  for (let v = 0; v <= xmax; v += stepSec) xTicks.push(v);
  const yTicks = niceTicks(0, Math.max(...f) * 1.12, 4);
  const yDomain = [0, yTicks[yTicks.length - 1]];
  const S = scaffold(root, { H, margin, xDomain: [xmin, xmax], yDomain, xTicks, yTicks, yFmt: (v) => v.toFixed(0), xFmt: (v) => `${v} s` });
  const { svg, X, Y, W } = S;
  const stride = Math.max(1, Math.floor(xs.length / 500));
  let d = '';
  for (let i = 0; i < xs.length; i += stride) d += `${d ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(f[i]).toFixed(1)}`;
  el('path', { d, fill: 'none', style: `stroke:var(${color});stroke-width:2;stroke-linejoin:round;stroke-linecap:round` }, svg);
  el('circle', { cx: X(peakT), cy: Y(peak), r: 4, style: `fill:var(${color});stroke:var(--surface);stroke-width:2` }, svg);
  const lab = el('text', { x: X(peakT), y: Y(peak) - 10, 'text-anchor': 'middle', class: 'endlabel' }, svg);
  lab.textContent = `${peak.toFixed(1)} kg`;

  const cross = el('line', { y1: margin.t, y2: H - margin.b, style: 'stroke:var(--text-3);stroke-width:1' }, svg);
  cross.style.display = 'none';
  const tip = tooltip(root);
  const hit = el('rect', { x: margin.l, y: 0, width: S.pw, height: H - margin.b, fill: 'transparent' }, svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const tv = xmin + ((px - margin.l) / S.pw) * (xmax - xmin);
    let k = 0;
    while (k < xs.length - 1 && xs[k] < tv) k++;
    cross.setAttribute('x1', X(xs[k])); cross.setAttribute('x2', X(xs[k]));
    cross.style.display = '';
    tip.className = 'tip';
    tip.innerHTML = `<b>${f[k].toFixed(1)} kg</b> at ${xs[k].toFixed(1)} s`;
    placeTip(tip, root, svg, W, X(xs[k]), Y(f[k]));
  };
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointermove', (e) => e.pointerType === 'mouse' && move(e));
  svg.setAttribute('aria-label', `Force curve for the selected pull, peak ${peak.toFixed(1)} kilograms`);
}
