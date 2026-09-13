# org-service

Organisations, membership, the scope tree (`org → workspace → project → env`),
and the policy decision point that answers *may this user do this here?*

Identity is not this service's job. A realm token carries `sub` and `type` and
nothing else; **roles live here**, and a caller asks for them.

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

### Acting as a service

A service that must add or remove members does so **as itself**, after being
named in `ORG_MEMBERSHIP_WRITERS`:

```bash
curl -sX POST https://example.com/v1/org/orgs/acme/members \
  -H "authorization: Bearer $SERVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"userId":"usr_1","role":"member"}'
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

Full contract: [`openapi.yaml`](./openapi.yaml), served at `/openapi.yaml`.

Routes live at the service **root**. A gateway publishes the service at
`/v1/org/...` and strips that prefix, so `/orgs` here is
`https://<host>/v1/org/orgs` in public. The old `/v1/orgs` paths are still
served for callers that predate the gateway and will be removed.

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

- **Invitations are half-built.** `@baseworks/org` defines the events, the
  projection and client methods for `/invitations`, but this service has **no
  routes for them** — a caller reaching for that surface gets 404. The read
  model is registered and stays empty. Either the routes were never written or
  they were lost; the client half survived because it was published to npm and
  the service ships as an image. Consumers currently keep their own invite
  table, which is why the manifest does not advertise an `invitations`
  capability.
- **No pagination.** `listOrgs`, `listMembers` and `/all-orgs` return
  everything. Fine at current sizes, not forever.
- **Last-owner protection is not enforced.** Nothing stops the final `owner`
  from being removed, leaving an organisation nobody can administer.

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
