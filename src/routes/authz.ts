import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth } from '../lib/auth.js'
import { StoreError, type Store } from '../store.js'

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/**
 * The PDP over HTTP. `role` resolves the effective role at a scope (org role,
 * inherited downward); `check` is the deny-by-default decision. Any authenticated
 * caller may ask; the target user defaults to the caller.
 */
export function authzRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  app.get('/authz/role', async (c) => {
    const scopeId = c.req.query('scope')
    if (!scopeId) return c.json({ error: 'scope required' }, 400)
    const userId = c.req.query('user') ?? c.get('auth').userId
    const eff = await store.effectiveRole(userId, scopeId).catch(fail)
    return c.json(eff)
  })

  app.post(
    '/authz/check',
    zValidator(
      'json',
      z.object({
        app: z.string().min(1),
        action: z.string().min(1),
        scope_id: z.string().min(1),
        user_id: z.string().optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const userId = input.user_id ?? c.get('auth').userId
      const res = await store
        .check({ app: input.app, action: input.action, scopeId: input.scope_id, userId })
        .catch(fail)
      return c.json(res)
    },
  )

  return app
}
