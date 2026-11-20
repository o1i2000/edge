// app.js - state, views and the session flow.
import {
  PullDetector, trendPoints, weeklyTrend, pullsCsv, rawCsv,
} from './core.js';
import { ProgressorBLE, ProgressorSim } from './device.js';
import { seedSessions } from './demo.js';
import * as store from './store.js';
import { LiveChart, trendChart, barChart, traceChart, fmtDate } from './charts.js';

const params = new URLSearchParams(location.search);
const SPEED = Number(params.get('speed')) || 1;

const HAND = {
  L: { name: 'Left', color: '--blue' },
  R: { name: 'Right', color: '--orange' },
  B: { name: 'Both', color: '--aqua' },
};
// One workout for now. Sessions carry a type so more can be added later without migrating data.
const TYPE_NAME = { peak: 'Peak force' };
const TYPE = 'peak';

const S = {
  tab: 'pull',
  phase: 'disconnected', // disconnected | connecting | ready | running
  device: null,
  demo: false,
  info: { name: '', fw: '', mv: null },
  settings: store.loadSettings(),
  sessions: [],
  session: null,
  detector: null,
  chart: null,
  ui: null,
  live: { f: 0, win: [], lastPeak: null },
  pullHand: 'L',
  lastSaved: null,
  userDisconnect: false,
};
const H = { metric: 'kg', openId: null, selected: 0 };

// A short connection log (Settings > Connection log) so a first run on real hardware can be diagnosed.
const LOG = [];
function log(msg) {
  LOG.push(`${new Date().toLocaleTimeString('en-GB')} ${msg}`);
  if (LOG.length > 80) LOG.shift();
}

/* ---------- small helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

let toastTimer;
function toast(msg, ms = 3600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function seg(options, value, onChange, label) {
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label },
    options.map((o) =>
      h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(o.value === value), onclick: () => onChange(o.value),
      }, o.color && h('span', { class: 'sw', style: `background:var(${o.color})` }), o.label),
    ),
  );
}

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), input, hint && h('span', { class: 'hint' }, hint));
}

function numberInput(value, onChange, { min, max, step = 'any', id } = {}) {
  return h('input', {
    type: 'number', inputmode: 'decimal', min, max, step, id, value: value ?? '',
    onchange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)),
  });
}

function updateSettings(patch) {
  Object.assign(S.settings, patch);
  store.saveSettings(S.settings);
}

async function saveFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

let wakeLock = null;
async function holdScreen() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}
function releaseScreen() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

const pctBw = (kg, bw) => (bw ? `${Math.round((kg / bw) * 100)}%` : null);
const typeLabel = (t) => TYPE_NAME[t] || t;

function bestFor(hand) {
  let best = 0;
  for (const s of S.sessions) for (const p of s.pulls) if (p.hand === hand) best = Math.max(best, p.peak);
  if (S.session) for (const p of S.session.pulls) if (p.hand === hand) best = Math.max(best, p.peak);
  return best || null;
}

/* ---------- connecting ---------- */
function explain(err) {
  const n = err?.name || '';
  if (n === 'NotFoundError') return 'No Progressor was selected. Wake it with its button, then try again.';
  if (n === 'NetworkError' || /GATT|connect/i.test(err?.message || ''))
    return 'Could not connect. Press the Progressor button to wake it and close the Tindeq app, which holds the connection.';
  if (n === 'SecurityError' || n === 'NotAllowedError') return 'Bluetooth was blocked. Allow Bluetooth for this browser and try again.';
  return err?.message || 'Could not connect to the Progressor.';
}

