import { Hono } from 'hono'
import { requireAuth } from '../lib/auth.js'
import type { Store } from '../store.js'

/**
 * Routes for other services on the same network, and for nobody else.
 *
 * These are mounted at the service root and NOT under `/api`. A gateway
 * publishes `/api` (at `/v1/org`) and, when there are pages, `/ui` (at `/org`);
 * no rule maps anything to the root, so a route here cannot be reached from
 * outside whatever a deployment's rules say (workspace ADR 0003 §1). Until this
 * service's root API mount is retired the root is still published by gateways
 * that strip `/v1/org`, and those deny `/all-orgs` by hand; the token check
 * below is what actually guards it either way.
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

  return app
}
