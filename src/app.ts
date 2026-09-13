import { Hono } from 'hono'
import type { FoldBase } from '@baseworks/foldbase'
import { PROJECTIONS, POLICIES } from '@baseworks/org/projections'
import { orgsRouter } from './routes/orgs.js'
import { scopesRouter } from './routes/scopes.js'
import { authzRouter } from './routes/authz.js'
import { appsRouter } from './routes/apps.js'
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

  // What this service is and what contract it speaks. Unauthenticated: it holds
  // no secrets, and its readers include the gateway and signed-out clients.
  app.get('/.well-known/service', (c) =>
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
          'scopes',
          'pdp',
          // Deliberately absent: `invitations`. The client package defines the
          // surface but this service has no routes for it, so a consumer must
          // not branch as though it were there.
        ],
      }),
    ),
  )

  // The contract itself, served from the repo file so document and code ship
  // together and cannot drift apart between releases.
  app.get('/openapi.yaml', (c) => {
    try {
      const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')
      return c.body(spec, 200, { 'content-type': 'application/yaml; charset=utf-8' })
    } catch {
      return c.json({ error: 'spec not bundled with this build' }, 404)
    }
  })

  // Routes live at the service ROOT: `/orgs`, `/authz`, `/apps`. A gateway
  // publishes the realm at `/v1/org/...` and strips that prefix, so the service
  // never encodes where it happens to be mounted. Until now the prefixes were
  // inconsistent anyway — `/v1/orgs` but `/authz` and `/apps` — which meant
  // every new caller had to be told which was which.
  const routers = [orgsRouter(store), scopesRouter(store), authzRouter(store), appsRouter(store)]
  for (const r of routers) app.route('/', r)

  // Legacy mount. Callers still using `/v1/orgs` keep working, including the
  // published @baseworks/org client and anything pointed straight at the
  // service. Remove once every consumer is on the gateway path.
  for (const r of routers) app.route('/v1', r)

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