async function connect({ demo = false, showAll = false } = {}) {
  S.phase = 'connecting';
  renderPull();
  log(`connecting (${demo ? 'demo' : showAll ? 'all devices' : 'Progressor filter'}), Web Bluetooth ${ProgressorBLE.supported() ? 'available' : 'missing'}`);
  try {
    const dev = demo ? new ProgressorSim({ speed: SPEED }) : new ProgressorBLE({ showAll });
    await dev.connect();
    log(`connected to ${dev.name}, notifications on`);
    dev.on('samples', onSamples);
    dev.on('lowPower', () => toast('The Progressor battery is low.'));
    dev.on('disconnect', () => onDisconnect(dev));
    S.device = dev;
    S.demo = demo;
    S.userDisconnect = false;
    S.info = { name: dev.name, fw: '', mv: null };
    S.phase = 'ready';
    renderPull();
    try {
      S.info.fw = await dev.version();
      log(`firmware reply: ${S.info.fw}`);
      S.info.mv = await dev.battery();
      log(`battery reply: ${S.info.mv} mV`);
    } catch (err) {
      log(`firmware/battery query failed: ${err.message}`);
    }
  } catch (err) {
    S.phase = 'disconnected';
    log(`connect failed: ${err?.name}: ${err?.message}`);
    toast(explain(err), 6000);
  }
  renderPull();
}

async function onDisconnect(dev) {
  if (dev !== S.device) return;
  log(S.userDisconnect ? 'disconnected by you' : 'connection lost');
  if (S.userDisconnect) {
    S.phase = 'disconnected';
    S.device = null;
    return renderPull();
  }
  const wasRunning = S.phase === 'running';
  if (wasRunning) await finishSession({ lost: true });
  for (let i = 0; i < 2; i++) {
    try {
      await dev.reconnect();
      S.phase = 'ready';
      toast(wasRunning ? 'Connection dropped. Your pulls were saved. Start a new session to carry on.' : 'Reconnected to the Progressor.');
      return renderPull();
    } catch {
      await sleep(800);
    }
  }
  S.phase = 'disconnected';
  S.device = null;
  toast('The Progressor disconnected. Press its button to wake it, then connect again.', 6000);
  renderPull();
}

function disconnect() {
  S.userDisconnect = true;
  S.device?.disconnect(); // both device types announce the disconnect, which onDisconnect handles
}

/* ---------- a session ---------- */
async function startSession() {
  const st = S.settings;
  S.session = { id: uid(), startedAt: Date.now(), type: TYPE, edge: st.edge, bodyweight: st.bodyweight, notes: '', pulls: [] };
  S.detector = new PullDetector({ startKg: st.threshold });
  S.live = { f: 0, win: [], lastPeak: null, n: 0, t0: null, rateLogged: false };
  S.pullHand = st.hand;
  S.phase = 'running';
  renderPull();
  try {
    await S.device.tare(); // the Progressor must be unloaded here
    await sleep(250);
    await S.device.start();
    log('tare and start sent');
    holdScreen();
    tick();
    setTimeout(() => {
      if (S.phase === 'running' && !S.live.n) {
        log('no samples received 3 s after start');
        toast('No data from the Progressor yet. Check the connection log in Settings.', 6000);
      }
    }, 3000);
  } catch (err) {
    S.phase = 'ready';
    S.session = null;
    toast(explain(err), 6000);
    renderPull();
  }
}

function onSamples(samples) {
  if (S.phase !== 'running' || !samples.length) return;
  const L = S.live;
  if (L.t0 === null) {
    L.t0 = samples[0].t;
    log(`first packet: ${samples.length} samples, first ${samples[0].f.toFixed(2)} kg at ${samples[0].t.toFixed(3)} s`);
  }
  L.n += samples.length;
  const span = samples[samples.length - 1].t - L.t0;
  if (!L.rateLogged && span >= 2) {
    L.rateLogged = true;
    log(`streaming: ${L.n} samples in ${span.toFixed(1)} s, about ${Math.round(L.n / span)} Hz`);
  }
  S.chart?.push(samples);
  for (const s of samples) {
    S.live.win.push(s.f);
    if (S.live.win.length > 3) S.live.win.shift();
    for (const e of S.detector.push(s.t, s.f)) {
      if (e.type === 'start') {
        S.pullHand = S.settings.hand;
        S.chart?.pullStart(e.t);
      } else if (e.type === 'end') {
        S.chart?.pullEnd(e.pull.onset + e.pull.duration);
        addPull(e.pull, S.pullHand);
      } else if (e.type === 'discard') {
        S.chart?.pulls.pop();
      }
    }
  }
  S.live.f = mean(S.live.win);
}

