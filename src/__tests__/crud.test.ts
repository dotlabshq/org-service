import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { bootTestFoldBase, makeServiceToken, makeTestApp, makeToken, USER_ID, type TestFoldBase } from './setup.js'
import { resetIdentityCache } from '../lib/identity.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App

const json = <T>(res: Response) => res.json() as Promise<T>

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => { app = await makeTestApp(fb) })

async function createOrg(name = 'Acme', slug = 'acme', token?: string) {
  const res = await app.post('/v1/orgs', { name, slug }, token)
  return json<{ org: { id: string; short_id: string; slug: string; name: string; metadata: Record<string, unknown> } }>(res)
}

// ── orgs ────────────────────────────────────────────────────────────────────

describe('orgs', () => {
  it('lists empty for a fresh user', async () => {
    const res = await app.get('/v1/orgs')
    expect(res.status).toBe(200)
    expect((await json<{ orgs: unknown[] }>(res)).orgs).toEqual([])
  })

  it('401 without a token', async () => {
    expect((await app.unauth('/v1/orgs')).status).toBe(401)
  })

  it('creates an org and auto-provisions the default ws/proj/env chain', async () => {
    const res = await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' })
    expect(res.status).toBe(201)
    const { org } = await json<{ org: { slug: string; name: string; short_id: string } }>(res)
    expect(org.slug).toBe('acme')
    expect(org.short_id).toBeTruthy()

    const list = await json<{ orgs: unknown[] }>(await app.get('/v1/orgs'))
    expect(list.orgs).toHaveLength(1)

    const ws = await json<{ workspaces: Array<{ slug: string; is_default: boolean }> }>(await app.get('/v1/orgs/acme/workspaces'))
    expect(ws.workspaces.map((w) => w.slug)).toContain('default')
    const proj = await json<{ projects: Array<{ slug: string }> }>(await app.get('/v1/orgs/acme/workspaces/default/projects'))
    expect(proj.projects.map((p) => p.slug)).toContain('main')
    const env = await json<{ envs: Array<{ slug: string }> }>(await app.get('/v1/orgs/acme/workspaces/default/projects/main/envs'))
    expect(env.envs.map((e) => e.slug)).toContain('production')
  })

  it('makes the creator an owner', async () => {
    await createOrg()
    const { members } = await json<{ members: Array<{ user_id: string; role: string }> }>(await app.get('/v1/orgs/acme/members'))
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ user_id: USER_ID, role: 'owner' })
  })

  it('auto-generates a slug when omitted', async () => {
    const res = await app.post('/v1/orgs', { name: 'Big Co' })
    const { org } = await json<{ org: { slug: string } }>(res)
    expect(org.slug).toBe('big-co')
  })

  it('rejects a duplicate slug (409)', async () => {
    await createOrg()
    expect((await app.post('/v1/orgs', { name: 'Other', slug: 'acme' })).status).toBe(409)
  })

  it('resolves by slug and by short_id', async () => {
    const { org } = await createOrg()
    expect((await json<{ org: { id: string } }>(await app.get('/v1/orgs/acme'))).org.id).toBe(org.id)
    expect((await json<{ org: { id: string } }>(await app.get(`/v1/orgs/${org.short_id}`))).org.id).toBe(org.id)
    // id de bir ref'tir: kimliği tutan çağıran slug'ı ayrıca taşımak zorunda değil.
    expect((await json<{ org: { id: string } }>(await app.get(`/v1/orgs/${org.id}`))).org.id).toBe(org.id)
  })

  it('404 for unknown org', async () => {
    expect((await app.get('/v1/orgs/nope')).status).toBe(404)
  })

  it('updates the name (owner); the slug is immutable and refuses the whole patch', async () => {
    await createOrg()

    const renamed = await app.patch('/v1/orgs/acme', { name: 'Acme Inc' })
    expect(renamed.status).toBe(200)
    expect((await json<{ org: { name: string; slug: string } }>(renamed)).org)
      .toMatchObject({ name: 'Acme Inc', slug: 'acme' })

    // A patch that also moves the slug is rejected outright rather than
    // half-applied: names derived from the slug live in other systems.
    expect((await app.patch('/v1/orgs/acme', { name: 'X', slug: 'acme-inc' })).status).toBe(409)
  })

  it('forbids update for a non-member (403)', async () => {
    await createOrg()
    const outsider = makeToken('intruder')
    expect((await app.patch('/v1/orgs/acme', { name: 'X' }, outsider)).status).toBe(403)
  })

  it('archives (delete) an org — it disappears from the list', async () => {
    await createOrg()
    expect((await app.del('/v1/orgs/acme')).status).toBe(200)
    expect((await json<{ orgs: unknown[] }>(await app.get('/v1/orgs'))).orgs).toEqual([])
  })
})

