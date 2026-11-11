import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootTestFoldBase, makeServiceToken, makeTestApp, makeToken, USER_ID, type TestFoldBase } from './setup.js'

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
/** The app's own service identity: the only caller that may register it. */
const FLECT = makeServiceToken('flect')

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
    expect((await app.post('/_/apps/register', MANIFEST, FLECT)).status).toBe(201)

    const { policies } = await json<{ policies: Array<{ action: string; min_role: string }> }>(
      await app.get('/apps/flect/policies'),
    )
    expect(policies.map((p) => p.action).sort()).toEqual(['db.manage', 'deploy'])
    expect(policies.find((p) => p.action === 'deploy')!.min_role).toBe('member')

    const { apps } = await json<{ apps: Array<{ name: string }> }>(await app.get('/apps'))
    expect(apps.map((a) => a.name)).toContain('flect')
  })

  it('re-register only fills gaps — an existing policy is not overwritten', async () => {
    await setup()
    await app.post('/_/apps/register', MANIFEST, FLECT)
    // deploy already has a policy (member); a manifest that would default it to
    // owner must NOT change it (admin overrides survive redeploys).
    await app.post('/_/apps/register', { ...MANIFEST, actions: { deploy: 'owner' } }, FLECT)

    const { policies } = await json<{ policies: Array<{ action: string; min_role: string }> }>(
      await app.get('/apps/flect/policies'),
    )
    expect(policies.find((p) => p.action === 'deploy')!.min_role).toBe('member')
  })
})

// ── effective role ──────────────────────────────────────────────────────────

