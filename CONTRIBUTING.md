# Contributing to dsh-pwa

Thanks for stopping by. This project is deliberately boring technology: **vanilla JS, no build step, no framework.** If you can read a 300-line server file, you can contribute.

## Map of the repo

| Path | What it is |
|---|---|
| `web/app.js` | The whole mobile app (sessions, chat, approvals, questions). Big file, organized by feature sections. |
| `web/style.css` | All styles. Dark-first, `html.light` overrides for light theme. |
| `web/index.html` | Shell: splash screen, theme pre-paint, PWA meta tags. |
| `web/manifest.webmanifest`, `web/icon-*.png`, `web/icon.svg` | PWA install surface. |
| `lib/routes.js` | Mounts `web/` at `/m` on the host's `webServer`. Static files are re-read per request — **no restart needed while iterating on UI**. |
| `lib/index.js` | Plugin entry: self-healing mount (re-mounts if the webServer is recreated). |
| `client/client.js` | Injects *Settings → 手机端* into the desktop GUI, showing the phone URL. Hand-written CJS bundle for `window.__ModuleLoader__` — no build. |
| `test/smoke.mjs` | CI smoke test: mounts routes on a stub server, hits `/m/health`. |
| `docs/AUDIT.md` | The full UX audit trail (69 items). Read before touching UI behavior. |

## Local development

1. You need a running `dsh web` (see README quick start) with this plugin in the profile's bundles.
2. Edit anything under `web/` → refresh the phone page. That's the whole loop.
3. The page talks to the harness's own `/api` — same protocol as the desktop GUI (`POST /api/<ns>/<method>`, `ws://…/api/events.mux`). When in doubt, watch the desktop GUI's network tab: whatever it calls, you can call.

## Ground rules

- **No build step, ever.** Don't add bundlers, TS, or frameworks. The "edit → refresh" loop is a feature.
- **Match the existing iOS conventions** already in the codebase: inputs ≥ 16px (iOS zooms smaller ones), 44px touch targets for urgent buttons, `touchend`-driven taps where iOS eats the first click (see AUDIT #56).
- **Dark theme first**, then mirror in `html.light` with contrast-checked values (see AUDIT #66–67).
- **Optimistic UI with honest failure states**: every send shows immediately and degrades to a tappable retry — never a silent spinner.
- Keep the server dumb: `lib/` ships bytes, business logic lives in the page's `/api` calls.

## PR process

1. For anything beyond a typo, open an issue first (or claim a roadmap item in [docs/ROADMAP.md](docs/ROADMAP.md)) so we don't duplicate work.
2. Small, reviewable diffs. One behavior change per PR.
3. `node test/smoke.mjs` must pass (CI runs it too).
4. If you change UI behavior, note the AUDIT item number it relates to — or add a row if it's a new finding.

## Release process (maintainers)

1. Bump `version` in `package.json` and the `?v=` cache-busters in `web/index.html`.
2. Tag `vX.Y.Z`, push, then draft a GitHub Release from the tag (notes template in `promo/` notes of the growth checklist).
3. `npm publish --access public`.

Questions? Open a discussion — don't DM.