// ── metadata ────────────────────────────────────────────────────────────────

describe('org metadata', () => {
  it('sets, reads, and deletes keys', async () => {
    await createOrg()
    expect((await app.patch('/v1/orgs/acme/metadata', { tier: 'pro', seats: 5 })).status).toBe(200)
    let org = (await json<{ org: { metadata: Record<string, unknown> } }>(await app.get('/v1/orgs/acme'))).org
    expect(org.metadata).toMatchObject({ tier: 'pro', seats: 5 })

    await app.del('/v1/orgs/acme/metadata/tier')
    org = (await json<{ org: { metadata: Record<string, unknown> } }>(await app.get('/v1/orgs/acme'))).org
    expect(org.metadata['tier']).toBeUndefined()
    expect(org.metadata['seats']).toBe(5)
  })
})

// ── memberships ──────────────────────────────────────────────────────────────

describe('memberships', () => {
  it('adds, changes role, and removes a member', async () => {
    await createOrg()
    expect((await app.post('/v1/orgs/acme/members', { user_id: 'u2', role: 'member' })).status).toBe(201)
    let members = (await json<{ members: Array<{ user_id: string; role: string }> }>(await app.get('/v1/orgs/acme/members'))).members
    expect(members.find((m) => m.user_id === 'u2')?.role).toBe('member')

    await app.post('/v1/orgs/acme/members', { user_id: 'u2', role: 'admin' })
    members = (await json<{ members: Array<{ user_id: string; role: string }> }>(await app.get('/v1/orgs/acme/members'))).members
    expect(members.find((m) => m.user_id === 'u2')?.role).toBe('admin')

    expect((await app.del('/v1/orgs/acme/members/u2')).status).toBe(200)
    members = (await json<{ members: Array<{ user_id: string; role: string }> }>(await app.get('/v1/orgs/acme/members'))).members
    expect(members.find((m) => m.user_id === 'u2')).toBeUndefined()
  })

  it('a viewer cannot add members (403)', async () => {
    await createOrg()
    await app.post('/v1/orgs/acme/members', { user_id: 'viewer1', role: 'viewer' })
    const viewerTok = makeToken('viewer1')
    expect((await app.post('/v1/orgs/acme/members', { user_id: 'u3', role: 'member' }, viewerTok)).status).toBe(403)
  })

  it('PATCH changes a role and answers with the member', async () => {
    await createOrg()
    await app.post('/v1/orgs/acme/members', { user_id: 'u2', role: 'member' })

    const res = await app.patch('/v1/orgs/acme/members/u2', { role: 'admin' })
    expect(res.status).toBe(200)
    expect((await json<{ member: { role: string } }>(res)).member.role).toBe('admin')

    const { members } = await json<{ members: Array<{ user_id: string; role: string }> }>(await app.get('/v1/orgs/acme/members'))
    expect(members.find((m) => m.user_id === 'u2')?.role).toBe('admin')
  })

  it('PATCH on somebody who is not a member is 404, not an enrolment', async () => {
    await createOrg()
    expect((await app.patch('/v1/orgs/acme/members/nobody', { role: 'admin' })).status).toBe(404)

    const { members } = await json<{ members: Array<{ user_id: string }> }>(await app.get('/v1/orgs/acme/members'))
    expect(members.map((m) => m.user_id)).toEqual([USER_ID])
  })

  it('a viewer cannot change a role (403)', async () => {
    await createOrg()
    await app.post('/v1/orgs/acme/members', { user_id: 'viewer1', role: 'viewer' })
    await app.post('/v1/orgs/acme/members', { user_id: 'u2', role: 'member' })
    expect((await app.patch('/v1/orgs/acme/members/u2', { role: 'admin' }, makeToken('viewer1'))).status).toBe(403)
  })
})

// ── the last owner ───────────────────────────────────────────────────────────
//
// Owner is the only role that can hand out owner. An org whose last one leaves
// or is demoted is locked: nobody left can invite, promote or delete it. Every
// path that could do it is refused, including the one that looks like adding.

