import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { requireOrg } from '../hono.js'
import { mocks, server, TEST_BASE } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const ORG_ID = '01a0f332-ace0-7c81-9321-e95ecadce4d3'
const SCOPE_ID = '01a0f48e-c416-7d70-841e-3c4330767f05'

/** An app with a stand-in for requireAuth, then requireOrg, then one route that reports the context. */
function appWith(auth: { userId: string; tokenType: 'user' | 'service' | 'assistant'; orgId?: string } | null, scope = true) {
  const app = new Hono()
  app.use('*', async (c, next) => { if (auth) c.set('auth', auth); await next() })
  app.use('*', requireOrg({ baseUrl: TEST_BASE, scope }))
  app.get('/whoami', (c) => c.json({ orgId: c.get('orgId'), orgRole: c.get('orgRole'), scopeId: c.get('scopeId') ?? null, bearer: c.get('bearer') }))
  return app
}

const get = (app: Hono, headers: Record<string, string>) =>
  app.request('/whoami', { headers: { Authorization: 'Bearer tok', ...headers } })

describe('requireOrg', () => {
  it('resolves X-Org-Id through the PDP and stores the canonical id, not the header', async () => {
    mocks.mockGet('/authz/role', { role: 'admin', via: { scope_id: ORG_ID, scope_kind: 'org' } })
    const res = await get(appWith({ userId: 'u1', tokenType: 'user' }), { 'X-Org-Id': 'acme' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ orgId: ORG_ID, orgRole: 'admin', scopeId: null, bearer: 'tok' })
  })

  it('400 without the header, 403 for a non-member, 404 for an org that does not exist', async () => {
    const app = appWith({ userId: 'u1', tokenType: 'user' })
    expect((await get(app, {})).status).toBe(400)

    mocks.mockGet('/authz/role', { role: 'none' })
    expect((await get(app, { 'X-Org-Id': 'acme' })).status).toBe(403)

    mocks.mockGet('/authz/role', { error: 'not_found' }, 404)
    expect((await get(app, { 'X-Org-Id': 'ghost' })).status).toBe(404)
  })

  it('a service token names the org by id and skips the membership check', async () => {
    // No PDP handler registered: a call would be an unhandled request and fail the test.
    const res = await get(appWith({ userId: 'svc', tokenType: 'service' }), { 'X-Org-Id': ORG_ID })
    expect(res.status).toBe(200)
    expect((await res.json()).orgRole).toBe('service')
  })

  it('a token narrowed to one org is refused in another, even where its subject is a member', async () => {
    mocks.mockGet('/authz/role', { role: 'member', via: { scope_id: ORG_ID, scope_kind: 'org' } })
    const narrowed = appWith({ userId: 'u1', tokenType: 'assistant', orgId: 'some-other-org' })
    const res = await get(narrowed, { 'X-Org-Id': 'acme' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('org_mismatch')

    const matching = appWith({ userId: 'u1', tokenType: 'assistant', orgId: ORG_ID })
    expect((await get(matching, { 'X-Org-Id': 'acme' })).status).toBe(200)
  })

  it('resolves X-Flect-Scope inside the org by short id; a scope that is not there is 404', async () => {
    mocks.mockGet('/authz/role', { role: 'owner', via: { scope_id: ORG_ID, scope_kind: 'org' } })
    mocks.mockGet(`/orgs/${ORG_ID}/scopes/8gjvdq`, { scope: { id: SCOPE_ID, kind: 'environment', short_id: '8gjvdq' } })
    const app = appWith({ userId: 'u1', tokenType: 'user' })
    const ok = await get(app, { 'X-Org-Id': 'acme', 'X-Flect-Scope': '8gjvdq' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).scopeId).toBe(SCOPE_ID)

    mocks.mockGet(`/orgs/${ORG_ID}/scopes/nope`, { error: 'not_found' }, 404)
    const bad = await get(app, { 'X-Org-Id': 'acme', 'X-Flect-Scope': 'nope' })
    expect(bad.status).toBe(404)
    expect((await bad.json()).error).toBe('scope_not_found')
  })

  it('answers 502, not 403, when the PDP cannot be reached', async () => {
    mocks.mockGet('/authz/role', { error: 'boom' }, 500)
    const res = await get(appWith({ userId: 'u1', tokenType: 'user' }), { 'X-Org-Id': 'acme' })
    expect(res.status).toBe(502)
  })

  it('401 when nothing authenticated the request first', async () => {
    expect((await get(appWith(null), { 'X-Org-Id': 'acme' })).status).toBe(401)
  })
})