function addPull(pull, hand) {
  S.session.pulls.push({ ...pull, hand });
  S.live.lastPeak = pull.peak;
  if (S.chart) S.chart.pb = bestFor(S.settings.hand);
  renderPullList();
}

async function finishSession() {
  const sess = S.session;
  if (!sess) return;
  S.phase = 'ready';
  try {
    await S.device.stop();
  } catch {
    /* already gone */
  }
  for (const e of S.detector.flush()) if (e.type === 'end') sess.pulls.push({ ...e.pull, hand: S.pullHand });
  releaseScreen();
  if (sess.pulls.length) {
    await store.putSession(sess);
    S.sessions.push(sess);
    S.lastSaved = sess;
    toast(`Saved ${sess.pulls.length} ${sess.pulls.length === 1 ? 'pull' : 'pulls'}.`);
  } else {
    toast(`No pulls found, so nothing was saved. A pull needs more than ${S.settings.threshold} kg for over a second.`, 6000);
  }
  S.session = null;
  S.chart = null;
  S.ui = null;
  renderPull();
  try {
    S.info.mv = await S.device.battery();
    if (S.phase === 'ready') renderPull();
  } catch {
    /* ignore */
  }
}

/* ---------- Pull tab ---------- */
function statusRow() {
  const bat = S.info.mv ? `${(S.info.mv / 1000).toFixed(2)} V` : '';
  return h('div', { class: 'row' },
    h('div', { class: 'device' }, h('span', { class: 'dot' }), h('span', {}, [S.info.name, bat].filter(Boolean).join('  '))),
    S.phase === 'ready' && h('button', { class: 'link', onclick: disconnect }, 'Disconnect'),
  );
}

function renderPull() {
  const root = $('#view-pull');
  root.replaceChildren();
  S.ui = null;
  if (S.phase === 'running') return viewRunning(root);
  if (S.phase === 'ready') return viewReady(root);
  viewConnect(root);
}

function viewConnect(root) {
  const busy = S.phase === 'connecting';
  const supported = ProgressorBLE.supported();
  root.append(h('div', { class: 'connect stack' },
    h('h1', {}, 'Edge'),
    h('p', {}, 'Finger strength tests with your Tindeq Progressor. Press its button to wake it and close the Tindeq app, then connect.'),
    !supported && h('div', { class: 'notice bad' },
      h('strong', {}, 'This browser cannot use Bluetooth. '),
      'On iPhone, open this page in the free Bluefy browser. Safari and Chrome on iPhone do not support it.'),
    h('button', { class: 'btn', disabled: busy || !supported, onclick: () => connect() }, busy ? 'Connecting…' : 'Connect Progressor'),
    h('button', { class: 'btn secondary', disabled: busy, onclick: () => connect({ demo: true }) }, 'Try the demo'),
    supported && h('button', { class: 'link', disabled: busy, onclick: () => connect({ showAll: true }) }, 'Progressor not listed? Show all Bluetooth devices'),
  ));
}

