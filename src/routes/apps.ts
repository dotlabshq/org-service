import { Hono } from 'hono'
import { requireAuth } from '../lib/auth.js'
import type { Store } from '../store.js'

/**
 * The app registry, read side: which apps have declared their actions, and
 * what each action asks for. Registering is not here — it is an internal
 * route (`/_/apps/register`, routes/internal.ts), because only the app itself
 * may do it and no person or gateway has any business reaching it.
 */
export function appsRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  app.get('/apps', async (c) => c.json({ apps: await store.listApps() }))

  app.get('/apps/:name/policies', async (c) => {
    return c.json({ policies: await store.listPolicies(c.req.param('name')) })
  })

  return app
}
