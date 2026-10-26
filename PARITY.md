# Posthole code and behavior parity

This is the required agent workflow before **every commit** in Posthole or
posthole.ink, including documentation commits. The extension, local viewer, and
public demo must use the same implementation for every product feature they
share. Matching screenshots or separately written equivalent logic is insufficient.

## Source of truth

| Concern | Canonical implementation | Website consumer |
| --- | --- | --- |
| Capture, parsing, settings, extension UI | `src/`, `manifest.json`, `host/` | The extension packaged as `website/public/posthole.zip` |
| Cards, page markup, icons | `viewer/views.tsx`, `viewer/icons.tsx` | Imported by `website/scripts/render-interfaces.ts` |
| Supported styles, IDs, names, order | `viewer/interfaces.ts` | Generated selector, embedded catalog, `public/interfaces.json` |
| Viewer styling and fonts | `viewer/style.css`, `interfaces.css`, `netflix.css`, `assets/` | Generated/copied into `website/public/demo/` |
| Card and style interactions | `viewer/card-interactions.js`, `interface-controls.js`, `netflix.js` | Copied by the renderer and imported by the demo adapter |

Paths are relative to the Posthole checkout unless explicitly described as website
paths. `website/` is an independent Git repository (`reacji-to/posthole.ink`),
ignored by the parent repository. A parent commit does not include website changes.
Inspect and prepare both repositories explicitly.

## Implement once

1. Read both repositories' `AGENTS.md`, inspect both working trees, and identify
   every surface affected by the proposed change. Preserve concurrent work.
2. Change canonical source first. Import the same module or generate/copy its
   exact output into the website. Do not hand-edit generated demo HTML, CSS,
   interaction scripts, catalogs, or source hashes.
3. If shared behavior currently lives in an entry point, extract a shared module
   and call it from all applicable entry points. Do not translate the behavior
   into a second implementation. Update the renderer's copy/import list and
   source-hash coverage whenever a new dependency is introduced, including fonts
   and other assets relevant to the change.
4. Keep adapters limited to environment boundaries: curated record conversion,
   media URLs, static versus server data loading, and landing-page frame/tour
   communication. Product rules, labels, rendering, navigation, filtering, and
   media controls belong in shared code. Fix any product behavior duplicated in
   adapters when changing that behavior.
5. Add meaningful parity coverage when introducing or fixing shared behavior.
   Exercise the same fixtures and expected outcomes through both consumers;
   verify generated/copied artifacts against canonical source as appropriate.
   A source-hash check alone does not prove the output or behavior matches.

The browser extension captures posts and the website demonstrates viewing them;
browser permissions, native messaging, private storage, and server persistence
are environment capabilities. Keep those boundaries explicit. They do not excuse
different behavior for a feature offered on both surfaces. Never imply that an
unavailable capability works in the demo.

Existing parity gaps must be identified honestly. In particular,
`website/scripts/render-posts.mjs` separately renders the landing page's
“Original” preview, and `website/public/demo/demo.js` performs its own filtering.
These are not proof of full code parity. When touching those features, move the
product implementation into shared source and have both consumers use it; do not
extend the duplicate. Check `viewer/client.js` and `viewer/client-static.js` too
when a change affects loading or interaction initialization.

Reactions belong to reacji. Do not implement reactions in Posthole or its demo.

## Regenerate and verify before every commit

Run these checks on the exact source and generated files about to be committed.
From the Posthole repository root:

```sh
npm run test:viewer
npm --prefix website run check:viewer
npm --prefix website test
```

For **any viewer change**, first regenerate from canonical source:

```sh
npm --prefix website run render:interfaces
```

Review the website diff, including generated HTML, CSS, JavaScript, fonts,
`public/interfaces.json`, the selector/catalog in `public/index.html`, and
`public/demo/source-hashes.json`. A second regeneration must produce no additional
diff. Do not update hashes merely to suppress a failure. Inspect copied files as
well: the current hash checker checks source hashes, not every output byte, and
does not cover every viewer dependency.

For **extension, helper, or release-content changes**, run from the Posthole root:

```sh
npm test
npm run test:e2e
npm run package -- website/public/posthole.zip
```

The end-to-end command builds the extension; packaging builds again and writes
the actual downloadable bundle. Verify the ZIP's `posthole/dist/` files match
the final local `dist/` byte for byte, including `build.json`, and inspect its
source/helper/viewer contents against the current checkout. Do not rebuild after
this comparison without repackaging and checking again: builds have unique IDs.
Never hand-edit the ZIP. Keep download/install copy accurate. Viewer changes are
also release-content changes because the download contains `viewer/`.

For **shared UI or behavior changes**, also compare the local viewer and website
preview using the same curated public fixtures and equivalent state. Check every
affected style at desktop and narrow widths, mouse and keyboard controls, style
selection and order, navigation, search/source filters, empty results, text and
thread expansion, image/video controls, and reduced-motion behavior as applicable.
Verify actual outcomes, not just the presence of controls. Never load private
archive data into public fixtures or assets.

Documentation-only changes still require the three baseline checks above and a
review of both diffs; rendering, packaging, and browser checks are conditional on
the affected surfaces. Re-run affected checks after any subsequent edits.

## Commit gate and delivery

Before invoking `git commit` in **either** repository:

- Read this guide and both `AGENTS.md` files. If the companion checkout or guide
  is unavailable, obtain the matching source checkout before proceeding.
- Inspect both staged and unstaged diffs. Include all required regeneration and
  download changes, and exclude private data, credentials, and unrelated work.
- Require the checks above to pass. Missing tools, stale output, failing tests,
  unexplained behavioral differences, or an outdated download block the commit.
  Do not bypass the gate with `--no-verify` or describe unchecked parity as done.
- For a change spanning both repositories, prepare and verify the complete pair
  before the first commit; commit each repository's required files as one
  coordinated change. Record the paired commit IDs in the handoff. Git cannot
  make commits atomic across these independent repositories.
- State the affected surfaces, canonical modules used, checks and their results,
  and any environment-specific limits in the handoff. Do not claim full parity
  based only on the existing source-hash check or passing unit tests.

This is a mandatory agent commit gate enforced by the repositories' instructions;
it is not an installed Git hook. Do not claim Git mechanically prevents bypass.

Commit readiness does not authorize deployment. If publication is authorized,
preserve the website's Worker authentication and hosting configuration, follow
its README's build and pinned binary-source requirements, and deploy the verified
current build. Never overwrite concurrent protected-site work with an older
static build. Verify the hosted demo and download after publication. If publishing
has not happened, report local synchronization and pending deployment separately.