describe('an org always keeps an owner', () => {
  it('the only owner cannot be demoted, by PATCH or by POST', async () => {
    await createOrg()
    expect((await app.patch(`/v1/orgs/acme/members/${USER_ID}`, { role: 'admin' })).status).toBe(409)
    // POST re-points an existing member's role, so it is the same act by another door.
    expect((await app.post('/v1/orgs/acme/members', { user_id: USER_ID, role: 'admin' })).status).toBe(409)

    const { members } = await json<{ members: Array<{ user_id: string; role: string }> }>(await app.get('/v1/orgs/acme/members'))
    expect(members.find((m) => m.user_id === USER_ID)?.role).toBe('owner')
  })

  it('the only owner cannot be removed', async () => {
    await createOrg()
    expect((await app.del(`/v1/orgs/acme/members/${USER_ID}`)).status).toBe(409)
  })

  it('once there is a second owner, the first can go', async () => {
    await createOrg()
    await app.post('/v1/orgs/acme/members', { user_id: 'u2', role: 'owner' })

    expect((await app.del(`/v1/orgs/acme/members/${USER_ID}`)).status).toBe(200)
    const { members } = await json<{ members: Array<{ user_id: string; role: string }> }>(
      await app.get('/v1/orgs/acme/members', makeToken('u2')),
    )
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ user_id: 'u2', role: 'owner' })
  })

  it('a non-owner member is not protected by any of this', async () => {
    await createOrg()
    await app.post('/v1/orgs/acme/members', { user_id: 'u2', role: 'admin' })
    expect((await app.patch('/v1/orgs/acme/members/u2', { role: 'viewer' })).status).toBe(200)
    expect((await app.del('/v1/orgs/acme/members/u2')).status).toBe(200)
  })
})

// ── scopes ────────────────────────────────────────────────────────────────────

describe('scopes (workspace / project / environment)', () => {
  beforeEach(async () => { await createOrg() })

  it('creates a workspace with a default project + env chain', async () => {
    const res = await app.post('/v1/orgs/acme/workspaces', { name: 'Staging', slug: 'staging' })
    expect(res.status).toBe(201)
    const proj = await json<{ projects: Array<{ slug: string }> }>(await app.get('/v1/orgs/acme/workspaces/staging/projects'))
    expect(proj.projects.map((p) => p.slug)).toContain('main')
  })

  it('rejects a duplicate workspace slug (409)', async () => {
    await app.post('/v1/orgs/acme/workspaces', { name: 'Staging', slug: 'staging' })
    expect((await app.post('/v1/orgs/acme/workspaces', { name: 'Other', slug: 'staging' })).status).toBe(409)
  })

  it('creates and lists projects and environments', async () => {
    await app.post('/v1/orgs/acme/workspaces/default/projects', { name: 'API', slug: 'api' })
    const projs = await json<{ projects: Array<{ slug: string }> }>(await app.get('/v1/orgs/acme/workspaces/default/projects'))
    expect(projs.projects.map((p) => p.slug).sort()).toEqual(['api', 'main'])

    await app.post('/v1/orgs/acme/workspaces/default/projects/api/envs', { name: 'Staging', slug: 'staging' })
    const envs = await json<{ envs: Array<{ slug: string }> }>(await app.get('/v1/orgs/acme/workspaces/default/projects/api/envs'))
    expect(envs.envs.map((e) => e.slug)).toContain('staging')
  })

  it('resolves a scope by short_id', async () => {
    const { workspace } = await json<{ workspace: { short_id: string; slug: string } }>(
      await app.post('/v1/orgs/acme/workspaces', { name: 'Staging', slug: 'staging' }),
    )
    const got = await json<{ workspace: { slug: string } }>(await app.get(`/v1/orgs/acme/workspaces/${workspace.short_id}`))
    expect(got.workspace.slug).toBe('staging')
  })

  it('updates a scope (rename)', async () => {
    await app.post('/v1/orgs/acme/workspaces', { name: 'Staging', slug: 'staging' })
    const res = await app.patch('/v1/orgs/acme/workspaces/staging', { name: 'Stage 2', slug: 'stage2' })
    expect(res.status).toBe(200)
    expect((await json<{ workspace: { slug: string } }>(res)).workspace.slug).toBe('stage2')
  })

  it('subtree-archives a workspace', async () => {
    await app.post('/v1/orgs/acme/workspaces', { name: 'Staging', slug: 'staging' })
    expect((await app.del('/v1/orgs/acme/workspaces/staging')).status).toBe(200)
    const ws = await json<{ workspaces: Array<{ slug: string }> }>(await app.get('/v1/orgs/acme/workspaces'))
    expect(ws.workspaces.map((w) => w.slug)).not.toContain('staging')
  })

  it('a viewer cannot create a workspace (403)', async () => {
    await app.post('/v1/orgs/acme/members', { user_id: 'v1', role: 'viewer' })
    const viewer = makeToken('v1')
    expect((await app.post('/v1/orgs/acme/workspaces', { name: 'X', slug: 'x' }, viewer)).status).toBe(403)
  })
})

