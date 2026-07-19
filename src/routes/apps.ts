import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth } from '../lib/auth.js'
import { Role } from '@baseworks/org/events'
import { StoreError, type Store } from '../store.js'

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/**
 * App registry — apps register a policy manifest (action → minimum role) at
 * boot; the PDP is deny-by-default until a policy exists. Defaults are inserted
 * only for actions without a policy, so explicit admin overrides survive
 * redeploys.
 */
export function appsRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  app.post(
    '/apps/register',
    zValidator('json', z.object({ name: z.string().min(1), origin: z.string().min(1), actions: z.record(Role) })),
    async (c) => {
      const auth = c.get('auth')
      const registered = await store.registerManifest(c.req.valid('json'), auth.userId).catch(fail)
      return c.json({ app: registered }, 201)
    },
  )

  app.get('/apps', async (c) => c.json({ apps: await store.listApps() }))

  app.get('/apps/:name/policies', async (c) => {
    return c.json({ policies: await store.listPolicies(c.req.param('name')) })
  })

  return app
}