function viewReady(root) {
  const st = S.settings;
  const last = S.lastSaved;
  root.append(h('div', { class: 'stack' },
    statusRow(),
    h('h1', {}, 'Ready'),
    h('p', { class: 'sub' }, 'Peak force. Pull as hard as you can on the edge, then rest.'),
    S.demo && h('div', { class: 'notice' }, 'Demo mode. The numbers come from a scripted pull, not a Progressor.'),
    field('Hand', seg(Object.entries(HAND).map(([value, o]) => ({ value, label: o.name, color: o.color })), st.hand, (v) => { updateSettings({ hand: v }); renderPull(); }, 'Hand')),
    h('div', { class: 'inline' },
      field('Edge (mm)', numberInput(st.edge, (v) => updateSettings({ edge: v ?? 20 }), { min: 1, max: 60, id: 'edge' })),
      field('Bodyweight (kg)', numberInput(st.bodyweight, (v) => updateSettings({ bodyweight: v }), { min: 20, max: 200, id: 'bw' })),
    ),
    !st.bodyweight && h('p', { class: 'muted' }, 'Add your bodyweight to see each pull as a percentage of it.'),
    h('button', { class: 'btn', id: 'start', onclick: startSession }, 'Start session'),
    h('button', { class: 'btn secondary', onclick: async () => { try { await S.device.tare(); toast('Zeroed. Make sure nothing was hanging on it.'); } catch (e) { toast(explain(e)); } } }, 'Zero the Progressor'),
    last && lastSavedCard(last),
  ));
}

function lastSavedCard(s) {
  const best = Math.max(...s.pulls.map((p) => p.peak));
  return h('button', { class: 'item', onclick: () => openSession(s.id) },
    h('span', { class: 'a' }, 'Last session'),
    h('span', { class: 'b' }, `${typeLabel(s.type)}, ${s.pulls.length} pulls`),
    h('span', { class: 'c' }, best.toFixed(1), h('small', {}, ' kg')),
  );
}

function viewRunning(root) {
  const hand = S.settings.hand;
  const hero = h('div', { class: 'force' }, '0.0');
  const unit = h('small', {}, 'kg');
  hero.append(unit);
  const peakV = h('b', {}, '–');
  const peakL = h('span', {}, 'Peak');
  const pctV = h('b', {}, '–');
  const state = h('div', { class: 'pullstate off' }, 'Start pulling when ready');
  const canvas = h('canvas', { class: 'chart-live', 'aria-label': 'Live force trace for the last 10 seconds', role: 'img' });
  const list = h('div', { class: 'pulls', id: 'pulls' });
  root.append(h('div', {},
    statusRow(),
    h('div', { class: 'live' },
      h('div', { class: 'readout' }, hero, h('div', { class: 'facts' }, peakV, peakL, pctV, h('span', {}, 'of bodyweight'))),
      canvas, state),
    h('div', { class: 'stack', style: 'margin-top:12px' },
      seg(Object.entries(HAND).map(([value, o]) => ({ value, label: o.name, color: o.color })), hand, (v) => {
        updateSettings({ hand: v });
        if (S.chart) { S.chart.color = HAND[v].color; S.chart.pb = bestFor(v); }
        renderHandSeg();
      }, 'Hand'),
      h('button', { class: 'btn', id: 'finish', onclick: finishSession }, 'Finish session'),
    ),
    list,
  ));
  S.chart = new LiveChart(canvas);
  S.chart.color = HAND[hand].color;
  S.chart.pb = bestFor(hand);
  S.ui = { hero, unit, peakV, peakL, pctV, state, list, canvas };
  renderPullList();
}

function renderHandSeg() {
  const old = $('#view-pull .seg');
  if (!old) return;
  const hand = S.settings.hand;
  old.replaceWith(seg(Object.entries(HAND).map(([value, o]) => ({ value, label: o.name, color: o.color })), hand, (v) => {
    updateSettings({ hand: v });
    if (S.chart) { S.chart.color = HAND[v].color; S.chart.pb = bestFor(v); }
    renderHandSeg();
  }, 'Hand'));
}

function renderPullList() {
  if (!S.ui || !S.session) return;
  const bw = S.session.bodyweight;
  S.ui.list.replaceChildren(...S.session.pulls.map((p, i) => i).reverse().map((i) => {
    const p = S.session.pulls[i];
    return h('div', { class: 'pull' },
      h('span', { class: 'n' }, `#${i + 1}`),
      h('span', { class: 'v' }, h('span', { class: 'hand', style: `background:var(${HAND[p.hand].color})`, title: HAND[p.hand].name }), p.peak.toFixed(1), h('small', {}, ' kg')),
      h('span', { class: 'meta' }, [pctBw(p.peak, bw), `${p.duration.toFixed(1)} s`].filter(Boolean).join('  ')),
      h('button', { class: 'x', 'aria-label': `Remove pull ${i + 1}`, onclick: () => { S.session.pulls.splice(i, 1); renderPullList(); } }, '×'),
    );
  }));
}

