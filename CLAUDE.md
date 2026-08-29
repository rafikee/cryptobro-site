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

**This app has none, and should never need any.** It is nginx serving four static files
plus a `fetch()` of a public URL — there is nothing to authenticate to. The only credential
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
`?debug=width` writes its findings into `document.title`, so `--dump-dom | grep OVERFLOW`
reads it. Both earned their keep during the build.

**Headless Chrome on macOS will not go below about a 500 px viewport**, whatever
`--window-size` says, because the window has a platform minimum. Narrow-layout checks top
out there; `--force-device-scale-factor` does not help, it only scales the raster.

Two files carry the design: `css/style.css` (the palette, sampled from the art by
`tools/prep-art.py`, as custom properties at the top) and `js/character.js` (which pose
goes with which state, and everything the robot says). The chart's two series colours are
**not** free choices — they are the pair that passes the `dataviz` skill's validator on
this background. Re-run it before changing them.
