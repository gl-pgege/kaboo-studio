# Changelog

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