function tick() {
  const ui = S.ui;
  if (S.phase !== 'running' || !ui) return;
  const f = S.live.f;
  ui.hero.firstChild.nodeValue = (Math.abs(f) < 0.05 ? 0 : f).toFixed(1);
  const det = S.detector;
  const bw = S.session.bodyweight;
  if (det.pulling) {
    ui.peakL.textContent = 'Peak this pull';
    ui.peakV.textContent = det.peak.toFixed(1);
    ui.pctV.textContent = pctBw(det.peak, bw) ?? '–';
    ui.state.className = 'pullstate on';
    ui.state.textContent = `Pulling ${det.elapsed.toFixed(1)} s`;
  } else {
    const lp = S.live.lastPeak;
    ui.peakL.textContent = lp === null ? 'Peak' : 'Last pull';
    ui.peakV.textContent = lp === null ? '–' : lp.toFixed(1);
    ui.pctV.textContent = lp === null ? '–' : (pctBw(lp, bw) ?? '–');
    ui.state.className = 'pullstate off';
    ui.state.textContent = S.session.pulls.length ? 'Resting' : 'Start pulling when ready';
  }
  requestAnimationFrame(tick);
}

/* ---------- History tab ---------- */
function openSession(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  H.openId = id;
  H.selected = s.pulls.reduce((bi, p, i, a) => (p.peak > a[bi].peak ? i : bi), 0);
  showTab('history');
}

function renderHistory() {
  const root = $('#view-history');
  root.replaceChildren();
  if (H.openId) return renderDetail(root);
  root.append(h('h1', {}, 'History'));
  if (!S.sessions.length) {
    root.append(
      h('p', { class: 'sub' }, 'Your sessions will show up here with a trend for each hand.'),
      h('button', { class: 'btn', onclick: () => showTab('pull') }, 'Start a test'),
    );
    return;
  }
  const bwFallback = S.settings.bodyweight;
  root.append(
    h('p', { class: 'sub' }, `${S.sessions.length} ${S.sessions.length === 1 ? 'session' : 'sessions'} saved on this phone`),
    h('div', { class: 'stack' },
      seg([{ value: 'kg', label: 'Kilograms' }, { value: 'bw', label: '% bodyweight' }], H.metric, (v) => { H.metric = v; renderHistory(); }, 'Unit'),
    ),
  );
  const series = Object.entries(HAND)
    .map(([hand, o]) => ({ key: hand, label: o.name, color: o.color, points: trendPoints(S.sessions, TYPE, hand, H.metric, bwFallback) }))
    .filter((s) => s.points.length);
  if (!series.length) {
    root.append(h('p', { class: 'sub', style: 'margin-top:16px' }, H.metric === 'bw' && S.sessions.length ? 'No sessions with a bodyweight yet. Add yours in Settings.' : 'No sessions yet.'));
  } else {
    const unit = H.metric === 'kg' ? 'kg' : '% BW';
    const yFmt = (v) => (H.metric === 'kg' ? v.toFixed(v % 1 ? 1 : 0) : `${Math.round(v)}`);
    const box = h('div', { class: 'chartbox' },
      h('div', { class: 'title' }, 'Best pull per session', h('span', {}, `${unit}, tap a point for details`)),
      series.length > 1 && h('div', { class: 'legend', style: 'padding:0 8px;margin-top:8px' }, series.map((s) => h('span', {}, h('i', { style: `background:var(${s.color})` }), s.label))),
    );
    root.append(box);
    trendChart(box, {
      series, yFmt,
      tipHtml: (p, s) => `<b>${yFmt(p.y)} ${unit}</b><br>${s.label}, ${fmtDate(p.x)}${H.metric === 'kg' && p.bw ? `<br>${Math.round((p.raw / p.bw) * 100)}% of bodyweight` : ''}`,
      onOpen: openSession,
    });
    box.append(tableToggle(series, unit, yFmt));
    root.append(h('div', { class: 'statline' }, series.map((s) => statCard(s, unit, yFmt))));
  }
  root.append(h('h2', { style: 'margin-top:22px' }, 'All sessions'), h('div', { class: 'list' },
    [...S.sessions].reverse().map((s) => {
      const best = Math.max(...s.pulls.map((p) => p.peak));
      return h('button', { class: 'item', onclick: () => openSession(s.id) },
        h('span', { class: 'a' }, fmtDate(s.startedAt)),
        h('span', { class: 'b' }, `${typeLabel(s.type)}, ${s.pulls.length} pulls, ${s.edge} mm edge`),
        h('span', { class: 'c' }, best.toFixed(1), h('small', {}, ' kg')));
    })));
}

