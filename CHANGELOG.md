# Changelog

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