describe('all-orgs', () => {
  it('lists every org for a service token, regardless of membership', async () => {
    await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' })
    // Başka bir kullanıcının org'u: servis listesinde yine görünmeli.
    await app.post('/v1/orgs', { name: 'Other', slug: 'other' }, makeToken('u-other'))

    const { orgs } = await json<{ orgs: Array<{ slug: string }> }>(
      await app.get('/v1/all-orgs', makeServiceToken()),
    )
    expect(orgs.map((o) => o.slug).sort()).toEqual(['acme', 'other'])
  })

  it('refuses a user token — this is not a user surface', async () => {
    expect((await app.get('/v1/all-orgs')).status).toBe(403)
  })
})

// ── who may read an org ───────────────────────────────────────────────────────

describe('GET /v1/orgs/:ref — membership', () => {
  it('lets a member read it', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    const res = await app.get('/v1/orgs/acme')
    expect(res.status).toBe(200)
    expect((await json<{ org: { slug: string } }>(res)).org.slug).toBe('acme')
  })

  it('answers 404 to a non-member, so a slug guess reveals nothing', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))

    // A different signed-in user who knows the slug.
    const res = await app.get('/v1/orgs/acme', makeToken('usr_outsider'))

    // 404 and not 403: 403 would confirm the org exists and turn this into a
    // membership oracle.
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).not.toContain('Acme')
  })

  it('still answers 404 for an org that does not exist', async () => {
    expect((await app.get('/v1/orgs/nope')).status).toBe(404)
  })

  it('lets a service token read it', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    const res = await app.get('/v1/orgs/acme', makeServiceToken('zone9-api'))
    expect(res.status).toBe(200)
  })
})

// ── slug immutability ─────────────────────────────────────────────────────────

describe('PATCH /v1/orgs/:ref — slug', () => {
  it('refuses to change the slug by default', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))

    const res = await app.patch('/v1/orgs/acme', { slug: 'acme-renamed' })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('slug_immutable')

    // Unchanged, and still reachable under the original slug.
    expect((await app.get('/v1/orgs/acme')).status).toBe(200)
  })

  it('still allows renaming the display name', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    const res = await app.patch('/v1/orgs/acme', { name: 'Acme Industries' })
    expect(res.status).toBe(200)
    expect((await json<{ org: { name: string; slug: string } }>(res)).org).toMatchObject({
      name: 'Acme Industries',
      slug: 'acme',
    })
  })

  it('allows the change when a realm opts in', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    process.env['ORG_ALLOW_SLUG_CHANGE'] = 'true'
    try {
      const res = await app.patch('/v1/orgs/acme', { slug: 'acme-renamed' })
      expect(res.status).toBe(200)
      expect((await json<{ org: { slug: string } }>(res)).org.slug).toBe('acme-renamed')
    } finally {
      delete process.env['ORG_ALLOW_SLUG_CHANGE']
    }
  })
})

// ── membership writes by a service ────────────────────────────────────────────

describe('service tokens and membership', () => {
  const writer = () => makeServiceToken('zone9-api')

  it('refuses by default, even for a service token', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    const res = await app.post('/v1/orgs/acme/members', { user_id: 'usr_new', role: 'member' }, writer())
    expect(res.status).toBe(403)
  })

  it('allows a service named in the allowlist, and records it as the actor', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    process.env['ORG_MEMBERSHIP_WRITERS'] = 'zone9-api'
    try {
      const res = await app.post('/v1/orgs/acme/members', { user_id: 'usr_new', role: 'member' }, writer())
      expect(res.status).toBe(201)

      const { members } = await json<{ members: Array<{ user_id: string; role: string }> }>(
        await app.get('/v1/orgs/acme/members'),
      )
      expect(members.map((m) => m.user_id)).toContain('usr_new')
    } finally {
      delete process.env['ORG_MEMBERSHIP_WRITERS']
    }
  })

  it('does not let an unlisted service in when another one is listed', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    process.env['ORG_MEMBERSHIP_WRITERS'] = 'billing'
    try {
      const res = await app.post('/v1/orgs/acme/members', { user_id: 'usr_new', role: 'member' }, writer())
      expect(res.status).toBe(403)
    } finally {
      delete process.env['ORG_MEMBERSHIP_WRITERS']
    }
  })

  it('can remove a member too, so a failed invite can be undone', async () => {
    await json(await app.post('/v1/orgs', { name: 'Acme', slug: 'acme' }))
    process.env['ORG_MEMBERSHIP_WRITERS'] = 'zone9-api'
    try {
      await app.post('/v1/orgs/acme/members', { user_id: 'usr_new', role: 'member' }, writer())
      expect((await app.del('/v1/orgs/acme/members/usr_new', writer())).status).toBe(200)
    } finally {
      delete process.env['ORG_MEMBERSHIP_WRITERS']
    }
  })

  it('still refuses an unknown org with 404, not 403', async () => {
    process.env['ORG_MEMBERSHIP_WRITERS'] = 'zone9-api'
    try {
      const res = await app.post('/v1/orgs/nope/members', { user_id: 'usr_new', role: 'member' }, writer())
      expect(res.status).toBe(404)
    } finally {
      delete process.env['ORG_MEMBERSHIP_WRITERS']
    }
  })
})