function tableToggle(series, unit, yFmt) {
  const rows = series.flatMap((s) => s.points.map((p) => ({ s, p }))).sort((a, b) => b.p.x - a.p.x);
  return h('details', { class: 'table-toggle' },
    h('summary', {}, 'Show as table'),
    h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Hand'), h('th', {}, unit))),
      h('tbody', {}, rows.map(({ s, p }) => h('tr', {}, h('td', {}, new Date(p.x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })), h('td', {}, s.label), h('td', {}, yFmt(p.y)))))));
}

function statCard(s, unit, yFmt) {
  const pts = s.points;
  const best = Math.max(...pts.map((p) => p.y));
  const latest = pts[pts.length - 1].y;
  const tr = weeklyTrend(pts);
  let trend = 'Needs 4+ sessions over 2+ weeks';
  if (tr) {
    const sign = tr.perWeek >= 0 ? '+' : '−';
    trend = `${sign}${Math.abs(tr.perWeek).toFixed(2)} ${unit} a week, give or take ${tr.ci95.toFixed(2)}`;
    if (Math.abs(tr.perWeek) <= tr.ci95) trend += '. Within the noise so far';
  }
  return h('div', { class: 'stat' },
    h('div', { class: 'who' }, h('i', { style: `background:var(${s.color})` }), s.label),
    h('dl', {},
      h('div', {}, h('dt', {}, 'Best'), h('dd', {}, yFmt(best), h('small', {}, ` ${unit}`))),
      h('div', {}, h('dt', {}, 'Latest'), h('dd', {}, yFmt(latest), h('small', {}, ` ${unit}`))),
      h('div', { class: 'wide' }, h('dt', {}, 'Trend over the last 8 weeks'), h('dd', {}, trend)),
    ));
}

