# kaboo-studio

> A builder engine for agents and people. Each design is a small web app kept as
> versioned code, edited through sandboxed commands and file saves, checked for
> types, lint and rendering, and previewed live.

[![npm version](https://img.shields.io/npm/v/@pgege/kaboo-studio.svg)](https://www.npmjs.com/package/@pgege/kaboo-studio)
[![license](https://img.shields.io/npm/l/@pgege/kaboo-studio.svg)](./LICENSE)

kaboo-studio is the engine behind EndofSzn's storefront studio and Kaboo's
dashboards as code. A product mounts it as a NestJS module and supplies a
**host**: who its sites are, what a design's build and preview may reach, where
version events go and which product checks run. Everything else (designs,
drafts and versions, sandboxes, previews, checks, deployments) is the engine's.

## What's in the package

| Part | Where | What it is |
|---|---|---|
| Engine | `@pgege/kaboo-studio` | `StudioModule`, the host ports and the engine's services |
| Contract | `@pgege/kaboo-studio/contract` | The GraphQL schema (`studioSchemaSdl`) and its zod schemas and types |
| Preview app | `@pgege/kaboo-studio/preview/*` | The static bundle that renders a design in an iframe, served from its own origin |
| Toolchain | `@pgege/kaboo-studio/toolchain/*` | The sandbox image's Dockerfile and the scripts copied into each session |
| Migrations | `@pgege/kaboo-studio/prisma/*`, `kaboo-studio-migrate` | The `studio` schema in your Postgres |
| Edge router | `@pgege/kaboo-studio/edge/router.js` | The CloudFront function that routes live sites to their deployed versions |

## Mounting it

```ts
import { Module } from '@nestjs/common';
import { CheckPack, EventSink, SiteDirectory, StudioModule } from '@pgege/kaboo-studio';
import { MyChecks, MyEvents, MySites } from './host';

@Module({
  imports: [
    StudioModule.forRoot({
      host: [
        { provide: SiteDirectory, useClass: MySites },
        { provide: EventSink, useClass: MyEvents },
        { provide: CheckPack, useClass: MyChecks },
      ],
    }),
  ],
})
export class AppModule {}
```

The module serves the GraphQL schema at `POST /internal/studio/graphql` (an
internal key, `x-studio-store` and `x-studio-principal`, the caller as base64url
JSON), the preview endpoints and the check and deployment-file routes. It
exports the engine's services (`EditorService`, `TerminalService`,
`RunService`, `DesignService`, `PreviewTokens` and the rest), so a host can also
serve its own REST or MCP surface on top of them.

### The host ports

- **`SiteDirectory`**: a store's site (code, name, URL), the environment a
  design's build gets, and the preview config the preview app hands the
  design. The preview config may carry `assetOrigin` (an origin the design may
  fetch from) and `hints`, the messages agents see when a preview breaks a
  rule (blocked requests and pictures, an API the design talks to).
- **`EventSink`**: where version and live events go.
- **`CheckPack`**: the host's own checks, run on every page a version's build
  prerendered.

## Writers and holds

Every change goes through one write path that claims the design for its
writer. A person's command or save claims it for that change. An assistant's
claim belongs to its run (`run:<runId>`, or `assistant:<chatId>`) and lasts
until the run ends (`endStudioRun`), when the engine cuts one version of each
design the run changed. File saves check each file's `baseHash`, the hash the
writer last saw, so a stale whole-file write comes back as a conflict instead
of overwriting someone else's work.

## Checks

By default each change is checked as it lands: the type check, lint on the
changed files and the preview's render come back with it. With
`STUDIO_DIAGNOSE_ON_CHANGE=false` a change only compiles the files it touched
(a syntax error still comes back at once), updates the preview without waiting
for it to render, and says it was not checked. `studioDesignHealth` then checks
the latest draft once: it compiles every module, reads the type watcher's pass
after the last change (or runs `tsc` when routes or packages changed), lints
every app file, renders the home page, and keeps the result for that draft.

A version check builds the version for production and visits every page the
build prerendered, up to eight. On each page it records:
- whether it loads, and any errors thrown or logged;
- axe's WCAG violations;
- the host's `CheckPack` results.

Failures of the host's declared API (`hints.api`) are not counted, because the
static build has no preview data to fetch.

## Configuration

Environment variables, read when the engine loads. A host that wants its own
defaults sets them before importing the module.

| Variable | Default | What it sets |
|---|---|---|
| `STUDIO_BRAND_ID` | `studio` | The prefix of names a template or kit relies on: the config meta tag, preview headers, postMessage sources, the design's config global (`__<BRAND>__`), the route event |
| `STUDIO_BRAND_NAME` | `Studio` | The platform actor's name and the metrics namespace |
| `STUDIO_TEMPLATE_NAME` | `app` | The template releases come from (`templates/<name>-latest.json` in storage) |
| `STUDIO_KIT_PACKAGE`, `STUDIO_KIT_LABEL` | none | The package kit upgrades install, and how version messages name it |
| `STUDIO_TEMPLATE_CHECKS` | `npm run typecheck && npm run lint && npm run build` | What a kit upgrade must pass |
| `STUDIO_DIAGNOSE_ON_CHANGE` | `true` | `false` checks on demand: a command or save only compiles what changed and updates the preview, and the design's health runs the type check, lint and page render once, on the latest draft |
| `STUDIO_REGISTRY_SCOPES` | none | npm scopes sandboxes resolve from the registry too |
| `STUDIO_NPM_REGISTRY`, `STUDIO_CODEARTIFACT_DOMAIN`, `STUDIO_CODEARTIFACT_OWNER` | Verdaccio on the host | Where sandboxes install packages; they have no internet |
| `STUDIO_WORKSPACES` | `docker` | `docker` locally, `agentcore` for AgentCore Code Interpreter |
| `STUDIO_BROWSERS` | `local` | `local` Chromium, or `agentcore` for AgentCore Browser |
| `STUDIO_SANDBOX_IMAGE` | `kaboo-studio/sandbox:local` | The Docker image built from `toolchain/` |
| `STUDIO_PREVIEW_ORIGIN`, `STUDIO_PREVIEW_PARENT_ORIGINS`, `STUDIO_PREVIEW_SECRET` | local | The preview app's origin, the pages that may frame it, and the token secret |
| `STUDIO_INTERNAL_KEY` | none | The key internal callers present |
| `STUDIO_METRICS` | `off` | `emf` writes stage timings (`StageDuration` by `Stage`) as CloudWatch embedded metric format lines on stdout. Stages include `sync`, `diagnose`, `health-render`, `screenshot` and each toolchain phase (`toolchain-types`, `toolchain-lint`, `toolchain-compile`, …) |
| `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT` | | Postgres (the `studio` schema) and Redis |

## Running it

```bash
# the studio schema
DATABASE_URL=postgres://... npx kaboo-studio-migrate

# the sandbox image
docker build -t kaboo-studio/sandbox:local node_modules/@pgege/kaboo-studio/toolchain
```

Serve `dist/preview/` (`@pgege/kaboo-studio/preview/index.html` and its
`_runtime/` assets) from the preview origin under `/_preview/`, and route
`/_studio/` on that origin to the studio.

## Developing

```bash
yarn install
yarn build          # Prisma client, tsc, the contract's schema, the preview bundle
yarn test           # engine, contract and preview tests
yarn test:contract  # the sandbox and browser providers, against Docker and Chromium
yarn lint && yarn typecheck
```

## License

MIT
