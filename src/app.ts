import { Hono } from 'hono'
import type { FoldBase } from '@baseworks/foldbase'
import { PROJECTIONS, POLICIES } from '@baseworks/org/projections'
import { orgsRouter } from './routes/orgs.js'
import { scopesRouter } from './routes/scopes.js'
import { authzRouter } from './routes/authz.js'
import { appsRouter } from './routes/apps.js'
import { StoreError, createStore } from './store.js'

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
  app.route('/', orgsRouter(store))
  app.route('/', scopesRouter(store))
  app.route('/', authzRouter(store))
  app.route('/', appsRouter(store))

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
