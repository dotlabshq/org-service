# org-service

Organisations, membership, the scope tree (`org → workspace → project → env`),
and the policy decision point that answers *may this user do this here?*

Identity is not this service's job. A realm token carries `sub` and `type` and
nothing else; **roles live here**, and a caller asks for them.

**In the local realm:** port 3006, published by the gateway at `/v1/org`.

**Where it stands (0.9.0, 2026-11-11).** org is moving onto the workspace's
four-layer layout ([ADR 0003](../../docs/adr/0003-service-surfaces.md)), one
safe step at a time:

| Layer | State |
|---|---|
| **api** | Mounted under `/api` as of 0.9.0. The root and `/v1` mounts remain for callers that reach the service directly; they are removed in a later release |
| **ui** | No pages and no screens package yet. The organization screen is still inside the console (`apps/console`). Planned: pages under `/ui` for accepting an invitation and for choosing or creating an organization; screens in `@baseworks/org/ui` |
| **cli** | `@baseworks/org/cli`, mounted by `bw` |
| **mcp** | None yet. Planned: `@baseworks/org/mcp`, tool definitions an application adds to its own MCP server |
From the workspace root: `just start org` · `just logs org` · `just restart org`.
See the workspace [README](../../README.md) for the whole map and
[AGENTS.md](../../AGENTS.md) for the rules every service here follows.

## Using it from your app

### The typed client

```
npm i @baseworks/org
```

```ts
import { OrgClient } from '@baseworks/org'

const org = new OrgClient({
  baseUrl: 'https://example.com/v1/org',
  token: userToken,          // the realm token, forwarded as-is
})

const orgs = await org.listOrgs()          // the caller's own memberships
const acme = await org.getOrg('acme')      // 404 if they are not a member
```

Forward the **user's** token rather than acting as yourself. Membership and role
are then decided here, from the identity that actually made the request, and
your service does not have to reimplement the rules.

### Resolving the active organisation

A token deliberately carries no organisation. The pattern every consumer uses:

```ts
const memberships = await org.listOrgs()               // cache ~30s per token
const requested = req.header('X-Org-Id')               // the client's intent
const active = requested
  ? memberships.find((o) => o.id === requested || o.slug === requested)
  : memberships.length === 1 ? memberships[0] : undefined

if (!active) throw forbidden('not a member of that organisation')
```

The header is the client's *intent*, never authority. Verify it against
membership on every request; a cache of a minute is fine and a token that
carried the role would not be.

### Asking whether an action is allowed

```ts
const { allow } = await org.check({
  app: 'zone9', action: 'server.delete', scope_id: activeOrgId,
})
```

Deny by default: an action the app has not registered is refused. Register the
policy once at deploy:

```ts
await org.registerApp({
  name: 'zone9',
  actions: { 'server.delete': 'admin', 'server.create': 'member' },
})
```

### Inviting someone

```ts
await org.createInvitation('acme', { email: 'ada@example.com', role: 'member' })
const pending = await org.listInvitations('acme')          // owner/admin
```

The invitee, signed in as themselves:

```ts
const mine = await org.listMyInvitations()                 // enriched with orgSlug/orgName
await org.acceptInvitation(mine[0].id)                     // → Membership
```

Inviting is idempotent per email: inviting the same person twice leaves one
pending invitation, and inviting them at a different role re-issues rather than
editing, so the event log shows both decisions.

Acceptance is checked against the caller's own email, so an id seen in a log or
a forwarded message is not enough to join an organisation. A mismatch answers
`404`, not `403`, which would confirm the id is real.

### Acting as a service

A service that must add or remove members does so **as itself**, after being
named in `ORG_MEMBERSHIP_WRITERS`:

```bash
curl -sX POST https://example.com/v1/org/orgs/acme/members \
  -H "authorization: Bearer $SERVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"user_id":"usr_1","role":"member"}'
```

If you find yourself wanting to act *as a user* — minting a token with their
subject so the write looks like theirs — stop. That is what this allowance
replaced. The audit trail should name the service, because the service is what
made the call.

## CLI

`@baseworks/org` ships commands any CLI can mount:

```ts
import { buildOrgCommand, addGlobalCommands } from '@baseworks/org/cli'

const deps = { http: orgHttp, ctx, appBase: APP_BASE, cliName: 'mycli' }
addGlobalCommands(program, deps)          // use · ls · ps
program.addCommand(buildOrgCommand(deps)) // org ls|create|get|update|delete
```

```
$ mycli org

  ID      SLUG     NAME     ROLE
  ──────  ───────  ───────  ──────
  cnw8jp  acme     Acme     owner

$ mycli use acme
✓ Active scope: acme
```

The active scope is stored client-side and sent per request. It selects, it does
not grant: this service checks membership every time.

## Field naming

