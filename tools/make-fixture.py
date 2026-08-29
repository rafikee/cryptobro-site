#!/usr/bin/env python
"""A few months of invented history, so the page can be checked before it exists.

    ~/dev/cryptoBro/.venv/bin/python tools/make-fixture.py

Writes `tools/fixture.json`, which the page loads with `?data=tools/fixture.json`.

It runs the **real** `cryptobro.agent.publish.build` over a synthetic ledger rather
than hand-writing JSON, so the fixture cannot drift from the shape the publisher
actually emits. That is the whole point: a hand-written fixture would keep passing
after the payload changed.

Fixture only. Never published, never committed to the `data` branch.
"""

import random
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.home() / "dev/cryptoBro/src"))

import pandas as pd                                              # noqa: E402

from cryptobro.agent import publish                              # noqa: E402
from cryptobro.agent.ledger import Ledger                        # noqa: E402

H4 = 4 * 3_600_000
START_TS = 1_780_000_000_000
BARS = 560                       # a bit over three months of 4h bars
FEE = 0.004

REASONS = [
    "Daily trend still up and the 4h range is holding its floor. Nothing here says "
    "get out, and nothing says add either, so I am sitting on my hands.",
    "The breakout retested and held. Volume on the push was double the week's "
    "average and the pullback came on a third of it, which is the shape I want.",
    "Lower high on the 4h and the daily closed under its own 20. I would rather be "
    "wrong and flat than right and early, so I am taking the position off.",
    "Range-bound for eleven bars with the ATR compressing. There is no edge in "
    "guessing which way a coil breaks, so I am waiting for it to pick.",
]
EXPECTATIONS = [
    "ETH prints a 4h close above the range high before it closes a day below the "
    "breakout level. If the daily goes first, the move failed and I was wrong.",
    "The retest holds and the next daily closes green. A close under the stop level "
    "means the buyers who showed up on the breakout are gone.",
    "Price stays under the level it just lost for at least three more 4h bars. If it "
    "reclaims it inside one, this was a shakeout and I sold the low.",
]
GATES = [
    "nothing moved enough to be worth a look.",
    "range is tight and the position is fine where it is.",
    "no new daily close since the last look.",
    "volatility collapsed; waiting for the market to say something.",
]


def main():
    rnd = random.Random(11)

    price, bars = 2_400.0, []
    for i in range(BARS):
        price *= 1 + rnd.gauss(0.0006, 0.016)
        bars.append({"ts": START_TS + i * H4, "close": round(price, 2)})
    df = pd.DataFrame(bars)

    with tempfile.TemporaryDirectory() as tmp:
        led = Ledger(Path(tmp) / "ledger.db", initial_capital=1_000.0, fee=FEE)
        simulate(led, df, rnd)
        payload = publish.build(led, df, now_ms=START_TS + BARS * H4 + 900_000,
                                symbol="ETH/USD")
        led.close()

    out = Path(__file__).resolve().parent / "fixture.json"
    out.write_text(publish.dump(payload))
    t = payload["totals"]
    print(f"{out}: {t['wakes']} wakes, {t['decisions']} decisions, "
          f"{t['round_trips']} round trips, {len(payload['curve'])} curve points, "
          f"{out.stat().st_size // 1024} KB")


def simulate(led, df, rnd):
    """Wake on most bars, trade on a few, close out on a stop or a signal."""
    closes = df["close"].tolist()
    times = df["ts"].tolist()

    for i in range(2, len(closes)):
        ts = times[i] + H4 + rnd.randint(60_000, 900_000)   # just after the close
        price = closes[i]
        wid = led.start_wake(ts)
        book = led.load_position()

        # The gate holds most of the time, which is the real shape of this thing.
        if rnd.random() < 0.62:
            led.finish_wake(wid, gate_passed=False, gate_reason=rnd.choice(GATES),
                            escalated=False, outcome="gated", duration_ms=900)
            continue

        held = book.held()
        want_out = held and (price < book.stop or rnd.random() < 0.16)
        want_in = not held and rnd.random() < 0.30
        action = "sell" if want_out else "buy" if want_in else "hold"

        stop = round(price * 0.955, 2) if action == "buy" else None
        did = led.record_decision(
            wake_id=wid, ts=ts, action=action,
            size_frac=0.3333 if action == "buy" else (1.0 if action == "sell" else 0.0),
            proposed_stop=stop, clamped_stop=stop,
            reasoning=rnd.choice(REASONS),
            expectation=rnd.choice(EXPECTATIONS) if action != "hold" else "",
            expect_by_ts=ts + rnd.randint(3, 8) * 86_400_000 if action != "hold" else None,
            model="claude-opus-5", code_version="fixture", tool_calls=rnd.randint(2, 9))

        if action == "buy":
            spend = book.cash * 0.3333
            units = spend / price
            led.record_buy(decision_id=did, ts=ts, units=units, price=price,
                           fee=units * price * FEE, reason="agent", entry_ts=ts,
                           stop=stop)
        elif action == "sell":
            reason = "stop" if price < book.stop else "agent"
            trade = book.sell_fraction(1.0, price, ts, reason)
            led.record_sell(decision_id=did, trade=trade, frac=1.0, stop=None)

        led.finish_wake(wid, gate_passed=True, gate_reason="something moved.",
                        escalated=False, outcome="ok", duration_ms=rnd.randint(9_000, 40_000))
        led.snapshot(led.load_position(), ts, price)


if __name__ == "__main__":
    main()
