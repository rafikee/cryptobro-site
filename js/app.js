/* cryptoBro status page.
 *
 * No framework, no build step, no dependencies. The whole thing is: fetch one JSON
 * document, draw it, wire up five interactions.
 *
 * The data comes from the `data` branch of this same repo, which a launchd job on
 * the Mac mini force-pushes after every wake. That means the site's Docker image
 * carries no data and never needs rebuilding when the numbers change — the bundled
 * copy in data/ is only a fallback for when GitHub is unreachable, and for local
 * development.
 *
 * Query params, all for development and screenshots:
 *   ?state=waiting|holding|sweating   force a pose
 *   ?reveal=all                       show every section at once, no animation
 *   ?data=<url>                       load a fixture instead of the live payload
 *   ?hide=hold|bot                    start with a series switched off
 *   ?debug=width                      name whatever is wider than the window
 */

const REMOTE = 'https://raw.githubusercontent.com/rafikee/cryptobro-site/data/data.json';
const LOCAL = 'data/data.json';
const STALE_MS = 8 * 3600 * 1000;   /* comfortably more than the 4h wake cadence */

const params = new URLSearchParams(location.search);
const $ = sel => document.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const fmtMoney = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n * 100).toFixed(2) + '%';
const fmtSigned = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtMoney(Math.abs(n)).replace('-', '');
const sign = n => n > 0.00001 ? 'up' : n < -0.00001 ? 'down' : 'flat';

const stampFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'UTC'
});
const fmtTime = ts => stampFmt.format(new Date(ts)) + ' UTC';

let DATA = null;
let NOW = Date.now();

/* ── load ─────────────────────────────────────────────────────────────────── */

async function load() {
  const override = params.get('data');
  const sources = override ? [override] : [REMOTE, LOCAL];
  for (const url of sources) {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.ok) return await r.json();
    } catch { /* try the next one */ }
  }
  return null;
}

/* ── the top of the page ──────────────────────────────────────────────────── */

function renderNotice() {
  const box = $('#notice');
  const stale = NOW - DATA.generated_at > STALE_MS;
  if (DATA.halted) {
    box.dataset.kind = 'halt';
    box.textContent = 'Halted by hand. Every decision is being rejected on purpose.';
  } else if (stale) {
    box.dataset.kind = 'stale';
    box.textContent = `Stale. Last update ${Character.relative(DATA.generated_at, NOW)}, and the bot may well be fine. The thing that feeds this page is not.`;
  } else {
    return;
  }
  box.hidden = false;
}

function renderHero() {
  const n = DATA.now;
  const start = DATA.start_capital;
  const last = DATA.curve[DATA.curve.length - 1];

  $('#bot-img').src = `img/${Character.poseFor(params.get('state') || n.state)}.webp`;
  $('#bot-img').alt = `The bot, ${params.get('state') || n.state}`;

  countTo($('#equity'), n.equity);

  const vsStart = n.equity / start - 1;
  const dStart = $('#d-start');
  dStart.textContent = `${fmtPct(vsStart)}  ${fmtSigned(n.equity - start)}`;
  dStart.className = sign(vsStart);

  const dHold = $('#d-hold');
  if (last) {
    const gap = n.equity / last.bh - 1;
    dHold.textContent = `${fmtPct(gap)}  ${fmtSigned(n.equity - last.bh)}`;
    dHold.className = sign(gap);
  } else {
    dHold.textContent = 'not enough history yet';
    dHold.className = 'flat';
  }

  const book = $('#book');
  book.textContent = '';
  if (n.units > 0) {
    book.append(
      text(`holding ${n.units.toFixed(6)} ETH bought around `), bold(fmtMoney(n.avg_entry)),
      text(', stop at '), bold(fmtMoney(n.stop)),
      text(`. That is ${Math.round(n.exposure * 100)}% of the money in the market, with ${fmtMoney(n.cash)} still in cash.`)
    );
  } else {
    book.append(text('Flat. '), bold(fmtMoney(n.cash)), text(' in cash and nothing at risk.'));
  }
}

const text = s => document.createTextNode(s);
const bold = s => { const b = el('b'); b.textContent = s; return b; };

