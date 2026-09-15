import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootTestFoldBase, makeTestApp, makeToken, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App

const json = <T>(res: Response) => res.json() as Promise<T>

beforeAll(async () => {
  fb = await bootTestFoldBase()
}, 30_000)
afterAll(async () => {
  await fb.stop()
})
beforeEach(async () => {
  app = await makeTestApp(fb)
})

const MANIFEST = {
  name: 'flect',
  origin: 'https://flect.cloud',
  actions: { deploy: 'member', 'db.manage': 'admin' },
}

/** Founds acme as the default-token user (owner) and returns key scope ids. */
async function setup() {
  const { org } = await json<{ org: { id: string } }>(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
  const { projects } = await json<{ projects: Array<{ id: string; slug: string }> }>(
    await app.get('/v1/orgs/acme/workspaces/default/projects'),
  )
  return { orgId: org.id, projectId: projects[0]!.id }
}

// ── app registry ──────────────────────────────────────────────────────────────

describe('PDP — app registry', () => {
  it('registers a manifest and lists its apps + policies', async () => {
    await setup()
    expect((await app.post('/apps/register', MANIFEST)).status).toBe(201)

    const { policies } = await json<{ policies: Array<{ action: string; minRole: string }> }>(
      await app.get('/apps/flect/policies'),
    )
    expect(policies.map((p) => p.action).sort()).toEqual(['db.manage', 'deploy'])
    expect(policies.find((p) => p.action === 'deploy')!.minRole).toBe('member')

    const { apps } = await json<{ apps: Array<{ name: string }> }>(await app.get('/apps'))
    expect(apps.map((a) => a.name)).toContain('flect')
  })

  it('re-register only fills gaps — an existing policy is not overwritten', async () => {
    await setup()
    await app.post('/apps/register', MANIFEST)
    // deploy already has a policy (member); a manifest that would default it to
    // owner must NOT change it (admin overrides survive redeploys).
    await app.post('/apps/register', { ...MANIFEST, actions: { deploy: 'owner' } })

    const { policies } = await json<{ policies: Array<{ action: string; minRole: string }> }>(
      await app.get('/apps/flect/policies'),
    )
    expect(policies.find((p) => p.action === 'deploy')!.minRole).toBe('member')
  })
})

// ── effective role ──────────────────────────────────────────────────────────

describe('PDP — effective role (org role, inherited downward)', () => {
  it('owner at org inherits to sub-scopes; stranger is none; unknown 404', async () => {
    const { orgId, projectId } = await setup()

    const atOrg = await json<{ role: string; via?: { scopeKind: string } }>(await app.get(`/authz/role?scope=${orgId}`))
    expect(atOrg.role).toBe('owner')
    expect(atOrg.via?.scopeKind).toBe('org')

    const atProj = await json<{ role: string }>(await app.get(`/authz/role?scope=${projectId}`))
    expect(atProj.role).toBe('owner') // inherited from the org

    const stranger = await json<{ role: string }>(await app.get(`/authz/role?scope=${orgId}`, makeToken('stranger')))
    expect(stranger.role).toBe('none')

    expect((await app.get('/authz/role?scope=ghost')).status).toBe(404)
    expect((await app.get('/authz/role')).status).toBe(400)
  })

  it('names the org the way X-Org-Id is allowed to: id, slug or short id', async () => {
    const { orgId } = await setup()
    const { org } = await json<{ org: { short_id: string } }>(await app.get('/orgs/acme'))

    // A CLI that ran `use acme` sends the slug; a console sends the id. The same
    // membership must not depend on which spelling arrived.
    for (const ref of [orgId, 'acme', org.short_id]) {
      const res = await json<{ role: string }>(await app.get(`/authz/role?scope=${ref}`))
      expect(res.role, `scope=${ref}`).toBe('owner')
    }
  })
})

// ── check ───────────────────────────────────────────────────────────────────

describe('PDP — check (deny-by-default)', () => {
  it('owner passes; member is gated by min role; unknown action denied', async () => {
    const { orgId, projectId } = await setup()
    await app.post('/apps/register', MANIFEST)
    await app.post('/v1/orgs/acme/members', { user_id: 'user-mem', role: 'member' })

    const mem = makeToken('user-mem')
    // member can deploy (min member) at the project — role inherited from the org
    const deploy = await json<{ allowed: boolean }>(
      await app.post('/authz/check', { app: 'flect', action: 'deploy', scope_id: projectId }, mem),
    )
    expect(deploy.allowed).toBe(true)

    // member cannot db.manage (min admin)
    const dbm = await json<{ allowed: boolean; reason: string }>(
      await app.post('/authz/check', { app: 'flect', action: 'db.manage', scope_id: projectId }, mem),
    )
    expect(dbm).toMatchObject({ allowed: false, reason: 'insufficient_role' })

    // owner passes everywhere
    const own = await json<{ allowed: boolean }>(
      await app.post('/authz/check', { app: 'flect', action: 'db.manage', scope_id: orgId }),
    )
    expect(own.allowed).toBe(true)

    // unknown action is denied deny-by-default (no policy)
    const unk = await json<{ allowed: boolean; reason: string }>(
      await app.post('/authz/check', { app: 'flect', action: 'nope', scope_id: orgId }),
    )
    expect(unk).toMatchObject({ allowed: false, reason: 'no_policy' })

    // a stranger has no role → gated
    const stranger = await json<{ allowed: boolean; role: string }>(
      await app.post('/authz/check', { app: 'flect', action: 'deploy', scope_id: orgId }, makeToken('stranger')),
    )
    expect(stranger).toMatchObject({ allowed: false, role: 'none' })
  })

  it('requires auth', async () => {
    expect((await app.unauth('/authz/role?scope=x')).status).toBe(401)
  })
})
