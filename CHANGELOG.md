# Changelog

## 0.2.3 (2026-10-27)

- A terminal command holds up to 100,000 characters, up from 20,000, so one
  command can write several files. The toolchain runs it from a script file
  instead of a `bash -c` argument, which Linux caps at 128 KB.
- The agent's preview page opens only when a browser command needs it. Before,
  the first terminal command, or warming a design for chat, opened it, and every
  later change re-rendered it and ran its queries again for a page nobody was
  looking at. A command's preview result is `no-preview` when no page watches
  the design; health still draws the page.

## 0.2.2 (2026-10-27)

- Health, screenshots and outlines wait on what the page says about itself. A
  preview page is ready when its root has rendered, no request is pending and
  no element is `aria-busy="true"`, checked twice 100 ms apart. When it is not
  ready within 15 s, the result says what was still loading, naming busy
  elements by their nearest `aria-label`. Before, the timeout was swallowed and
  every capture waited a fixed second.
- Screenshots wait for two identical frames, as Playwright's `toHaveScreenshot`
  does, instead of a fixed sleep. They take at most 3 s, and say so when the
  page kept changing. Pages load with reduced motion. `StudioImage` has
  `notes` for what a picture may not show.
- Failed requests to the host's declared API (`hints.api`) are reported even
  under `/_studio/`, with the reason the response gave (`{message}` in the
  `status` hint). Before, a host whose data path sat under `/_studio/` got no
  report of failed data at all.
- `withoutTokens` strips a preview token from any path, not only from preview
  and check paths.
- A media hint's `path` matches the way an API hint's does: as the start of a
  path, followed by `/`, `?` or the end. Before, any URL containing the text
  matched.
- Version checks follow the host instead of assuming a shop.
  - **Pages:** a check visits the pages the build prerendered, up to eight, and
    runs axe and the host's `CheckPack` on each. Before, it visited a product
    page, a collection page and `/cart`, and ran the host's checks only on a
    product page. A dashboard therefore never passed, failing on "a product
    page to test on".
  - **Host data:** failures of the host's declared API are not counted, because
    the static build has no preview data.
  - **Headings:** the heading rule is gone, as axe already checks accessibility.
  - **`CheckPack.run`:** its second argument is the page's URL.

- Stage timings cover the toolchain's own phases (`toolchain-types`,
  `toolchain-lint`, `toolchain-compile`, …), the render half of
  `studioDesignHealth` (`health-render`) and screenshots (`screenshot`).
  Before, the toolchain returned its timings and nothing read them.
- Checks that did not run say so. Three cases used to read as "no errors":
  - a type check killed at its 300 s limit or crashing;
  - lint that hit ESLint's fatal exit or returned unreadable output;
  - route types that could not be generated.

  Each now comes back as a diagnostic that says it was not checked.

## 0.2.1 (2026-10-26)

- An agent page that fails, such as a browser that cannot launch, rejects only
  for its caller. Before, the queue's cleanup left a second rejection unhandled,
  and Node stopped the whole service.

## 0.2.0 (2026-10-26)

- `STUDIO_DIAGNOSE_ON_CHANGE=false` checks on demand. A command or save
  compiles only what it touched and publishes the preview without waiting for
  it to render (`status: 'published'`), and its result says it was not checked
  (`diagnosed: false`). `studioDesignHealth` runs the full check of the latest
  draft once and keeps it for that tree. The default still checks every change.
- The sandbox reads a missing pid file as a stopped process. Before, it took a
  missing lint daemon for a running one and waited 8 s for its answer.

## 0.1.0 (2026-10-25)

The studio engine, extracted from EndofSzn's storefront studio into a library
any product can host.

- `StudioModule.forRoot({ host })` mounts the engine; `SiteDirectory`,
  `EventSink` and `CheckPack` are the host's ports.
- The contract, the preview app, the sandbox toolchain, the `studio`
  migrations and the edge router ship in the package.
- Names a template or kit depends on come from `STUDIO_BRAND_ID`, and the
  template, kit and checks from `STUDIO_TEMPLATE_NAME`, `STUDIO_KIT_PACKAGE`
  and `STUDIO_TEMPLATE_CHECKS`; the preview's messages come from the host's
  preview config.
- An assistant's file save keeps its run's hold, as its commands do, and
  leaves the version to the run's end. Stale whole-file writes still come back
  as conflicts.
