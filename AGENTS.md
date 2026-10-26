# Keep Posthole in sync

Russell requires the extension, local server, and posthole.ink demo to stay synchronized at all times (2026-10-24). This is a completion requirement for every relevant change, not optional follow-up work.

## Mandatory gate before every commit

Before **every `git commit`**, including documentation-only commits, read and follow [PARITY.md](PARITY.md) and `website/AGENTS.md`. This applies to commits in either repository. Shared product behavior must come from the exact same canonical implementation; independently maintained copies of equivalent logic are prohibited.

- Run `npm run test:viewer`, `npm --prefix website run check:viewer`, and `npm --prefix website test` before every commit. Apply the guide's additional regeneration, extension packaging, and behavior checks for affected surfaces.
- Prepare and verify all required changes in both repositories before the first commit of a coordinated change. The website is a separate Git repository; committing here does not commit its files.
- Failing or unavailable checks, stale generated output, duplicated behavior in a changed shared feature, or an outdated affected download block the commit. Fix the issue before committing; do not bypass the gate or claim synchronization without evidence.
- This is an agent instruction, not an installed Git hook. Publication remains a separate step; report it as pending until completed and verified.

## Synchronization requirements

- This repo owns extension behavior in `src/` and viewer behavior in `viewer/`. The website is a separate repo in `website/` (`reacji-to/posthole.ink`).
- Keep supported styles, names, controls, layout, navigation, media behavior, and product copy consistent across applicable surfaces. Change the shared implementation first; do not independently recreate viewer behavior in the demo.
- After viewer changes, run `npm run render:interfaces` in `website/` and commit the regenerated assets with the website change. The renderer also updates the website style selector and catalog from `viewer/interfaces.ts`.
- Run `npm run check:viewer` and `npm test` in `website/`, and `npm run test:viewer` here. Fix stale output before publishing or reporting completion.
- When extension behavior changes, rebuild and test the extension and refresh the website's downloadable extension with the same build before publication. Update installation instructions if needed.
- Demo inputs must remain the curated public records and media. Never copy the private local archive into the public site.
- Preserve the website's hosting and authentication configuration. Coordinate with concurrent work; never publish an older static build over the protected site.
- Do not report all surfaces synchronized if a required regeneration, build, download update, or deployment remains incomplete; identify what remains.

Reactions belong to the reacji extension. Do not add a separate reaction implementation to Posthole or its demo.

## Keep the local viewer running

Russell requires the local Posthole server to run continuously (2026-10-26). On this Mac it is managed by the user LaunchAgent `ink.posthole.viewer` at `~/Library/LaunchAgents/ink.posthole.viewer.plist`, serving `http://localhost:4747` from `viewer/` and reading `~/posthole`.

- Install or repair it with `npm run install-server`. This pins the current checkout and Bun executable, starts immediately, restarts after exits, and starts at login. Re-run after moving the checkout or Bun. Use `-- --dir /absolute/archive/path --port PORT` for an explicitly requested custom configuration.
- Keep it running after tasks and terminal sessions end. Do not replace it with a temporary shell/background process or stop it unless requested.
- After changing viewer server code, restart this service with `launchctl kickstart -k gui/$(id -u)/ink.posthole.viewer`, then verify an HTTP response at its configured URL. Identify any process occupying the port before taking action; never stop unrelated services.
- Logs are `~/Library/Logs/Posthole/viewer.log` and `viewer-error.log`. Inspect with `launchctl print gui/$(id -u)/ink.posthole.viewer`. Explicit removal uses `npm run install-server -- --uninstall` and preserves the archive.
