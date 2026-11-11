import { Hono, type Context } from 'hono'
import type { FoldBase } from '@baseworks/foldbase'
import { PROJECTIONS, POLICIES } from '@baseworks/org/projections'
import { orgsRouter } from './routes/orgs.js'
import { scopesRouter } from './routes/scopes.js'
import { authzRouter } from './routes/authz.js'
import { appsRouter } from './routes/apps.js'
import { internalRouter } from './routes/internal.js'
import { StoreError, createStore } from './store.js'
import { serviceManifest } from '@baseworks/core/service'
import { readFileSync } from 'node:fs'

// Read once: the release is a build-time fact, and re-reading it per request
// would turn a manifest fetch into disk I/O.
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
      { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Register read models + policies on boot (idempotent, like migrations). */
export async function registerDefinitions(fb: FoldBase): Promise<void> {
  for (const p of PROJECTIONS) await fb.putProjection(p.def)
  for (const p of POLICIES) await fb.putPolicy(p)
}

/** Build the org-service Hono app over a foldbase client. */
export function createApp(fb: FoldBase): Hono {
  const store = createStore(fb)
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true, service: 'org-service' }))

  // Three mounts (workspace ADR 0003):
  //
  //   /api   the API — what a gateway publishes at `/v1/org`, replacing the
  //          prefix. Discovery and the contract are part of it.
  //   /ui    pages — none yet; published at `/org` when there are.
  //   /      not published: `/healthz` and the internal routes.
  //
  // The service never encodes where it is published or under which version.
  const api = new Hono()

  // What this service is and what contract it speaks. Unauthenticated: it holds
  // no secrets, and its readers include the gateway and signed-out clients.
  const manifest = (c: Context) =>
    c.json(
      serviceManifest({
        name: 'org',
        version: VERSION,
        // Moves only when the HTTP surface breaks callers, not every release.
        api_version: '1.0',
        openapi_url: '/openapi.yaml',
        capabilities: [
          'orgs',
          'members',
          'invitations',
          'scopes',
          'pdp',
        ],
      }),
    )

  // The contract itself, served from the repo file so document and code ship
  // together and cannot drift apart between releases.
  const contract = (c: Context) => {
    try {
      const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')
      return c.body(spec, 200, { 'content-type': 'application/yaml; charset=utf-8' })
    } catch {
      return c.json({ error: 'spec not bundled with this build' }, 404)
    }
  }

  api.get('/.well-known/service', manifest)
  api.get('/openapi.yaml', contract)

  const routers = [orgsRouter(store), scopesRouter(store), authzRouter(store), appsRouter(store)]
  for (const r of routers) api.route('/', r)
  app.route('/api', api)

  // Internal: at the root only, never under `/api`.
  const internal = internalRouter(store)

  // ── Until every direct caller names `/api` ──────────────────────────────
  // The API used to be mounted at the root, and before that under `/v1`. Both
  // stay for now: seven product services, the flect broker and clave reach
  // this service on its own address and ask the root (`/authz/role`), and the
  // published @baseworks/org client is pointed at whatever base it is given.
  // A gateway that still strips `/v1/org` also lands here. Removing these two
  // mounts is the next step, and it is the breaking one.
  app.get('/.well-known/service', manifest)
  app.get('/openapi.yaml', contract)
  for (const r of routers) app.route('/', r)
  for (const r of routers) app.route('/v1', r)
  // `/v1/all-orgs` is what callers that predate the root mount still ask for.
  app.route('/v1', internal)
  app.route('/', internal)

  app.onError((err, c) => {
    if (err instanceof StoreError) return c.json({ error: err.code, message: err.message }, err.status as never)
    const status = (err as { status?: number }).status
    if (typeof status === 'number' && status >= 400 && status < 600) {
      return c.json({ error: (err as { code?: string }).code ?? 'error', message: err.message }, status as never)
    }
    console.error(err)
    return c.json({ error: 'internal', message: 'Internal server error' }, 500)
  })

  return app
}
