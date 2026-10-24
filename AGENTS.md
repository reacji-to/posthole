# Keep Posthole in sync

Russell requires the extension, local server, and posthole.ink demo to stay synchronized at all times (2026-10-24). This is a completion requirement for every relevant change, not optional follow-up work.

- This repo owns extension behavior in `src/` and viewer behavior in `viewer/`. The website is a separate repo in `website/` (`reacji-to/posthole.ink`).
- Keep supported styles, names, controls, layout, navigation, media behavior, and product copy consistent across applicable surfaces. Change the shared implementation first; do not independently recreate viewer behavior in the demo.
- After viewer changes, run `npm run render:interfaces` in `website/` and commit the regenerated assets with the website change. The renderer also updates the website style selector and catalog from `viewer/interfaces.ts`.
- Run `npm run check:viewer` and `npm test` in `website/`, and `npm run test:viewer` here. Fix stale output before publishing or reporting completion.
- When extension behavior changes, rebuild and test the extension and refresh the website's downloadable extension with the same build before publication. Update installation instructions if needed.
- Demo inputs must remain the curated public records and media. Never copy the private local archive into the public site.
- Preserve the website's hosting and authentication configuration. Coordinate with concurrent work; never publish an older static build over the protected site.
- Do not report all surfaces synchronized if a required regeneration, build, download update, or deployment remains incomplete; identify what remains.

Reactions belong to the reacji extension. Do not add a separate reaction implementation to Posthole or its demo.
