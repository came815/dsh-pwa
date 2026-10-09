# PWA fork maintenance

- Preserve upstream attribution, LICENSE and upstream.json. Runtime entry: index.js/server.js. lib/ and client/ are retained upstream source, not the installed runtime.
- Keep credentials, personal paths, private hostnames, conversations and real screenshots out of Git. Use synthetic browser fixtures.
- Preserve authentication, trusted Host/Origin, fixed paths, no-store and CSP. Do not add token persistence, public listeners or external telemetry.
- Run node --check web/app.js and npm test. Set DSH_RUNTIME_PACKAGE_ROOT only for an explicitly available installed Connection package; otherwise its optional test skips.
- Verify changed UI at 393x852 and desktop/reflow. Do not run inference or approve real operations during browser checks.
- Work on this Fork; do not send upstream issues, PRs or comments without explicit user request. Do not merge upstream changes automatically.
