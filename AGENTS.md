# AGENTS.md — org-service (the capability-service reference)

Operating manual for AI agents. Point a new session here to understand how a
**baseworks capability service** is built and consumed. org-service is the
reference implementation; iam-service / billing copy this shape.
Companion: [docs/adr/0001-foldbase-scope-model.md](./docs/adr/0001-foldbase-scope-model.md).

## What this is

The organization capability: orgs, workspaces, projects, environments,
memberships, **and the PDP** (access decisions + app policies). It is a
**foldbase-backed capability service** — no direct DB. It holds a foldbase
service token, registers its read models on boot (idempotent, like migrations),
and enforces authz + composes cross-model "joins" in-app (foldbase rule 2: no
domain logic in folds).

The PDP lives here (not in iam) because deciding "may user U do action A at
scope S" needs the scope tree + roles + inheritance — all of which org owns. A
user has no org of their own, only memberships, so every role question is an org
question. iam is identity + credentials only; it never answers authz.

Deploy model: a lego piece. Any app that installs `@baseworks/sdk` +
`@baseworks/org` gains the org capability in one line — `env.service('org')`.

## Layers and mounts (workspace ADR 0003)

A capability is **api, ui, cli and mcp**, and this repository owns all four.
Inside the process: **`/api`** for the API (published at `/v1/org`), **`/ui`**
for pages (published at `/org`), and a **root that is not published**
(`/healthz`, internal routes such as `/all-orgs`).

- A new endpoint goes in a router mounted under `/api`, and in `openapi.yaml`.
- **A page is a client of the API.** `src/routes/pages.ts` fetches through `api`
  with the person's token and `src/pages/org.ts` draws the answer. Never read
  the store from a page, and never put a permission rule in one: the rule goes
  in the API route, where a product calling the API meets it too.
- A new screen: a function in `src/pages/org.ts`, a route in
  `src/routes/pages.ts`, its sentences in `src/pages/strings.ts` in **every**
  language there. The frame and stylesheet are `@baseworks/core/pages`, shared
  with auth-service; change the look there.
- Products do not write organization screens. If one needs something these
  pages lack, it is added here.
- A route meant only for other services goes in `src/routes/internal.ts`,
  mounted at the root and never under `/api`.
- Never write `/v1` or `/org` in service code. Where the gateway publishes the
  service is configuration.
- The root and `/v1` API mounts in `src/app.ts` are legacy, kept for direct
  callers. Do not add to them, and do not remove them in passing: the product
  services, the flect broker and clave ask the root today.
- Where each layer stands is in the README, at the top.

## The three packages

| Package | Location | Role |
|---|---|---|
| `@dotlabshq/org-service` | `projects/org-service` | the HTTP service (server) |
| `@baseworks/org` | `projects/org-service/clients/ts` | consumer-facing unit: `.` client · `/events` catalog · `/projections` · `/cli` plugin |
| `@baseworks/sdk` | `packages/lib/sdk` | `createEnv()` binding surface (shared by all services) |

`@baseworks/org` co-locates client + contract (foldbase pattern). It replaced
`@baseworks/organization` (removed; drizzle schema/repo dropped). Legacy
consumers stay pinned to the published `@baseworks/organization@0.2.1` until
migrated.

## createEnv — the binding surface (`@baseworks/sdk`)

One entry point resolves both infrastructure bindings and capability services:

```ts
import { createEnv } from '@baseworks/sdk'
const env = createEnv()

env.service('foldbase')   // → FoldBase client (own sibling; tenant from FOLDBASE_TENANT)
env.service('org')        // → OrgClient (URL from ORG_SERVICE_URL / gateway)
env.db('DB')              // → driver-binding descriptor (caller builds the driver)
env.var('PORT')           // → string | undefined
env.require(['foldbase']) // boot fail-fast
```

Resolution per name, lazy (only throws on first use): `services[name]` →
`<NAME>_SERVICE_URL` / `<NAME>_URL` → `BASEWORKS_GATEWAY/<name>` → unconfigured.
Pluggable `EnvSource` (env vars now; flect manifest / Consul / DNS later — app
code unchanged). This is flect's binding model. The SDK never talks to Consul;
discovery is the platform's job (Nomad + Traefik + Consul inject
`BASEWORKS_GATEWAY` at deploy).

Capabilities are typed via a registry in `@baseworks/sdk` (`registry.ts`) — add
`iam`/`billing` there mapping name → client factory.

## Consuming org from another app (e.g. driptab)

