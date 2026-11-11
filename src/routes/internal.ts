import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Role } from '@baseworks/org/events'
import { requireAuth } from '../lib/auth.js'
import { StoreError, type Store } from '../store.js'

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/**
 * Who may register (or change) the manifest of the app called `name`.
 *
 * **Only the app itself.** The caller must be a service — a token of
 * `type: service`, which only auth-service issues, to a client it knows by a
 * secret — and its identity must be the app's name. A manifest sets what every
 * action of an app asks for, so an app that could register under another's
 * name could lower that app's bar; and a person's token could do the same from
 * a browser. Until 0.11 this route checked nothing but that someone was signed
 * in.
 *
 * `ORG_APP_REGISTRARS=flect:flect-api,quillpath:quillpath-api` names the
 * service identity that speaks for an app when the two are not spelled the
 * same (flect's broker signs in as `flect-api` and registers `flect`).
 *
 * The proof of identity is the token today. When the platform gives services
 * certificates (mTLS, clave #163) the proof changes and this rule does not:
 * `caller` is whatever the realm says the calling service is.
 */
export function mayRegisterApp(name: string, caller: { userId: string; tokenType?: string }, env: Record<string, string | undefined> = process.env): boolean {
  if (caller.tokenType !== 'service') return false
  if (caller.userId === name) return true
  for (const entry of (env['ORG_APP_REGISTRARS'] ?? '').split(',')) {
    const [app, identity] = entry.split(':').map((part) => part.trim())
    if (app === name && identity && identity === caller.userId) return true
  }
  return false
}

/** What one action asks for: a least role alone (`"admin"`), or the whole of it. */
const ActionSpec = z.union([
  Role,
  z.object({
    min_role: Role,
    access: z.enum(['read', 'write']).optional(),
    requires: z.enum(['person', 'session']).optional(),
    // A service identity is a client id: no commas, because the list is stored as one string.
    services: z.array(z.string().min(1).regex(/^[^,\s]+$/)).optional(),
  }).strict(),
])
const Manifest = z.object({ name: z.string().min(1), origin: z.string().min(1), actions: z.record(ActionSpec) })

/**
 * Routes for other services on the same network, and for nobody else.
 *
 * Mounted under **`/_`** and never under `/api`. A gateway publishes `/api`
 * (at `/v1/org`) and `/ui` (at `/org`); nothing is ever mapped to `/_`, so a
 * route here cannot be reached from outside whatever a deployment's rules say
 * (workspace ADR 0003). The network is not the whole defence, though — a
 * neighbour on it is not automatically a friend — so each route also checks
 * who is calling.
 */
export function internalRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  /**
   * Every organization. Service tokens only: this is not a user surface. The
   * calling service (a platform panel, for one) checks its own operator's
   * right on its side and uses this as the list to work from.
   */
  app.get('/all-orgs', async (c) => {
    const auth = c.get('auth')
    if (auth.tokenType !== 'service') return c.json({ error: 'forbidden' }, 403)
    return c.json({ orgs: await store.listAllOrgs() })
  })

  /**
   * An app declares its actions and what each one asks for. Called by the app
   * at boot, idempotently. The manifest is authoritative for the app's own
   * rules: what it changed is updated, what it dropped is removed.
   */
  app.post(
    '/apps/register',
    zValidator('json', Manifest),
    async (c) => {
      const auth = c.get('auth')
      const manifest = c.req.valid('json')
      if (!mayRegisterApp(manifest.name, auth)) {
        return c.json({ error: 'forbidden', message: `Only the app itself may register "${manifest.name}"` }, 403)
      }
      const registered = await store.registerManifest(manifest, auth.userId).catch(fail)
      return c.json({ app: registered }, 201)
    },
  )

  return app
}