describe('PDP — effective role (org role, inherited downward)', () => {
  it('owner at org inherits to sub-scopes; stranger is none; unknown 404', async () => {
    const { orgId, projectId } = await setup()

    const atOrg = await json<{ role: string; via?: { scope_kind: string } }>(await app.get(`/authz/role?scope=${orgId}`))
    expect(atOrg.role).toBe('owner')
    expect(atOrg.via?.scope_kind).toBe('org')

    const atProj = await json<{ role: string }>(await app.get(`/authz/role?scope=${projectId}`))
    expect(atProj.role).toBe('owner') // inherited from the org

    const stranger = await json<{ role: string }>(await app.get(`/authz/role?scope=${orgId}`, makeToken('stranger')))
    expect(stranger.role).toBe('none')

    expect((await app.get('/authz/role?scope=ghost')).status).toBe(404)
    expect((await app.get('/authz/role')).status).toBe(400)
  })

  it('names a scope by its short id, the way X-Flect-Scope will', async () => {
    const { projectId } = await setup()
    const { projects } = await json<{ projects: Array<{ id: string; short_id: string }> }>(
      await app.get('/v1/orgs/acme/workspaces/default/projects'),
    )
    const main = projects.find((p) => p.id === projectId)!
    const byShort = await json<{ role: string }>(await app.get(`/authz/role?scope=${main.short_id}`))
    expect(byShort.role).toBe('owner')
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
  it('owner passes; member is gated by min role; an undeclared action is nobody\'s', async () => {
    const { orgId, projectId } = await setup()
    await app.post('/_/apps/register', MANIFEST, FLECT)
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

    // An action the app never declared is refused, for the owner too: the
    // manifest is the list of what may be done. A new action someone forgot to
    // add, or an app whose registration failed, must not be open by accident.
    const unk = await json<{ allowed: boolean; reason: string }>(
      await app.post('/authz/check', { app: 'flect', action: 'nope', scope_id: orgId }),
    )
    expect(unk).toMatchObject({ allowed: false, reason: 'no_policy' })

    // The same for an app that registered nothing at all.
    const noApp = await json<{ allowed: boolean; reason: string }>(
      await app.post('/authz/check', { app: 'never-registered', action: 'anything', scope_id: orgId }),
    )
    expect(noApp).toMatchObject({ allowed: false, reason: 'no_policy' })

    // What members may do is said, not assumed: `deploy: member` above.

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

// ── who may ask, who may register ─────────────────────────────────────────────

describe('PDP — an app registers itself, and nobody else does', () => {
  it('refuses a person, whatever their role', async () => {
    await setup()
    const res = await app.post('/_/apps/register', MANIFEST)          // the org's owner
    expect(res.status).toBe(403)
    expect((await json<{ apps: unknown[] }>(await app.get('/apps'))).apps).toEqual([])
  })

  it('refuses another service: one app cannot lower another app\'s bar', async () => {
    await setup()
    await app.post('/_/apps/register', MANIFEST, FLECT)
    const res = await app.post('/_/apps/register', { ...MANIFEST, origin: 'https://evil.example' }, makeServiceToken('quillpath'))
    expect(res.status).toBe(403)
    const { apps } = await json<{ apps: Array<{ name: string; origin: string }> }>(await app.get('/apps'))
    expect(apps.find((a) => a.name === 'flect')!.origin).toBe(MANIFEST.origin)
  })

  it('accepts the identity the realm says speaks for the app', async () => {
    await setup()
    const saved = process.env['ORG_APP_REGISTRARS']
    process.env['ORG_APP_REGISTRARS'] = 'other:someone, flect:flect-api'
    try {
      expect((await app.post('/_/apps/register', MANIFEST, makeServiceToken('flect-api'))).status).toBe(201)
      expect((await app.post('/_/apps/register', { ...MANIFEST, name: 'other' }, makeServiceToken('flect-api'))).status).toBe(403)
    } finally {
      if (saved === undefined) delete process.env['ORG_APP_REGISTRARS']
      else process.env['ORG_APP_REGISTRARS'] = saved
    }
  })

  it('is not part of the published API, and is guarded the same at its old addresses', async () => {
    await setup()
    expect((await app.post('/api/apps/register', MANIFEST, FLECT)).status).toBe(404)
    // The flect broker still posts to the root; who is calling is what counts there too.
    expect((await app.post('/apps/register', MANIFEST)).status).toBe(403)
    expect((await app.post('/apps/register', MANIFEST, FLECT)).status).toBe(201)
  })
})

describe('PDP — a person asks about themselves', () => {
  it('may not ask what role somebody else holds', async () => {
    const { orgId } = await setup()
    await app.post('/v1/orgs/acme/members', { user_id: 'user-mem', role: 'member' })
    const mem = makeToken('user-mem')

    expect((await app.get(`/authz/role?scope=${orgId}&user=${USER_ID}`, mem)).status).toBe(403)
    expect((await app.post('/authz/check', { app: 'flect', action: 'deploy', scope_id: orgId, user_id: USER_ID }, mem)).status).toBe(403)
    // Naming yourself is the same as naming nobody.
    expect((await json<{ role: string }>(await app.get(`/authz/role?scope=${orgId}&user=user-mem`, mem))).role).toBe('member')
  })

  it('a service may: a product\'s backend asks about the person it is serving', async () => {
    const { orgId } = await setup()
    const res = await app.get(`/authz/role?scope=${orgId}&user=${USER_ID}`, makeServiceToken('quillpath'))
    expect((await json<{ role: string }>(res)).role).toBe('owner')
  })
})

describe('PDP — a role is remembered briefly, and forgotten on a change', () => {
  it('a membership change made here is visible on the very next question', async () => {
    const { orgId } = await setup()
    const mem = makeToken('user-mem')
    expect((await json<{ role: string }>(await app.get(`/authz/role?scope=${orgId}`, mem))).role).toBe('none')

    await app.post('/v1/orgs/acme/members', { user_id: 'user-mem', role: 'member' })
    expect((await json<{ role: string }>(await app.get(`/authz/role?scope=${orgId}`, mem))).role).toBe('member')

    await app.del('/v1/orgs/acme/members/user-mem')
    expect((await json<{ role: string }>(await app.get(`/authz/role?scope=${orgId}`, mem))).role).toBe('none')
  })
})
