/* The robot's face and its mouth.
 *
 * This is the file to edit when the page gets redesigned. Everything about how the
 * bot *presents* lives here; app.js only asks it questions. Adding a fourth pose
 * means adding a file to img/ and a branch to poseFor(), nothing else.
 *
 * The pose itself is decided in Python (see `publish.character_state`) and arrives
 * as `now.state`, so the site and any other reader of data.json always agree. This
 * file only maps that string to a file, and picks something for it to say.
 *
 * Voice: deadpan. It has a flat-line mouth and no stake in any of this.
 */

const POSES = ['waiting', 'holding', 'sweating'];

function poseFor(state) {
  return POSES.includes(state) ? state : 'waiting';
}

/* A deliberate mirror of `publish.character_state` in Python.
 *
 * The payload already carries `now.state`, and that stays authoritative for anyone
 * without JS. But the page re-marks the book against a live ETH price every minute,
 * and a robot still grinning while the number underneath it has gone red would be
 * worse than the duplication. Keep the two in step: flat wins over everything, and
 * the comparison is against the starting stake, not against unrealised P&L.
 */
function stateFor(units, equity, startCapital) {
  if (units <= 1e-12) return 'waiting';
  return equity >= startCapital ? 'holding' : 'sweating';
}

const money = n => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DAY = 86400000;

/* Candidate lines, most specific first. Each one is only offered if `when` holds,
 * so nothing ever claims something the data does not support. Clicking cycles
 * through whatever survived, which is the whole reason there is more than one. */
const LINES = [
  {
    when: d => d.halted,
    say: () => 'A human pulled the switch. I am standing here doing nothing, on purpose.'
  },
  {
    when: d => d.stale,
    say: d => `Nobody has fed me since ${d.agoWords}. Either the market broke or my publisher did.`
  },
  {
    when: d => d.open && d.expectBy > d.now,
    say: d => `I said this would work out by ${d.expectByWords}. ${d.daysLeft} to find out.`
  },
  {
    when: d => d.open && d.expectBy && d.expectBy <= d.now,
    say: () => 'My deadline came and went. Nobody has graded me yet. I am not complaining.'
  },
  {
    when: d => d.state === 'sweating' && d.stopDistance !== null,
    say: d => `Down ${money(d.pnl)}. ${money(d.stopDistance)} of room before the stop takes it away from me.`
  },
  {
    when: d => d.state === 'sweating',
    say: d => `Down ${money(d.pnl)}. It is ${d.days} days in. This is well within the range of normal.`
  },
  {
    when: d => d.state === 'holding' && d.beatingHold,
    say: d => `Up ${money(d.pnl)}, and ahead of just holding. I want that noted somewhere.`
  },
  {
    when: d => d.state === 'holding',
    say: d => `Up ${money(d.pnl)}. Holding ETH and doing nothing would have made ${money(d.holdPnl)}.`
  },
  {
    when: d => d.state === 'waiting' && d.roundTrips === 0 && d.wakes > 0,
    say: d => `${d.wakes} looks at the market. Nothing bought yet. Patience is free.`
  },
  {
    when: d => d.state === 'waiting',
    say: () => 'All cash. I am told that counts as a position.'
  },
  {
    when: d => d.gatedStreak >= 2,
    say: d => `${d.gatedStreak} wakes in a row where nothing moved enough to be worth the electricity.`
  },
  {
    when: d => d.fees > 0,
    say: d => `${money(d.fees)} of that went to fees. Nobody puts that on a chart.`
  },
  {
    when: d => d.exposure > 0,
    say: d => `${Math.round(d.exposure * 100)}% of the money is in the market. The rest is watching.`
  },
  {
    when: () => true,
    say: () => 'I wake up every four hours, look at one chart, and go back to sleep.'
  }
];

/* Everything the lines are allowed to know, derived once. Keeping this separate
 * means a new line can never accidentally reach into raw payload shape. */
function facts(data, now, price) {
  const n = data.now || {};
  const mark = price || n.mark;
  const equity = n.units ? n.cash + n.units * mark : n.equity;
  const curve = data.curve || [];
  const last = curve[curve.length - 1];
  const start = data.start_capital || 0;
  const newest = (data.decisions || []).slice(-1)[0] || null;
  const wakes = data.wakes || [];

  let gatedStreak = 0;
  for (let i = wakes.length - 1; i >= 0 && !wakes[i].gate_passed; i--) gatedStreak++;

  const bm = data.benchmark;
  const hold = bm ? bm.units * mark : (last ? last.bh : 0);
  const age = wakes.length ? now - wakes[0].ts : 0;
  const stale = now - (data.generated_at || now) > 8 * 3600000;

  return {
    now,
    halted: !!data.halted,
    stale,
    agoWords: relative(data.generated_at, now),
    state: n.state,
    open: (n.units || 0) > 0,
    pnl: (equity || 0) - start,
    holdPnl: hold ? hold - start : 0,
    beatingHold: hold ? equity > hold : false,
    stopDistance: n.stop && mark ? Math.max(0, mark - n.stop) * (n.units || 0) : null,
    exposure: n.exposure || 0,
    days: Math.max(1, Math.round(age / DAY)),
    wakes: wakes.length,
    gatedStreak,
    roundTrips: (data.totals || {}).round_trips || 0,
    fees: (data.totals || {}).fees || 0,
    expectBy: newest && !newest.rejected ? newest.expect_by_ts : null,
    expectByWords: newest && newest.expect_by_ts ? dayWords(newest.expect_by_ts) : '',
    daysLeft: newest && newest.expect_by_ts
      ? plural(Math.max(0, Math.ceil((newest.expect_by_ts - now) / DAY)), 'day') : ''
  };
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function dayWords(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC'
  });
}

function relative(ts, now) {
  if (!ts) return 'a while ago';
  const mins = Math.round((now - ts) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${plural(mins, 'minute')} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${plural(hrs, 'hour')} ago`;
  return `${plural(Math.round(hrs / 24), 'day')} ago`;
}

/* All the lines that currently apply, in priority order. `nth` cycles. */
function lines(data, now, price) {
  const f = facts(data, now, price);
  return LINES.filter(l => { try { return l.when(f); } catch { return false; } })
              .map(l => { try { return l.say(f); } catch { return null; } })
              .filter(Boolean);
}

window.Character = { POSES, poseFor, stateFor, lines, relative, dayWords, plural };
