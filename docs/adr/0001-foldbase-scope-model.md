# ADR 0001 — org-service on foldbase, scope model, client + SDK split

**Status:** accepted · **Date:** 2026-07-15 · **Owner:** Arc (delegated build)

## Context

`org-service` managed the organization / workspace / project / environment
hierarchy over a direct DB (drizzle + libsql/pg), with one table per level and
FK `ON DELETE CASCADE`. We are standardizing incubating backend services on
**foldbase** (append-only event log + folded read models + one policy-gated
query endpoint, deployed as a private sibling per app). The founder also wants
org to become a reusable capability: any app that installs the org CLI plugin
and the SDK gets `cmd org ls`, `cmd org create`, etc. This ADR records the
decisions for that migration.

Backward compatibility is explicitly out of scope: consumers that break
(orbseal, driptab, account-service, iam-service, clave CLI) will migrate under
their own minor-version bumps. This is a clean refactor, not a compat shim.

## Decisions

1. **Storage is foldbase.** org-service holds a foldbase service token and talks
   to its own foldbase sibling. No direct DB access, no drizzle in the service.
   Projections and policies are registered on the service's own boot
   (idempotent, like migrations), mirroring `examples/taskboard-web`.

2. **Tenant = `platform` (fixed).** Unlike other capability services (iam,
   billing) where `tenant = org id`, org-service *manufactures* orgs and its
   core query ("which orgs does this user belong to") is inherently cross-org.
   Org ids are therefore read-model keys, not foldbase tenants. The service
   pins `X-Tenant-ID: platform`.

3. **Single `scope` aggregate.** Workspace / project / environment collapse into
   one aggregate keyed by `kind: workspace|project|environment` with a
   `parentId` (workspace→org, project→workspace, environment→project). Adding a
   new level later is an enum value, not a migration. Adapted from flect's
   control-plane scope model (RFC-0014). Aggregates: `org`, `scope`,
   `membership`.

4. **The service is the authorization layer.** foldbase's query endpoint is
   single-model and cannot express "user is a member of this org" (a join). So
   org-service enforces membership/role checks in its handlers and composes the
   "join" itself: query `read_org_members` by `user_id`, collect org ids, then
   query `read_orgs`. foldbase row policies are permissive for the service's own
   `admin` identity; end-user scoping lives in the service.

5. **Delete → subtree archive.** Deleting an org/workspace/project emits
   `*Archived` to the target and walks children (by `parent_id`) emitting
   `ScopeArchived`. The read-model rows are removed (UX matches the old hard
   delete) but **the events persist** — the durable audit trail that FK cascade
   destroyed. A real purge, if ever needed, is a separate admin operation.

6. **Updates carry a full snapshot of mutable fields.** To keep folds
   declarative (no partial-column null-wipe), `OrgUpdated` / `ScopeUpdated`
   carry the complete post-update field set; the service reads current state
   (it already resolves the ref) and merges before emitting. Metadata is a JSON
   string column merged in the service.

7. **Slug uniqueness is scoped and check-then-emit.** Uniqueness is enforced per
   `(org, parentId, kind)` by querying the read model before appending. The
   service is single-instance per deploy, so the check-then-emit race window is
   accepted and documented here rather than enforced structurally.

8. **One capability package + one SDK.**
   - `@baseworks/org` (in `projects/org-service/clients/ts`) — the whole org
     capability as one versioned unit (foldbase's co-located pattern): the typed
     zod-only HTTP **client** (root export), the shared **event catalog**
     (`/events`), **projection definitions** (`/projections`), and the **CLI
     plugin** (`/cli`). It replaces `@baseworks/organization` (which dropped its
     drizzle schema/repo). Legacy consumers stay pinned to the published
     `@baseworks/organization@0.2.1` until they migrate.
   - `@baseworks/sdk` (`packages/lib/sdk`, zod + fetch only) — the single
     runtime binding surface. `createEnv({ services?, token?, require?, source? })`
     unifies infrastructure bindings and capability services: `env.service(name)`
     resolves an HTTP sibling to a typed client (`'foldbase'` → `FoldBase`,
     `'org'` → `OrgClient`, later iam/billing) via a capability registry;
     `env.db(name)` / `env.storage(name)` resolve driver bindings (descriptor
     only — the caller builds the driver, keeping the lib DB-free); `env.var`
     reads plain config. Resolution per name, lazy (only throws on first use, or
     eagerly via `require`): `services[name]` → `<NAME>_SERVICE_URL` /
     `<NAME>_URL` → `BASEWORKS_GATEWAY`+`/<name>` → unconfigured. Resolution is
     pluggable through an `EnvSource` (env vars today; a flect manifest or
     Consul/DNS source drops in without touching call sites) — the SDK never
     talks to Consul itself; discovery is the platform's job (Nomad + Traefik +
     Consul inject `BASEWORKS_GATEWAY` at deploy). This is flect's binding model:
     a logical name resolves to a re-pointable address, app code unchanged.
   - `createEnv` supersedes the earlier `createBaseworks` sketch and replaces
     flect-sdk's `createEnv` for org-service (migrations become projection
     registration; libsql disappears; the DB binding is gone).

## Consequences

- The org REST surface is preserved verbatim, so the CLI plugin and its tests
  are unaffected by the storage change.
- Cross-org listing is cheap (two indexed read-model queries); no central
  foldbase instance is shared.
- Consumers of the old drizzle schema/repo break and migrate separately (see
  the migration follow-ups in the delivery report).