function renderDetail(root) {
  const s = S.sessions.find((x) => x.id === H.openId);
  if (!s) { H.openId = null; return renderHistory(); }
  const sel = Math.min(H.selected, s.pulls.length - 1);
  const p = s.pulls[sel];
  const bw = s.bodyweight;
  root.append(
    h('button', { class: 'back', onclick: () => { H.openId = null; renderHistory(); } }, '‹ History'),
    h('h1', {}, fmtDate(s.startedAt)),
    h('p', { class: 'sub' }, `${typeLabel(s.type)}, ${s.edge} mm edge${bw ? `, ${bw} kg bodyweight` : ''}`),
  );
  const bars = h('div', { class: 'chartbox' }, h('div', { class: 'title' }, 'Peak per pull', h('span', {}, 'kg, tap a bar to see that pull')));
  root.append(bars);
  const trace = h('div', { class: 'chartbox' }, h('div', { class: 'title' }, `Pull ${sel + 1}, ${HAND[p.hand].name.toLowerCase()} hand`, h('span', {}, 'Force over time, touch the curve to read it')));
  const metrics = h('dl', { class: 'metrics' });
  const draw = () => {
    barChart(bars, {
      bars: s.pulls.map((q) => ({ value: q.peak, color: HAND[q.hand].color })),
      selected: sel, onSelect: (i) => { H.selected = i; renderHistory(); },
    });
    traceChart(trace, { t: p.t, f: p.f, onsetOffset: p.onsetOffset, color: HAND[p.hand].color, peak: p.peak, peakT: p.peakT });
  };
  root.append(trace);
  const rows = [
    ['Peak', `${p.peak.toFixed(1)} kg`],
    bw && ['Peak as bodyweight', `${Math.round((p.peak / bw) * 100)}%`],
    ['Best 1 second', `${p.best1s.toFixed(1)} kg`],
    ['Average', `${p.mean.toFixed(1)} kg`],
    ['Time under load', `${p.duration.toFixed(1)} s`],
    p.t90 !== null && ['Time to 90% of peak', `${p.t90.toFixed(2)} s`],
    p.rfd !== null && ['Rate of force development', `${p.rfd.toFixed(0)} kg/s`],
    ['Impulse', `${p.impulse.toFixed(0)} kg·s`],
  ].filter(Boolean);
  rows.forEach(([k, v]) => metrics.append(h('dt', {}, k), h('dd', {}, v)));
  root.append(metrics);
  draw();
  root.append(
    h('div', { class: 'field', style: 'margin-top:16px' }, h('label', {}, 'Notes'),
      h('textarea', { placeholder: 'Sleep, skin, how it felt', onchange: async (e) => { s.notes = e.target.value; await store.putSession(s); } }, s.notes || '')),
    h('div', { class: 'stack', style: 'margin-top:16px' },
      h('button', { class: 'btn secondary', onclick: () => saveFile(`edge-${new Date(s.startedAt).toISOString().slice(0, 10)}-raw.csv`, rawCsv(s), 'text/csv') }, 'Export raw force data (CSV)'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Delete this session? This cannot be undone.')) return;
        await store.deleteSession(s.id);
        S.sessions = S.sessions.filter((x) => x.id !== s.id);
        if (S.lastSaved?.id === s.id) S.lastSaved = null;
        H.openId = null;
        renderHistory();
      } }, 'Delete session'),
    ),
  );
}