/* Numbers roll up when they first appear. Skipped entirely for anyone who asked
   for less motion, and for the screenshot mode. */
function countTo(node, value) {
  if (noMotion()) { node.textContent = fmtMoney(value); return; }
  const from = 0, dur = 900, t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = fmtMoney(from + (value - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function noMotion() {
  return params.get('reveal') === 'all' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ── the chart ────────────────────────────────────────────────────────────── */

const SVG = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs) => {
  const n = document.createElementNS(SVG, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const shown = { bot: true, hold: true };
if (params.get('hide') in shown) shown[params.get('hide')] = false;
let geom = null;

function renderChart() {
  const svg = $('#chart');
  const curve = DATA.curve;
  const title = svg.querySelector('title');
  svg.textContent = '';
  svg.append(title);

  const note = $('#chart-note');
  if (curve.length < 2) {
    note.textContent = 'One bar of history so far. This turns into a line as the days go by.';
    return;
  }

  const box = svg.getBoundingClientRect();
  const W = Math.max(320, box.width), H = Math.max(180, box.height);
  const pad = { t: 16, r: 74, b: 22, l: 8 };

  /* The scale follows what is actually on screen, so hiding the benchmark is a
     real zoom rather than a cosmetic one. With both lines up, a benchmark that ran
     away flattens the bot's line into the floor — turning it off is how you get to
     look at the bot's own shape. */
  const vals = [DATA.start_capital];
  curve.forEach(p => {
    if (shown.bot) vals.push(p.eq);
    if (shown.hold) vals.push(p.bh);
  });
  let lo = Math.min(...vals), hi = Math.max(...vals);
  /* A dead-flat series has zero range, which would divide by zero and, worse,
     draw a line through the middle implying precision that is not there. */
  if (hi - lo < 0.5) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
  const span = (hi - lo) * 1.12, mid = (hi + lo) / 2;
  lo = mid - span / 2; hi = mid + span / 2;

  const t0 = curve[0].ts, t1 = curve[curve.length - 1].ts;
  const x = ts => pad.l + (t1 === t0 ? 0.5 : (ts - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  geom = { x, y, W, H, pad, curve };

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const defs = mk('defs');
  const grad = mk('linearGradient', { id: 'botfade', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(mk('stop', { offset: '0%', 'stop-color': '#C8811A', 'stop-opacity': '.20' }),
              mk('stop', { offset: '100%', 'stop-color': '#C8811A', 'stop-opacity': '0' }));
  defs.append(grad);
  svg.append(defs);

  /* Recessive chrome first. Ticks land on round money rather than on fractions of
     the range, so the labels read as amounts instead of as chart internals. */
  const base = DATA.start_capital;
  const endY = [y(curve[curve.length - 1].eq), y(curve[curve.length - 1].bh), y(base)];
  for (const v of niceTicks(lo, hi, 4)) {
    svg.append(mk('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    /* Skip the label, not the line, when it would sit on top of an end label or
       the baseline's. Two numbers stacked on each other is worse than none. */
    if (endY.every(e => Math.abs(e - y(v)) > 13)) {
      svg.append(label(W - pad.r + 6, y(v) + 3.5, fmtMoney(v).replace('.00', '')));
    }
  }
  svg.append(mk('line', { class: 'base', x1: pad.l, x2: W - pad.r, y1: y(base), y2: y(base) }));
  /* Same collision rule as the ticks. On a narrow screen the starting stake often
     sits within a few pixels of where a line finishes, and the dotted rule plus the
     caption already say what it is. */
  if (endY.slice(0, 2).every(e => Math.abs(e - y(base)) > 13)) {
    svg.append(label(W - pad.r + 6, y(base) + 3.5, 'start'));
  }

  /* The span, at the two ends. A time series with no dates on it is a shape. */
  const spanLabel = (ts, anchor, atX) => {
    const t = label(atX, H - 4, dayLabel(ts));
    t.setAttribute('text-anchor', anchor);
    return t;
  };
  svg.append(spanLabel(t0, 'start', pad.l));
  if (t1 !== t0) svg.append(spanLabel(t1, 'end', W - pad.r));

  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const botPts = curve.map(p => ({ ts: p.ts, v: p.eq }));
  const holdPts = curve.map(p => ({ ts: p.ts, v: p.bh }));

  const area = mk('path', {
    class: 'area',
    d: `${path(botPts)}L${x(t1).toFixed(1)},${y(lo).toFixed(1)}L${x(t0).toFixed(1)},${y(lo).toFixed(1)}Z`
  });
  area.dataset.series = 'bot';
  svg.append(area);

  for (const [key, pts] of [['hold', holdPts], ['bot', botPts]]) {
    const p = mk('path', { class: `line ${key} draw`, d: path(pts) });
    p.dataset.series = key;
    svg.append(p);
    /* Only the path knows its own length, so the dash animation is set here. */
    p.style.setProperty('--len', p.getTotalLength());
  }

  /* Direct labels at the line ends, so identity never rests on colour alone.
     Nudged apart when the two series finish within a few pixels of each other. */
  let yBot = y(curve[curve.length - 1].eq), yHold = y(curve[curve.length - 1].bh);
  if (Math.abs(yBot - yHold) < 13) {
    const push = (13 - Math.abs(yBot - yHold)) / 2 + 1;
    if (yBot <= yHold) { yBot -= push; yHold += push; } else { yBot += push; yHold -= push; }
  }
  svg.append(endLabel('bot', W - pad.r + 6, yBot, fmtMoney(curve[curve.length - 1].eq)));
  svg.append(endLabel('hold', W - pad.r + 6, yHold, fmtMoney(curve[curve.length - 1].bh)));

  /* Wakes that actually moved money get a mark you can click through to the log. */
  const acted = new Map();
  for (const d of DATA.decisions) if (d.fills && d.fills.length) {
    const at = nearest(curve, d.fills[0].ts);
    if (at) acted.set(at.ts, d);
  }
  if (shown.bot) for (const [ts, d] of acted) {
    const c = mk('circle', { class: 'act', cx: x(ts), cy: y(curve.find(p => p.ts === ts).eq), r: 2.5 });
    c.dataset.decision = d.id;
    const label = mk('title');
    label.textContent = `${d.action}: click for the reasoning`;
    c.append(label);
    svg.append(c);
  }

  const hair = mk('line', { class: 'hair off', y1: pad.t, y2: H - pad.b });
  const dotBot = mk('circle', { class: 'dot bot off', r: 4.5 });
  const dotHold = mk('circle', { class: 'dot hold off', r: 4.5 });
  svg.append(hair, dotBot, dotHold);
  svg.append(mk('rect', {
    class: 'hit', x: pad.l, y: 0, width: W - pad.l - pad.r + 40, height: H
  }));

  wireHover(svg, { hair, dotBot, dotHold, acted });
  applySeriesVisibility();

  note.textContent = `Both lines start at ${fmtMoney(DATA.start_capital)} the moment the bot first woke up. `
    + 'The blue one is what that same money would have done sitting in ETH, doing nothing at all. '
    + 'Switch it off above to see the bot on its own scale.';
}

/* Round-ish tick values inside [lo, hi]: a 1/2/5 × power-of-ten step, the standard
   trick, so ticks read $1,002 rather than $1,001.87. */
function niceTicks(lo, hi, want) {
  const raw = (hi - lo) / Math.max(1, want);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(+v.toFixed(6));
  return out;
}

const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = ts => dayFmt.format(new Date(ts));

function label(x, y, s) {
  const t = mk('text', { class: 'axis', x, y });
  t.textContent = s;
  return t;
}
function endLabel(cls, x, y, s) {
  const t = mk('text', { class: `endlabel ${cls}`, x, y: y + 3.5 });
  t.dataset.series = cls;
  t.textContent = s;
  return t;
}
function nearest(curve, ts) {
  let best = null, gap = Infinity;
  for (const p of curve) { const g = Math.abs(p.ts - ts); if (g < gap) { gap = g; best = p; } }
  return best;
}

function wireHover(svg, parts) {
  const tip = $('#tip');
  const wrap = $('.chartwrap');

  const at = clientX => {
    const box = svg.getBoundingClientRect();
    const px = (clientX - box.left) / box.width * geom.W;
    let best = geom.curve[0], gap = Infinity;
    for (const p of geom.curve) { const g = Math.abs(geom.x(p.ts) - px); if (g < gap) { gap = g; best = p; } }
    return best;
  };

  const show = p => {
    const cx = geom.x(p.ts);
    parts.hair.setAttribute('x1', cx); parts.hair.setAttribute('x2', cx);
    parts.dotBot.setAttribute('cx', cx); parts.dotBot.setAttribute('cy', geom.y(p.eq));
    parts.dotHold.setAttribute('cx', cx); parts.dotHold.setAttribute('cy', geom.y(p.bh));
    parts.hair.classList.remove('off');
    parts.dotBot.classList.toggle('off', !shown.bot);
    parts.dotHold.classList.toggle('off', !shown.hold);

    tip.textContent = '';
    const when = el('div', 'when');
    when.textContent = fmtTime(p.ts);
    tip.append(when);
    /* One tooltip lists every series, so the pointer never has to find a line.
       Values lead, series names follow, and labels go in as text nodes. */
    if (shown.bot) tip.append(tipRow('#C8811A', fmtMoney(p.eq), 'the bot'));
    if (shown.hold) tip.append(tipRow('#5A87C4', fmtMoney(p.bh), 'holding ETH'));
    tip.hidden = false;
    const box = svg.getBoundingClientRect();
    tip.style.left = Math.min(box.width - 20, Math.max(20, cx / geom.W * box.width)) + 'px';
    tip.style.top = geom.y(Math.max(p.eq, p.bh)) / geom.H * box.height + 'px';
  };

  const hide = () => {
    tip.hidden = true;
    parts.hair.classList.add('off');
    parts.dotBot.classList.add('off');
    parts.dotHold.classList.add('off');
  };

  svg.addEventListener('pointermove', e => show(at(e.clientX)));
  svg.addEventListener('pointerleave', hide);
  wrap.addEventListener('pointerleave', hide);

  svg.addEventListener('click', e => {
    const dot = e.target.closest('.act');
    const p = dot ? geom.curve.find(c => geom.x(c.ts) === +dot.getAttribute('cx')) : at(e.clientX);
    const d = p && parts.acted.get(p.ts);
    if (d) jumpToDecision(d.id);
  });
}

function tipRow(colour, value, name) {
  const row = el('div', 'row');
  const swatch = el('i');
  swatch.style.background = colour;
  const v = el('b'); v.textContent = value;
  const s = el('span'); s.textContent = name;
  row.append(swatch, v, s);
  return row;
}

function applySeriesVisibility() {
  document.querySelectorAll('#chart [data-series]').forEach(node => {
    node.classList.toggle('off', !shown[node.dataset.series]);
  });
  document.querySelectorAll('.key').forEach(k => k.classList.toggle('on', shown[k.dataset.series]));
}

/* ── round trips ──────────────────────────────────────────────────────────── */

function renderTrades() {
  const box = $('#trades');
  box.textContent = '';
  if (!DATA.trades.length) {
    const p = el('p', 'empty');
    p.textContent = 'Nothing has been sold yet, so there is nothing to score. '
      + 'The first closed trade shows up here with what it made or lost after fees.';
    box.append(p);
    return;
  }
  /* The headline before the rows. Over a year the table becomes unreadable and
     this line is the only part most people want. Counts and sums only — whether a
     trade was a *good idea* is not this page's call to make. */
  const net = DATA.trades.reduce((a, t) => a + t.pnl, 0);
  const won = DATA.trades.filter(t => t.pnl > 0).length;
  const stopped = DATA.trades.filter(t => t.reason === 'stop').length;
  const sum = el('p', 'summary');
  sum.append(
    bold(Character.plural(DATA.trades.length, 'round trip')), text(', '),
    signed(net), text(' after fees. '),
    text(`${won} made money, ${DATA.trades.length - won} did not`),
    text(stopped ? `, and ${stopped} ended on the stop rather than on a decision.` : '.')
  );
  box.append(sum);

  const CAP = 15;
  const rows = [...DATA.trades].reverse();
  const table = el('table');
  const head = el('tr');
  for (const h of ['closed', 'in', 'out', 'units', 'p&l', 'why']) {
    const th = el('th'); th.textContent = h; head.append(th);
  }
  table.append(head);
  for (const t of rows.slice(0, CAP)) {
    const tr = el('tr');
    const cells = [fmtTime(t.exit_ts), fmtMoney(t.entry_price), fmtMoney(t.exit_price),
                   t.units.toFixed(6), fmtSigned(t.pnl), t.reason];
    cells.forEach((c, i) => {
      const td = el('td');
      td.textContent = c;
      if (i === 4) td.className = sign(t.pnl);
      tr.append(td);
    });
    table.append(tr);
  }
  /* The table has six monospace columns and cannot shrink below its content. On a
     phone that made it the widest thing on the page, which dragged the whole
     document wider than the viewport and clipped every other section. It scrolls
     inside its own box instead. */
  const scroller = el('div', 'scrollx');
  scroller.append(table);
  box.append(scroller);
  if (rows.length > CAP) {
    const more = el('p', 'empty');
    more.textContent = `${rows.length - CAP} older round trips are in the data but not in this table.`;
    box.append(more);
  }
}

/* A signed money amount that carries its sign as a character, so the colour is
   never the only thing telling you which way it went. */
function signed(n) {
  const b = el('b', sign(n));
  b.textContent = fmtSigned(n);
  return b;
}

/* ── wake strip ───────────────────────────────────────────────────────────── */

function renderStrip() {
  const strip = $('#strip');
  const note = $('#strip-note');
  strip.textContent = '';
  const traded = new Set(DATA.decisions.filter(d => d.fills && d.fills.length).map(d => d.id));

  /* Two weeks of wakes. The strip answers "is it alive, and how often does it
     actually do something" — three months of marks answers that no better and
     turns into a 500-tile wall. */
  const STRIP_CAP = 84;
  const recent = DATA.wakes.slice(-STRIP_CAP);

  for (const w of recent) {
    const b = el('button', 'mark');
    b.dataset.outcome = w.outcome || 'gated';
    if (w.decision_id && traded.has(w.decision_id)) b.dataset.traded = '1';
    b.setAttribute('aria-label', `${fmtTime(w.ts)}: ${w.outcome}`);
    b.addEventListener('click', () => {
      strip.querySelectorAll('.mark').forEach(m => m.removeAttribute('aria-current'));
      b.setAttribute('aria-current', 'true');
      note.textContent = '';
      note.append(bold(fmtTime(w.ts)), text(': '),
                  text(w.gate_reason || `${w.outcome}, no reason recorded.`));
      if (w.decision_id) {
        note.append(text(' '));
        const a = el('button', 'linkish');
        a.textContent = 'see what it decided →';
        a.addEventListener('click', () => jumpToDecision(w.decision_id));
        note.append(a);
      }
    });
    strip.append(b);
  }

  const passed = recent.filter(w => w.gate_passed).length;
  const n = recent.length;
  const scope = DATA.wakes.length > n
    ? `the last ${n} wakes, out of ${DATA.wakes.length} all told`
    : `${Character.plural(n, 'wake')} so far`;
  note.textContent = `${scope}. `
    + `${passed === 1 ? 'One was' : passed + ' were'} interesting enough to think about; `
    + `${n - passed === 1 ? 'the other it skipped' : 'the rest it skipped'}.`;
}

/* ── decision log ─────────────────────────────────────────────────────────── */

function renderLog() {
  const log = $('#log');
  log.textContent = '';
  if (!DATA.decisions.length) {
    const li = el('li');
    const p = el('p', 'empty');
    p.textContent = 'It has not made a call yet.';
    li.append(p);
    log.append(li);
    return;
  }

  const all = [...DATA.decisions].reverse();
  const PAGE = 30;
  let drawn = 0;

  const draw = n => {
    for (const d of all.slice(drawn, drawn + n)) log.append(entryFor(d));
    drawn += n;
    if (drawn >= all.length) { if (moreBtn.parentNode) moreBtn.remove(); }
    else moreBtn.textContent = `show ${Math.min(PAGE, all.length - drawn)} more of ${all.length - drawn} older`;
  };

  drawRest = () => { if (drawn < all.length) draw(all.length - drawn); };

  const moreBtn = el('button', 'showmore');
  moreBtn.addEventListener('click', () => { draw(PAGE); if (moreBtn.parentNode) log.after(moreBtn); });

  draw(PAGE);
  if (drawn < all.length) log.after(moreBtn);
}

function entryFor(d) {
  {
    const li = el('li');
    const box = el('details', 'entry');
    box.id = `d-${d.id}`;
    box.dataset.action = d.action;
    if (d.rejected) box.dataset.rejected = '1';

    const sum = el('summary');
    const when = el('span', 'when'); when.textContent = fmtTime(d.ts);
    const what = el('span', 'what');
    what.textContent = d.action === 'hold' ? 'held' :
      `${d.action} ${d.size_frac ? Math.round(d.size_frac * 100) + '%' : ''}`.trim();
    const said = el('span', 'said');
    said.textContent = d.expectation || d.reasoning || 'no note recorded';
    const more = el('span', 'more');
    sum.append(when, what, said, more);
    box.append(sum);

    const body = el('div', 'body');
    if (d.rejected) {
      const p = el('p', 'claim rejected');
      p.textContent = `Blocked by the risk checks: ${d.reject_reason}`;
      body.append(p);
    }
    if (d.expectation) {
      const claim = el('p', 'claim');
      const lab = el('span', 'lab'); lab.textContent = 'what it expected';
      claim.append(lab, text(d.expectation));
      if (d.expect_by_ts) {
        const by = el('span', 'by');
        by.textContent = `by ${fmtTime(d.expect_by_ts)}`;
        claim.append(by);
      }
      body.append(claim);
    }
    if (d.reasoning) {
      const why = el('p', 'why');
      why.textContent = d.reasoning;
      body.append(why);
    }
    if (d.fills && d.fills.length) {
      const f = el('p', 'filled');
      f.textContent = d.fills.map(x =>
        `${x.side} ${x.units.toFixed(6)} ETH at ${fmtMoney(x.price)}, ${fmtMoney(x.fee)} fee`).join(' · ');
      body.append(f);
    }
    box.append(body);
    li.append(box);
    return li;
  }
}

let drawRest = () => {};

function jumpToDecision(id) {
  let box = document.getElementById(`d-${id}`);
  if (!box) { drawRest(); box = document.getElementById(`d-${id}`); }
  if (!box) return;
  box.open = true;
  document.querySelectorAll('.entry.lit').forEach(e => e.classList.remove('lit'));
  box.classList.add('lit');
  box.scrollIntoView({ behavior: noMotion() ? 'auto' : 'smooth', block: 'center' });
}

/* ── reveal on scroll ─────────────────────────────────────────────────────── */

function wireReveal() {
  const all = document.querySelectorAll('.reveal');
  if (params.get('reveal') === 'all') {
    document.body.dataset.reveal = 'all';
    all.forEach(s => s.classList.add('revealed'));
    return;
  }
  if (!('IntersectionObserver' in window)) {
    all.forEach(s => s.classList.add('revealed'));
    return;
  }
  const io = new IntersectionObserver((entries, obs) => {
    for (const e of entries) if (e.isIntersecting) {
      e.target.classList.add('revealed');
      obs.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.06 });
  all.forEach(s => io.observe(s));
}

/* ── the explainer ────────────────────────────────────────────────────────── */

/* "what is this?" near the top jumps to the explainer at the very bottom. It is a
   real <a href="#about">, so it works with JS off; this only adds the smooth ride
   and the highlight on arrival.
   The force-reveal matters: the target starts at opacity 0 until scrolled to, so
   without it you glide down to what looks like an empty panel and the observer
   only catches up once you have stopped. */
function wireJumps() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.getElementById(a.getAttribute('href').slice(1));
      if (!target) return;
      e.preventDefault();
      target.classList.add('revealed');
      target.scrollIntoView({ behavior: noMotion() ? 'auto' : 'smooth', block: 'start' });
      if (!target.classList.contains('about')) return;
      target.classList.add('lit');
      setTimeout(() => target.classList.remove('lit'), 2200);
    });
  });

  /* A shared #about link needs re-aiming. The browser does its native anchor jump
     while parsing, before any of this page exists — the log, the chart and the
     trades are all built by JS — so it scrolls to where the section sat on an
     empty document and then everything renders underneath it, leaving the reader
     somewhere in the middle of the page. Reveal it and scroll again, now that the
     section is actually where it will stay. */
  if (location.hash) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) {
      target.classList.add('revealed');
      requestAnimationFrame(() => target.scrollIntoView({ behavior: 'auto', block: 'start' }));
    }
  }
}

/* ── the robot's mouth ────────────────────────────────────────────────────── */

function wireCharacter() {
  const bubble = $('#bubble');
  const said = Character.lines(DATA, NOW);
  let i = 0;

  const say = () => {
    bubble.textContent = said[i % said.length];
    bubble.classList.add('show');
    i++;
  };

  $('#bot').addEventListener('click', say);
  /* It opens with something to say rather than waiting to be discovered. */
  setTimeout(say, noMotion() ? 0 : 700);
}

/* ── boot ─────────────────────────────────────────────────────────────────── */

(async function () {
  DATA = await load();
  if (!DATA) {
    $('#equity').textContent = 'no data';
    $('#bubble').textContent = 'I cannot reach my own numbers. Try again in a bit.';
    $('#bubble').classList.add('show');
    return;
  }
  NOW = Date.now();

  renderNotice();
  renderHero();
  renderTrades();
  renderStrip();
  renderLog();
  renderChart();
  wireReveal();
  wireJumps();
  wireCharacter();

  document.querySelectorAll('.key').forEach(k => k.addEventListener('click', () => {
    const other = k.dataset.series === 'bot' ? 'hold' : 'bot';
    if (shown[k.dataset.series] && !shown[other]) return;   /* never hide both */
    shown[k.dataset.series] = !shown[k.dataset.series];
    renderChart();
  }));

  const stamp = $('#stamp');
  stamp.textContent = `updated ${fmtTime(DATA.generated_at)} · ${Character.relative(DATA.generated_at, NOW)}`;

  let t;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(renderChart, 200); });

  if (params.get('debug') === 'width') reportOverflow();
})();

/* Names every element sticking out past the right edge, into the title, so a
   headless `--dump-dom` can be grepped for it. One element overflowing makes the
   document wider than the window and clips *everything*, which looks like a dozen
   separate layout bugs until you find the one. */
function reportOverflow() {
  const w = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('body *').forEach(n => {
    const r = n.getBoundingClientRect();
    if (r.width && r.right > w + 1) {
      bad.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}` +
               `${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : ''}` +
               `@${Math.round(r.right)}`);
    }
  });
  /* Widest first. In DOM order the list is dominated by the *victims* — every
     block after the culprit inherits the stretched width — and the truncation
     hides the one element that caused it. */
  bad.sort((a, b) => +b.split('@')[1] - +a.split('@')[1]);

  /* The list above is nearly all victims. This one is the source: elements whose
     own content is wider than the box they sit in. */
  const src = [];
  document.querySelectorAll('body *').forEach(n => {
    const over = n.scrollWidth - n.clientWidth;
    if (over > 1 && getComputedStyle(n).overflowX === 'visible') {
      src.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}` +
               `${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/)[0] : ''}` +
               `+${over}`);
    }
  });
  src.sort((a, b) => +b.split('+').pop() - +a.split('+').pop());

  /* Where the reader actually ended up, which is the other thing a headless run
     cannot show you. `top` near 0 means an anchor jump landed correctly; an
     `opacity` of 0 on a revealed section is a virtual-time artifact, not a bug. */
  const hashed = location.hash && document.getElementById(location.hash.slice(1));
  const r = hashed ? hashed.getBoundingClientRect() : null;
  document.title = `SCROLL y=${Math.round(scrollY)} pageH=${document.body.scrollHeight}` +
    (r ? ` ${location.hash} top=${Math.round(r.top)} opacity=${getComputedStyle(hashed).opacity}` : '') +
    ` :: OVERFLOW win=${w} doc=${document.documentElement.scrollWidth}` +
    ` :: SOURCE ${src.slice(0, 8).join(' ') || 'none'}` +
    ` :: WIDE ${bad.slice(0, 4).join(' ') || 'none'}`;
}
