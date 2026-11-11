import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth } from '../lib/auth.js'
import { Role } from '@baseworks/org/events'
import { StoreError, type Principal, type Store } from '../store.js'

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

const CredentialBody = z.object({
  kind: z.enum(['session', 'token', 'org_key']),
  scopes: z.array(z.enum(['read', 'write'])).optional(),
  role: Role.optional(),
})

/**
 * The PDP over HTTP.
 *
 *   GET  /authz/role          the role a person holds at a scope
 *   POST /authz/check         one action: allowed or not, and why not
 *   POST /authz/permissions   every action of an app this principal may do here
 *
 * `permissions` is what a service normally uses: it asks once per person and
 * organization, keeps the answer briefly, and tests it locally with `can()`.
 * `check` is the same decision for one action.
 *
 * **Who the question is about is decided here, not taken on trust.**
 *
 *  · From a person's own token the question is about that person, holding
 *    their session. They may not name somebody else, and they may not describe
 *    their own credential — otherwise anyone signed in could walk the realm
 *    asking who holds what role where, or call a read-only key a session.
 *  · A service may ask about the person it is serving (`user_id`), and say
 *    what that person presented (`credential`), because it is the one that
 *    verified it. It may ask about an organization's key (`credential.kind:
 *    org_key`, with the key's `role`). With neither, it is asking about
 *    itself, and gets only what an app named it for.
 */
export function authzRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  type Caller = { userId: string; tokenType?: string }
  type Asked = { user_id?: string | undefined; credential?: z.infer<typeof CredentialBody> | undefined }

  /** The user a role question is about, or null when this caller may not ask about them. */
  function subject(auth: Caller, named: string | undefined): string | null {
    if (!named || named === auth.userId) return auth.userId
    return auth.tokenType === 'service' ? named : null
  }

  /** Who a decision is about, or the reason this caller may not ask that. */
  function principal(auth: Caller, asked: Asked): Principal | { refused: string; status: 400 | 403 } {
    if (auth.tokenType !== 'service') {
      if (asked.user_id && asked.user_id !== auth.userId) return { refused: 'Only a service may ask about another user', status: 403 }
      if (asked.credential && asked.credential.kind !== 'session') return { refused: 'Only a service may describe a credential', status: 403 }
      if (asked.credential?.scopes || asked.credential?.role) return { refused: 'Only a service may describe a credential', status: 403 }
      return { kind: 'person', userId: auth.userId, credential: { kind: 'session' } }
    }
    if (asked.credential?.kind === 'org_key') {
      if (!asked.credential.role) return { refused: 'An org_key needs the role it acts with', status: 400 }
      return { kind: 'key', credential: asked.credential }
    }
    if (asked.user_id) return { kind: 'person', userId: asked.user_id, credential: asked.credential ?? { kind: 'session' } }
    if (asked.credential) return { refused: 'A credential is somebody\'s: name the user_id it belongs to', status: 400 }
    return { kind: 'service', identity: auth.userId }
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
        credential: CredentialBody.optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const who = principal(c.get('auth'), input)
      if ('refused' in who) return c.json({ error: who.status === 403 ? 'forbidden' : 'bad_request', message: who.refused }, who.status)
      const res = await store.check({ app: input.app, action: input.action, scopeId: input.scope_id, principal: who }).catch(fail)
      return c.json(res)
    },
  )

  app.post(
    '/authz/permissions',
    zValidator(
      'json',
      z.object({
        app: z.string().min(1),
        scope_id: z.string().min(1),
        user_id: z.string().optional(),
        credential: CredentialBody.optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const who = principal(c.get('auth'), input)
      if ('refused' in who) return c.json({ error: who.status === 403 ? 'forbidden' : 'bad_request', message: who.refused }, who.status)
      const res = await store.permissions({ app: input.app, scopeId: input.scope_id, principal: who }).catch(fail)
      return c.json(res)
    },
  )

  return app
}