/* ---------- Settings tab ---------- */
function renderSettings() {
  const root = $('#view-settings');
  root.replaceChildren();
  const st = S.settings;
  root.append(
    h('h1', {}, 'Settings'),
    h('p', { class: 'sub' }, 'Everything stays on this phone.'),
    h('div', { class: 'stack' },
      field('Bodyweight (kg)', numberInput(st.bodyweight, (v) => updateSettings({ bodyweight: v }), { min: 20, max: 200, id: 'bw-set' }), 'Used for % of bodyweight. Each session keeps the bodyweight you had when you tested.'),
      field('Pull detection (kg)', numberInput(st.threshold, (v) => updateSettings({ threshold: v ?? 5 }), { min: 1, max: 50, id: 'thr' }), 'A pull starts when force stays above this for a moment, and ends when it drops well below it.'),
      field('Default edge (mm)', numberInput(st.edge, (v) => updateSettings({ edge: v ?? 20 }), { min: 1, max: 60, id: 'edge-set' })),
    ),
    h('h2', { style: 'margin-top:26px' }, 'Progressor'),
    S.device
      ? h('div', { class: 'card stack' },
          h('div', { class: 'row' }, h('span', {}, S.info.name), h('span', { class: 'muted' }, S.info.fw ? `Firmware ${S.info.fw}` : '')),
          S.info.mv && h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Battery'), h('span', {}, `${(S.info.mv / 1000).toFixed(2)} V`)),
          h('div', { class: 'row' },
            h('button', { class: 'btn secondary small', disabled: S.phase === 'running', onclick: disconnect }, 'Disconnect'),
            h('button', { class: 'btn secondary small', disabled: S.phase === 'running', onclick: async () => { try { await S.device.sleep(); toast('The Progressor is switching off.'); } catch (e) { toast(explain(e)); } } }, 'Switch it off')))
      : h('p', { class: 'muted' }, 'Not connected. Connect from the Pull tab.'),
    h('h2', { style: 'margin-top:26px' }, 'Your data'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn secondary', onclick: () => saveFile('edge-backup.json', store.exportJson(S.sessions), 'application/json') }, 'Back up everything (JSON)'),
      h('button', { class: 'btn secondary', onclick: () => saveFile('edge-pulls.csv', pullsCsv(S.sessions), 'text/csv') }, 'Export pull summaries (CSV)'),
      h('label', { class: 'btn secondary', style: 'display:flex;align-items:center;justify-content:center;cursor:pointer' }, 'Restore from a backup',
        h('input', { type: 'file', accept: 'application/json,.json', hidden: true, id: 'import', onchange: importBackup })),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Delete every saved session on this phone? This cannot be undone.')) return;
        await store.clearSessions();
        S.sessions = [];
        S.lastSaved = null;
        toast('All sessions deleted.');
      } }, 'Delete all sessions'),
    ),
    h('h2', { style: 'margin-top:26px' }, 'Connection log'),
    h('pre', { class: 'log', id: 'log' }, LOG.length ? LOG.join('\n') : 'Nothing yet. Connect a Progressor and this fills in.'),
    h('button', { class: 'btn secondary small', style: 'margin-top:10px', onclick: async () => { try { await navigator.clipboard.writeText(LOG.join('\n')); toast('Log copied.'); } catch { toast('Could not copy. Select the text instead.'); } } }, 'Copy log'),
    !store.persistent && h('div', { class: 'notice bad', style: 'margin-top:16px' }, 'This browser is not letting Edge save data, so sessions will be lost when you close it. Export a backup after each session.'),
    h('p', { class: 'muted', style: 'margin-top:24px;font-size:13px' }, 'Edge reads the Progressor over Bluetooth using the public interface Tindeq publishes. It is not made by or affiliated with Tindeq.'),
  );
}

async function importBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const incoming = store.parseImport(await file.text());
    const have = new Set(S.sessions.map((s) => s.id));
    let added = 0;
    for (const s of incoming) {
      if (have.has(s.id)) continue;
      await store.putSession(s);
      S.sessions.push(s);
      added++;
    }
    S.sessions.sort((a, b) => a.startedAt - b.startedAt);
    toast(`Added ${added} ${added === 1 ? 'session' : 'sessions'}. ${incoming.length - added} already here.`);
  } catch (err) {
    toast(`Could not read that file. ${err.message}`, 6000);
  }
  e.target.value = '';
}

/* ---------- tabs and boot ---------- */
function showTab(tab) {
  S.tab = tab;
  for (const t of ['pull', 'history', 'settings']) {
    $(`#view-${t}`).hidden = t !== tab;
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === tab));
  }
  if (tab === 'history') renderHistory();
  if (tab === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

async function boot() {
  for (const t of ['pull', 'history', 'settings']) $(`#tab-${t}`).addEventListener('click', () => showTab(t));
  S.sessions = await store.allSessions();
  renderPull();
  showTab('pull');
  // Only redraw charts when the width changes (rotation). Phones fire resize events as the browser
  // toolbar collapses while scrolling, and redrawing then would wipe an open tooltip.
  let rz;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      if (S.tab === 'history') renderHistory();
    }, 150);
  });
  if (params.has('autodemo')) connect({ demo: true });
  if (params.has('debug')) {
    window.__edge = {
      S, H, LOG,
      seed: async () => {
        for (const s of seedSessions()) await store.putSession(s);
        S.sessions = await store.allSessions();
        if (S.tab === 'history') renderHistory();
      },
      showTab,
    };
  }
}
boot();
