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
 * inherited downward); `check` decides one action.
 *
 * **A person asks about themselves.** `user` / `user_id` naming somebody else
 * is honoured only for a service token: a product's backend asks about the
 * person whose request it is handling. From a person's own token it is
 * refused — otherwise anyone signed in could walk the realm asking who holds
 * what role where, one user id at a time.
 */
export function authzRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  /** The user a question is about, or null when this caller may not ask about them. */
  function subject(auth: { userId: string; tokenType?: string }, named: string | undefined): string | null {
    if (!named || named === auth.userId) return auth.userId
    return auth.tokenType === 'service' ? named : null
  }

  app.get('/authz/role', async (c) => {
    const scopeId = c.req.query('scope')
    if (!scopeId) return c.json({ error: 'scope required' }, 400)
    const userId = subject(c.get('auth'), c.req.query('user'))
    if (!userId) return c.json({ error: 'forbidden', message: 'Only a service may ask about another user' }, 403)
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
      const userId = subject(c.get('auth'), input.user_id)
      if (!userId) return c.json({ error: 'forbidden', message: 'Only a service may ask about another user' }, 403)
      const res = await store
        .check({ app: input.app, action: input.action, scopeId: input.scope_id, userId })
        .catch(fail)
      return c.json(res)
    },
  )

  return app
}