Bodies are `snake_case` (ADR-043), request and response alike: `short_id`,
`user_id`, `created_at`. They match the underlying row names exactly, so the
serializers no longer rename anything and a field added to a projection reaches
the body on its own rather than waiting to be remembered.

TypeScript variables stay camelCase — this is a contract decision, not a code
style one.

**This changed in `@baseworks/org` 1.0.0.** A consumer on 0.x reads `shortId`
and `organizationId`; both are gone.

## Configuration

| Variable | Meaning |
|---|---|
| `AUTH_JWKS_URI` | Realm key set, for verifying tokens |
| `AUTH_ISSUER` · `AUTH_AUDIENCE` | Expected `iss` / `aud`. Set both in production |
| `JWT_SECRET` | Legacy HS256, accepted while set. Remove once the realm is on ES256 |
| `ORG_MEMBERSHIP_WRITERS` | `svc-a,svc-b` — services that may write memberships. Empty means none |
| `ORG_ALLOW_SLUG_CHANGE` | `true` lets slugs be renamed. Only for a realm where nothing derives names from them |
| `FOLDBASE_*` | Event store connection |

## Endpoints

Full contract: [`openapi.yaml`](./openapi.yaml), served at `/api/openapi.yaml`
(published: `/v1/org/openapi.yaml`).

The API is mounted under **`/api`**. A gateway publishes it at `/v1/org/...`,
replacing the prefix, so `/api/orgs` in the service is
`https://<host>/v1/org/orgs` in public. The service never names `/v1` or its
own published path; the version belongs to the gateway.

```toml
# flect.toml
expose = [{ path = "/v1/org", to = "/api" }]
```

Three things are **not** under `/api`, on purpose:

- `GET /healthz` — at the root, for the platform and the internal network.
- `GET /all-orgs` — at the root. It hands a service token every organization,
  so it is for services on the same network only. No gateway rule maps
  anything to the root, which is what keeps it unpublished; the service-token
  check is what guards it in any case.
- Pages, when there are some — under `/ui`, published at `/org`.

**Still served, and going away:** the same API at the root (`/orgs`,
`/authz/role`, ...) and under `/v1` (`/v1/orgs`). The product services, the
flect broker and clave call org on its own address and ask the root today; a
gateway that still strips `/v1/org` lands there too. Point a direct caller at
`<ORG_SERVICE_URL>/api` — the `@baseworks/org` client takes whatever base it is
given, so that is a configuration change, not a code change. The root and
`/v1` API mounts are removed once nothing uses them, and that release is the
breaking one.

## Rules worth knowing before you call it

**Absence is not disclosed.** An organisation you are not a member of answers
`404`, never `403`. A `403` confirms it exists, which turns a slug guess into a
membership oracle — whether a given company has an account here leaks one probe
at a time.

**A slug is permanent.** Hostnames, URLs and bookmarks are derived from it
downstream. Renaming breaks them silently, in another system, with nothing here
to show for it. Display names rename freely; a patch that moves both is refused
whole rather than half-applied.

**`/all-orgs` is service-only and must stay off the public gateway.** A wildcard
route that catches it puts a service token between the internet and the entire
customer list.

## Known gaps

- **Invitee endpoints need the caller's email.** A realm token deliberately
  carries none, so `GET /invitations` and accepting resolve it from
  iam-service (`IAM_SERVICE_URL`), or from an `email` claim if this realm's
  tokens have one. With neither, those two endpoints answer `409
  email_unavailable` rather than an empty list — "you have no invitations" would
  be a lie when the truth is "this service cannot tell".
- **No expiry on invitations.** A pending invitation stays valid until it is
  accepted, declined or revoked.
- **No pagination.** `listOrgs`, `listMembers` and `/all-orgs` return
  everything. Fine at current sizes, not forever.

## An organisation always keeps an owner

Owner is the only role that can grant owner, so an organisation that loses its
last one is locked: nobody remaining can invite, promote, or delete it. Every
path that could do it answers `409 last_owner` — removing that member, changing
their role, and `POST /members`, which re-grades somebody who is already in and
would otherwise be the same act by another door.

The rule lives in the store rather than in the routes, because that is the one
place all three of them pass through.

## Who a member is

`GET /orgs/{ref}/members` carries `email` and `name` alongside the role. The
membership is what this service owns; the person is iam's, and copying an
address here would mean holding one that goes stale the moment somebody changes
it. So the two are joined on the way out, in one batch call to iam's
`/users/resolve` rather than one call per member.

It is an enrichment, never a requirement. Without `IAM_SERVICE_URL`, or with
iam unreachable, the list is the same list without the names — losing the roles
and the count because the names are unavailable would be the wrong trade.

## Development

```
pnpm dev     # tsx watch
pnpm test    # vitest, against a real foldbase
pnpm build
```

Build the image from the monorepo root:

```
podman build -f projects/org-service/Dockerfile.workspace -t org-service:<tag> .
```
