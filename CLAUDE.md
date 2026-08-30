# cryptobro-site

The status page for the **cryptoBro** trading bot (`~/dev/cryptoBro`). Static: no build step, no framework, no dependencies.

## Deploying

**`git push` to `main` is the deploy.** Nothing else. GitHub Actions builds a `linux/arm64`
image, pushes it to `ghcr.io/rafikee/cryptobro-site:latest`, and calls the Coolify API, which
pulls the new image on the baradapi Pi and restarts the container.

```bash
~/.claude/skills/newapp/scripts/watch-deploy.sh crypto     # follow the build + deploy
~/.claude/skills/newapp/scripts/verify-app.sh cryptobro-site p319uettglbv2xgyyd1px4gj 8102 cryptobro.barada.dev
```

Roughly a minute end to end for a small image.

**Don't watch "the latest run" and don't stop at a 200.** Both lie on a redeploy:

- `gh run watch` with no run id (and `gh run list --limit 1`) takes the newest row, and
  GitHub often hasn't created your run yet seconds after a push — so it reports the
  *previous* commit's `completed success`. `watch-deploy.sh` keys on
  `headSha == git rev-parse HEAD` instead, and waits when there's no run yet.
- `curl https://cryptobro.barada.dev/` returns 200 from the container you're replacing. `verify-app.sh`
  compares GHCR's `:latest` digest against both the `:<HEAD sha>` tag and the digest the
  running container was pulled from, which is what actually proves Coolify pulled. Run it
  from inside this repo or it skips the HEAD half.

**Never `docker build` on the Pi, and never deploy by hand.** Source builds peg the Pi's
load past 20 and drop SSH; the whole pipeline exists to prevent that. If a deploy needs
forcing without a code change:

```bash
gh workflow run build-and-deploy -R rafikee/cryptobro-site
```

## This app's values

| | |
|---|---|
| Public URL | `https://cryptobro.barada.dev` |
| GitHub repo | `rafikee/cryptobro-site` (public) |
| Image | `ghcr.io/rafikee/cryptobro-site:latest` (public) |
| Coolify app + project | `cryptobro-site` |
| Coolify app UUID | `p319uettglbv2xgyyd1px4gj` |
| Ports | host `8102` → container `80` |
| Server | `baradapi` (Pi 5, `ssh baradapi`) |
| Checkout | `~/dev/cryptobro-site` |

## Why the hostname is not the app name

The runbook says the repo, the Coolify app and the subdomain are all the same string. Here
everything is **`cryptobro-site`** except the public hostname, which is **`cryptobro`**.
Two collisions forced it, and both are worth knowing before you try to "fix" the naming:

- **`cryptobro` was not available as a repo or a directory, because the bot already owns
  it.** GitHub repo names are case-insensitive, so `rafikee/cryptobro` *is*
  `rafikee/cryptoBro`. This machine's APFS volume is case-insensitive too, so
  `~/dev/cryptobro` *is* `~/dev/cryptoBro`. Creating either one does not fail with a clear
  error; it silently hands you the bot's repo.
- **The hostname is `cryptobro`, not `crypto`,** because `rafikee/crypto` is an unrelated
  IFTTT price-alert script from 2022 that was not worth renaming.

The practical consequence: **`verify-app.sh` needs its optional fourth argument**, the
FQDN, because it otherwise assumes `<APP>.barada.dev` and would check
`cryptobro-site.barada.dev`, which does not exist.

## Secrets

**This app has none, and should never need any.** It is nginx serving static files
plus a `fetch()` of two public URLs — there is nothing to authenticate to. The only credential
anywhere near it is the Coolify deploy token, which lives as a GitHub Actions secret on
this repo and never enters the image or the container.

If that ever changes, note that the image is public, so nothing goes in it: Coolify injects
env at runtime via the UI at <https://coolify.barada.dev> or
`/api/v1/applications/p319uettglbv2xgyyd1px4gj/envs`.

## When a deploy doesn't take

```bash
cd ~/dev/cryptobro-site && ~/.claude/skills/newapp/scripts/verify-app.sh cryptobro-site p319uettglbv2xgyyd1px4gj 8102 cryptobro.barada.dev
```

Eight checks from the image outward; the first failure names the layer. Common ones: a 502
with the container healthy means the host port isn't bound or the tunnel ingress is wrong;
`running:unknown` in Coolify is normal for an app with no healthcheck; check 4 failing
(container digest != GHCR `:latest`) means Coolify never pulled and the site is serving the
old build behind a perfectly good 200 — re-trigger with
`gh workflow run build-and-deploy -R rafikee/cryptobro-site`.

Full pipeline docs, including how this app was created and how to tear it down:
`~/dev/new-app-runbook.md`. Changing the port or the hostname touches three places (Coolify
`ports_mappings`, `/etc/cloudflared/config.yml` on the Pi, and the Cloudflare DNS record) —
read that runbook before touching any of them.

## The `data` branch — read this before touching anything

**This repo has two branches that have nothing to do with each other.**

- `main` — the site. Pushing here builds an image and deploys.
- `data` — a single orphan commit holding one file, `data.json`. A launchd job on the
  Mac mini (`com.rafikee.cryptobro-publish`, running `~/dev/cryptoBro-live/scripts/publish.py`)
  **force-pushes over it** after every wake. It has no shared history with `main` and
  amending is deliberate: the JSON already contains the whole history, so keeping 2,000
  commits a year of near-identical 200 KB files would only grow the repo.

The page fetches `https://raw.githubusercontent.com/rafikee/cryptobro-site/data/data.json` at load
and falls back to the copy baked into the image at `data/data.json`. That bundled copy is a
**fallback and a local-dev convenience, not the live data** — it goes stale the moment it
ships and that is fine.