```ts
import { createEnv } from '@baseworks/sdk'
const env = createEnv()
const org = env.service('org')

const orgs = await org.withAuth({ uid: user.id }).listOrgs()
const ws   = await org.withAuth({ uid: user.id }).createWorkspace('acme', { name: 'main' })

// PDP — apps register a manifest at boot, then ask before acting:
await org.registerApp({ name: 'driptab', origin: 'https://driptab.app', actions: { 'invoice.void': 'admin' } })
const { allowed } = await org.withAuth({ uid: user.id }).check({ app: 'driptab', action: 'invoice.void', scopeId })
```

CLI (`cmd org ls`, `cmd ws`, `cmd proj`, `cmd use`, plus the PDP: `cmd access role
<scope>`, `cmd access check <app> <action> <scope>`, `cmd access app list`) in any
app:

```ts
import { orgCommand } from '@baseworks/org/cli'
program.addCommand(orgCommand({ http: env.service('org').http, ctx, cliName: 'cmd' }))
```

`shortId` is a first-class ref everywhere (CLI ergonomics): every get/patch/
delete resolves by **slug OR shortId**.

## Architecture (how the server works)

- **Aggregates** (`@baseworks/org/events`): `org`, `scope`
  (`kind: workspace|project|environment`, `parentId`), `membership`, plus the PDP
  pair `app` (AppRegistered/AppOriginChanged) and `app_policy` (PolicySet). One
  scope aggregate replaces separate ws/proj/env tables (flect RFC-0014 scope model).
- **Read models** (`@baseworks/org/projections`): `read_orgs`, `read_scopes`,
  `read_org_members`, `read_apps`, `read_app_policies`. Registered on boot via
  `registerDefinitions(fb)`.
- **store.ts** = the owning-app domain logic: event emit via typed catalogs,
  authz, kind-order + slug-uniqueness checks, and the composed queries foldbase's
  single-model query can't do (e.g. "my orgs" = read_org_members by user →
  read_orgs by id `in`). Deletes = subtree archive (events persist).
- **The PDP** (`store.ts` + `routes/authz.ts`, `routes/apps.ts`):
  - `effectiveRole(user, scope)` — the role a user holds at a scope. Roles live at
    the **org** (membership), inherited downward: a sub-scope's effective role is
    the user's org role. `scope` may be an org id or a ws/proj/env id. v1 has **no
    per-sub-scope grants** — extend the membership model if a consumer needs them.
  - `check(app, action, scope, user)` — deny-by-default: needs a registered policy
    AND `roleAtLeast(effectiveRole, policy.minRole)`. Rank
    `viewer<member<admin<owner`.
  - `registerManifest` inserts defaults only for actions **without** a policy, so
    explicit overrides survive redeploys.
- **routes/** preserve the REST surface (`/v1/orgs…`, `/authz/role`,
  `/authz/check`, `/apps…`) so the CLI is unaffected.

### foldbase gotchas (learned; don't re-hit)
- Read-model spine is `(tenant, id) PK + updated_at` (server-maintained). Never
  declare `updated_at` in a projection (dup-column error). The stream id is the
  `id` column.
- Query is single-model — no joins; compose in the service.
- Tenant: org-service pins `platform` (org ids are read-model keys, not tenants,
  because org-service manufactures orgs). Other capability services use
  **tenant = org id**.

## Standing up a NEW capability service (iam, billing)

1. `projects/<svc>` — Hono service; boot with `createEnv()` + `env.service('foldbase')`.
2. `projects/<svc>/clients/ts` = `@baseworks/<name>` — client `.` + `/events` +
   `/projections` (+ `/cli` if it has one).
3. Register the capability in `@baseworks/sdk` `registry.ts` (name → factory).
4. Tenant = org id (unlike org-service). Register projections/policies on boot.
5. Tests: boot a foldbase Go sibling via `conformance/harness.mjs` `bootServer`,
   unique tenant per test. Auth = Zitadel + Pomerium — do NOT build auth
   primitives; iam wraps Zitadel, it does not replace it.

## Build / test

```bash
# repo's vitest 4 needs Node >=20.12 — use nvm v22
pnpm --filter @baseworks/foldbase build && pnpm --filter @baseworks/org build && pnpm --filter @baseworks/sdk build
pnpm --filter @dotlabshq/org-service test   # 26 — foldbase Go sibling (CRUD + PDP)
pnpm --filter @baseworks/org test           # 61 — CLI (msw)
pnpm --filter @baseworks/sdk test           # 20 — resolution ladder + kv
```

## Deploy

Inject `FOLDBASE_SERVICE_URL` + `FOLDBASE_TOKEN` (+ `BASEWORKS_GATEWAY` if used).
`FOLDBASE_TENANT=platform` is set in `flect.toml`. No DB binding.
