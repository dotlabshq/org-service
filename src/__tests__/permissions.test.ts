/**
 * The permission model (workspace ADR 0003, decision 5a).
 *
 * An app declares its actions; each asks for a least role, says whether it
 * reads or writes, and may be closed to some kinds of credential. org-service
 * decides, and hands a service the whole answer for one principal so the
 * service only has to look a name up. These tests state who gets what.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestFoldBase, makeServiceToken, makeTestApp, makeToken, USER_ID, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App
let orgId: string

const QUILLPATH = makeServiceToken('quillpath')
const MANIFEST = {
  name: 'quillpath',
  origin: 'https://quillpath.example',
  actions: {
    'deal.read': { min_role: 'viewer', access: 'read' },
    'deal.create': 'member',
    'deal.delete': { min_role: 'admin' },
    'suggestion.decide': { min_role: 'member', requires: 'person' },
    'apikey.create': { min_role: 'admin', requires: 'session' },
    'billing.manage': { min_role: 'owner', requires: 'person' },
    'payment.record': { min_role: 'owner', services: ['stripe-service'] },
  },
}

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  app = await makeTestApp(fb)
  orgId = ((await (await app.post('/api/orgs', { name: 'Acme', slug: 'acme' })).json()) as { org: { id: string } }).org.id
  for (const [user, role] of [['u-admin', 'admin'], ['u-member', 'member'], ['u-viewer', 'viewer']] as const) {
    await app.post('/api/orgs/acme/members', { user_id: user, role })
  }
  expect((await app.post('/_/apps/register', MANIFEST, QUILLPATH)).status).toBe(201)
})

type Set = { app: string; scope_id: string; role: string; permissions: string[] }
const perms = async (token: string, body: Record<string, unknown> = {}) => {
  const res = await app.post('/api/authz/permissions', { app: 'quillpath', scope_id: orgId, ...body }, token)
  return { status: res.status, set: (await res.json()) as Set }
}
const check = async (token: string, action: string, body: Record<string, unknown> = {}) =>
  (await (await app.post('/api/authz/check', { app: 'quillpath', action, scope_id: orgId, ...body }, token)).json()) as { allowed: boolean; reason?: string; role: string }

describe('what a person may do is the whole answer, by role', () => {
  it('each built-in role gets what its rank reaches, and nothing declared is assumed', async () => {
    expect((await perms(makeToken('u-viewer'))).set.permissions).toEqual(['deal.read'])
    expect((await perms(makeToken('u-member'))).set.permissions.sort()).toEqual(['deal.create', 'deal.read', 'suggestion.decide'])
    expect((await perms(makeToken('u-admin'))).set.permissions.sort())
      .toEqual(['apikey.create', 'deal.create', 'deal.delete', 'deal.read', 'suggestion.decide'])
    const owner = (await perms(makeToken(USER_ID))).set
    expect(owner).toMatchObject({ app: 'quillpath', scope_id: orgId, role: 'owner' })
    // Everything a person can hold. `payment.record` is the owner's too; what
    // it adds is that one service may do it with nobody behind the request.
    expect(owner.permissions.sort()).toEqual(Object.keys(MANIFEST.actions).sort())
  })

  it('a stranger gets an empty set, not an error that says the organization exists', async () => {
    const { status, set } = await perms(makeToken('stranger'))
    expect(status).toBe(200)
    expect(set).toMatchObject({ role: 'none', permissions: [] })
  })

  it('agrees with check, action by action', async () => {
    const set = (await perms(makeToken('u-member'))).set.permissions
    for (const action of Object.keys(MANIFEST.actions)) {
      expect((await check(makeToken('u-member'), action)).allowed, action).toBe(set.includes(action))
    }
  })

  it('accepts the organization by slug, and answers with its id', async () => {
    const res = await app.post('/api/authz/permissions', { app: 'quillpath', scope_id: 'acme' }, makeToken('u-member'))
    expect(((await res.json()) as Set).scope_id).toBe(orgId)
  })
})

describe('a credential limits what the role allows; it never adds', () => {
  it('a read-only token of an admin may only read', async () => {
    const { set } = await perms(QUILLPATH, { user_id: 'u-admin', credential: { kind: 'token', scopes: ['read'] } })
    expect(set.permissions).toEqual(['deal.read'])
    expect(await check(QUILLPATH, 'deal.delete', { user_id: 'u-admin', credential: { kind: 'token', scopes: ['read'] } }))
      .toMatchObject({ allowed: false, reason: 'insufficient_scope' })
  })

  it('a write token does what the role does, except what asks for a signed-in person', async () => {
    const { set } = await perms(QUILLPATH, { user_id: 'u-admin', credential: { kind: 'token', scopes: ['read', 'write'] } })
    expect(set.permissions.sort()).toEqual(['deal.create', 'deal.delete', 'deal.read', 'suggestion.decide'])
    // A leaked token must not be able to mint more tokens.
    expect(await check(QUILLPATH, 'apikey.create', { user_id: 'u-admin', credential: { kind: 'token' } }))
      .toMatchObject({ allowed: false, reason: 'session_only' })
  })

  it('an organization\'s key acts with the role it was given, and never as a person', async () => {
    const key = { credential: { kind: 'org_key', role: 'owner', scopes: ['read', 'write'] } }
    const { set } = await perms(QUILLPATH, key)
    // Owner's rank, but nothing that asks for a person or a session.
    expect(set.permissions.sort()).toEqual(['deal.create', 'deal.delete', 'deal.read', 'payment.record'])
    expect(await check(QUILLPATH, 'suggestion.decide', key)).toMatchObject({ allowed: false, reason: 'person_only' })
    expect(await check(QUILLPATH, 'apikey.create', key)).toMatchObject({ allowed: false, reason: 'session_only' })

    const memberKey = { credential: { kind: 'org_key', role: 'member' } }
    expect((await perms(QUILLPATH, memberKey)).set.permissions.sort()).toEqual(['deal.create', 'deal.read'])
  })

  it('a key with no role stated is not a question', async () => {
    expect((await perms(QUILLPATH, { credential: { kind: 'org_key' } })).status).toBe(400)
  })
})

describe('a service, as itself, gets only what it was named for', () => {
  it('the named service may; another may not; and it is not a role', async () => {
    const stripe = await perms(makeServiceToken('stripe-service'))
    expect(stripe.set).toMatchObject({ role: 'service', permissions: ['payment.record'] })

    expect((await perms(makeServiceToken('some-other-service'))).set.permissions).toEqual([])
    expect(await check(makeServiceToken('some-other-service'), 'payment.record'))
      .toMatchObject({ allowed: false, reason: 'service_not_allowed' })
    // Not even the app's own identity, unless the manifest says so.
    expect((await perms(QUILLPATH)).set.permissions).toEqual([])
  })
})

describe('who may ask what', () => {
  it('a person may not ask about somebody else', async () => {
    expect((await perms(makeToken('u-member'), { user_id: 'u-admin' })).status).toBe(403)
  })

  it('a person may not describe their own credential, in either direction', async () => {
    const member = makeToken('u-member')
    expect((await perms(member, { credential: { kind: 'token', scopes: ['read'] } })).status).toBe(403)
    expect((await perms(member, { credential: { kind: 'org_key', role: 'owner' } })).status).toBe(403)
    expect((await perms(member, { credential: { kind: 'session', role: 'owner' } })).status).toBe(403)
    // Saying nothing, or saying "my session", is the same and is fine.
    expect((await perms(member, { credential: { kind: 'session' } })).status).toBe(200)
  })

  it('needs a token at all', async () => {
    expect((await app.app.fetch(new Request('http://localhost/api/authz/permissions', { method: 'POST', body: '{}' }))).status).toBe(401)
  })

  it('an app nobody registered has nothing anyone may do', async () => {
    const res = await app.post('/api/authz/permissions', { app: 'never-registered', scope_id: orgId })
    expect(((await res.json()) as Set).permissions).toEqual([])
  })
})

describe('the rule set follows the manifest and the membership', () => {
  it('a rule the app tightened takes effect on the next question', async () => {
    expect((await perms(makeToken('u-member'))).set.permissions).toContain('deal.create')
    await app.post('/_/apps/register', { ...MANIFEST, actions: { ...MANIFEST.actions, 'deal.create': 'admin' } }, QUILLPATH)
    expect((await perms(makeToken('u-member'))).set.permissions).not.toContain('deal.create')
  })

  it('a role that changed takes effect on the next question', async () => {
    await app.patch('/api/orgs/acme/members/u-member', { role: 'viewer' })
    expect((await perms(makeToken('u-member'))).set.permissions).toEqual(['deal.read'])
  })

  it('refuses a manifest it does not understand, rather than guessing', async () => {
    const bad = { ...MANIFEST, actions: { 'deal.read': { min_role: 'viewer', acess: 'read' } } }
    expect((await app.post('/_/apps/register', bad, QUILLPATH)).status).toBe(400)
    const worse = { ...MANIFEST, actions: { 'x': { min_role: 'viewer', services: ['a,b'] } } }
    expect((await app.post('/_/apps/register', worse, QUILLPATH)).status).toBe(400)
  })
})