The consequence worth remembering: **the numbers on the site are not in this image, so new
data never needs a deploy.** `build.yml` only fires on `main`, so the publisher's pushes
cannot trigger a build. Do not "fix" that trigger to include all branches.

If the page shows a stale banner, the bot is probably fine and the publisher is not:

```bash
tail -20 ~/.config/cryptobro/logs/publish.log
launchctl kickstart -k gui/$(id -u)/com.rafikee.cryptobro-publish
curl -s https://raw.githubusercontent.com/rafikee/cryptobro-site/data/data.json | head -c 200
```

## Cloudflare overrides this app's cache headers, and there is a rule stopping it

**The barada.dev zone sets Browser Cache TTL to 14400 (4 hours), and that overrides
whatever the origin sends.** `nginx.conf` here deliberately sends `Cache-Control: no-cache`
for html/css/js so a deploy is picked up on the next load, and Cloudflare was rewriting
that to `max-age=14400` on the way out. The result is a deploy that verifies green from
every angle — GHCR digest, container digest, `curl` of the live CSS — while a phone that
visited in the last four hours keeps rendering the old stylesheet. That cost a round trip
of "are you sure?" during the build, and the honest answer was no.

Fixed with a **Cache Rule scoped to this hostname**, not by changing the zone setting,
which would have altered caching for all eight apps:

```
ruleset 2d1cb2184c7247799724496db792a1cd  (phase http_request_cache_settings)
  (http.host eq "cryptobro.barada.dev")  ->  browser_ttl: respect_origin
```

Check it is still doing its job with `curl -sI https://cryptobro.barada.dev/css/style.css`
— expect `cache-control: no-cache`, not `max-age=14400`. Images are the exception and
should read `max-age=2592000`; they only change when the character does.

**After a deploy that changes CSS or JS, an already-open browser still needs one hard
reload** if it cached under the old rule. New visitors do not.

## The one outbound call this page makes

The big number is **live**, and it is the reader's browser that makes it live, not the
publisher. `js/app.js` polls Kraken's public ticker every 60 seconds and re-marks the
equity, both deltas, the exposure percentage and the character's pose against it.

```
https://api.kraken.com/0/public/Ticker?pair=ETHUSD   ->  result.<pair>.c[0]
```

**Do not move this into `publish.py`.** That was the first design and it was wrong. The
publisher makes no network calls at all, and that is precisely what makes it incapable of
affecting the bot: there is nothing in it that an outage can wedge. Fetching in the browser
costs our infrastructure nothing, needs no key, and scales with readers rather than with
time.

Three things it depends on, in the order they would break:

- **CORS.** Kraken echoes `access-control-allow-origin` back for this origin. If that ever
  stops, every fetch fails and the page silently keeps the published bar-close numbers,
  relabelling them `at the HH:MM close` instead of `live`. Degraded, not broken.
- **The same exchange the bot trades on**, so the live price agrees with the ledger. Do not
  swap it for a cheaper aggregator without thinking about that.
- **`data.json` carrying `benchmark`** (`units`, `entry_price`, `fee`). The browser needs
  the benchmark's units to re-mark buy-and-hold at the live price. Payloads written before
  2026-08-30 lack it, and the page falls back to the last published bar-close value.

`?live=off` disables the polling, which is what you want for a deterministic screenshot.
`?data=<url>` implies it, so fixtures never hit the network.

**The chart is deliberately not live.** It is plotted at 4-hour closes, because those are
the only prices the bot ever acted on. A live number on top of a bar-close curve is the
intended shape, not an inconsistency.

## Working on the page

```bash
cd ~/dev/cryptobro-site && python3 -m http.server 8765     # no build step; just serve it
~/dev/cryptoBro/.venv/bin/python tools/make-fixture.py   # months of invented history
uv run --with pillow --with numpy python tools/prep-art.py   # rebuild img/ from art-src/
```

Then open it and **actually look at it** rather than reading the source back:

```
http://localhost:8765/?reveal=all                      every section visible, no animation
http://localhost:8765/?state=holding                   force a character pose
http://localhost:8765/?data=tools/fixture.json         months of history instead of days
http://localhost:8765/?hide=hold                       start with a series switched off
http://localhost:8765/?debug=width                     name whatever overflows the window
```

`?reveal=all` exists because sections start at `opacity: 0` until scrolled to, so a plain
headless screenshot of the whole page captures blank space and looks like a layout bug.
`?debug=width` writes into `document.title` — scroll position, page height, the hash
target's offset and opacity, then anything overflowing — so `--dump-dom | grep SCROLL`
reads the lot. Both earned their keep during the build.

**Two headless limitations to know before you debug the wrong thing:**

- **A screenshot taken after a programmatic scroll comes back solid background**, even
  though the page is fine. Loading `/#about` scrolls correctly (`--dump-dom` reports
  `#about top=23 opacity=1`) and the PNG still has zero non-background pixels. Do not go
  looking for a rendering bug — check anchor jumps with `?debug=width` and `--dump-dom`,
  not with `--screenshot`.
- **Chrome on macOS will not go below about a 500 px viewport**, whatever `--window-size`
  says, because the window has a platform minimum. Narrow-layout checks top out there, and
  `--force-device-scale-factor` does not help; it only scales the raster.

Two files carry the design: `css/style.css` (the palette, sampled from the art by
`tools/prep-art.py`, as custom properties at the top) and `js/character.js` (which pose
goes with which state, and everything the robot says). The chart's two series colours are
**not** free choices — they are the pair that passes the `dataviz` skill's validator on
this background. Re-run it before changing them.