// ── path convention ───────────────────────────────────────────────────────────

describe('mount paths', () => {
  it('serves the same resource at the root and under the legacy /v1 prefix', async () => {
    await json(await app.post('/orgs', { name: 'Acme', slug: 'acme' }))

    // Root is canonical: a gateway publishes /v1/org/orgs and strips /v1/org.
    const root = await app.get('/orgs/acme')
    // Legacy, for callers not yet behind the gateway.
    const legacy = await app.get('/v1/orgs/acme')

    expect(root.status).toBe(200)
    expect(legacy.status).toBe(200)
    expect(await root.json()).toEqual(await legacy.json())
  })

  it('serves authz and apps at the root as well', async () => {
    await json(await app.post('/orgs', { name: 'Acme', slug: 'acme' }))
    expect((await app.get('/apps')).status).toBe(200)
    expect((await app.get('/v1/apps')).status).toBe(200)
  })
})

// ── names on a member list ───────────────────────────────────────────────────
//
// A membership is (user, org, role); who that user is belongs to iam. The join
// happens in this service because iam's user endpoints are not on the gateway,
// so nobody downstream can make the call. It is an enrichment: without iam the
// list is the same list, minus the names.

describe('member identity', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env['IAM_SERVICE_URL']
    resetIdentityCache()
  })

  /** Stand in for iam, and record what it was asked. */
  function fakeIam(users: Record<string, { email: string; name?: string }>) {
    const calls: string[][] = []
    process.env['IAM_SERVICE_URL'] = 'http://iam.test'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/users/resolve')) return realFetch(input as never, init)
      const { ids } = JSON.parse(String(init?.body)) as { ids: string[] }
      calls.push(ids)
      return new Response(
        JSON.stringify({ users: ids.filter((id) => users[id]).map((id) => ({ id, ...users[id] })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    return calls
  }

  it('carries the email and name iam knows', async () => {
    await createOrg()
    await app.post('/v1/orgs/acme/members', { user_id: 'u2', role: 'member' })
    const calls = fakeIam({
      [USER_ID]: { email: 'owner@acme.test', name: 'Owner' },
      u2: { email: 'two@acme.test', name: 'Two' },
    })

    const { members } = await json<{ members: Array<{ user_id: string; email?: string; name?: string }> }>(
      await app.get('/v1/orgs/acme/members'),
    )
    expect(members.find((m) => m.user_id === 'u2')).toMatchObject({ email: 'two@acme.test', name: 'Two' })
    // One request for the whole list, not one per member.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sort()).toEqual([USER_ID, 'u2'].sort())
  })

  it('an id iam does not know still appears, without a name', async () => {
    await createOrg()
    await app.post('/v1/orgs/acme/members', { user_id: 'ghost', role: 'member' })
    fakeIam({ [USER_ID]: { email: 'owner@acme.test' } })

    const { members } = await json<{ members: Array<{ user_id: string; email?: string }> }>(
      await app.get('/v1/orgs/acme/members'),
    )
    const ghost = members.find((m) => m.user_id === 'ghost')
    expect(ghost).toBeDefined()
    expect(ghost!.email).toBeUndefined()
  })

  it('an unreachable iam costs the names, not the list', async () => {
    await createOrg()
    process.env['IAM_SERVICE_URL'] = 'http://iam.test'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/users/resolve')) throw new Error('connection refused')
      return realFetch(input as never, init)
    }) as typeof fetch

    const res = await app.get('/v1/orgs/acme/members')
    expect(res.status).toBe(200)
    const { members } = await json<{ members: Array<{ user_id: string; role: string }> }>(res)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ user_id: USER_ID, role: 'owner' })
  })

  it('without iam configured the list is unchanged', async () => {
    await createOrg()
    const { members } = await json<{ members: Array<{ user_id: string; email?: string }> }>(
      await app.get('/v1/orgs/acme/members'),
    )
    expect(members).toHaveLength(1)
    expect(members[0]!.email).toBeUndefined()
  })
})
