import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp, makeToken } from './setup.js'

// ─── Helpers ─────────────────────────────────────────────────────

type App = Awaited<ReturnType<typeof createTestApp>>
let app: App

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

// Create a fresh in-memory DB for each test suite
beforeEach(async () => {
  app = await createTestApp()
})

// ─── Orgs ────────────────────────────────────────────────────────

describe('GET / — list orgs', () => {
  it('returns empty list when user has no orgs', async () => {
    const res = await app.get('/')
    expect(res.status).toBe(200)
    const body = await json<{ orgs: unknown[] }>(res)
    expect(body.orgs).toEqual([])
  })

  it('returns 401 without token', async () => {
    const res = await app.unauth('/')
    expect(res.status).toBe(401)
  })
})

describe('POST / — create org', () => {
  it('creates org with auto default ws/proj/env', async () => {
    const res = await app.post('/', { name: 'Acme', slug: 'acme' })
    expect(res.status).toBe(201)
    const { org } = await json<{ org: { id: string; slug: string; name: string } }>(res)
    expect(org.slug).toBe('acme')
    expect(org.name).toBe('Acme')

    // Verify default ws was created
    const wsRes = await app.get(`/${org.slug}/workspaces`)
    const { workspaces } = await json<{ workspaces: { slug: string }[] }>(wsRes)
    expect(workspaces.length).toBe(1)
    expect(workspaces[0]!.slug).toBe('default')

    // Verify default proj was created
    const projRes = await app.get(`/${org.slug}/workspaces/default/projects`)
    const { projects } = await json<{ projects: { slug: string }[] }>(projRes)
    expect(projects.length).toBe(1)
    expect(projects[0]!.slug).toBe('main')

    // Verify default env was created
    const envRes = await app.get(`/${org.slug}/workspaces/default/projects/main/envs`)
    const { envs } = await json<{ envs: { slug: string }[] }>(envRes)
    expect(envs.length).toBe(1)
    expect(envs[0]!.slug).toBe('production')
  })

  it('auto-generates slug from name when not provided', async () => {
    const res = await app.post('/', { name: 'My Company' })
    expect(res.status).toBe(201)
    const { org } = await json<{ org: { slug: string } }>(res)
    expect(org.slug).toMatch(/^[a-z0-9-]+$/)
  })

  it('appears in org list after creation', async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    const res = await app.get('/')
    const { orgs } = await json<{ orgs: { slug: string }[] }>(res)
    expect(orgs.some(o => o.slug === 'acme')).toBe(true)
  })
})

describe('GET /:ref — get org', () => {
  it('returns org by slug', async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    const res = await app.get('/acme')
    expect(res.status).toBe(200)
    const { org } = await json<{ org: { slug: string; name: string } }>(res)
    expect(org.slug).toBe('acme')
    expect(org.name).toBe('Acme')
  })

  it('returns 404 for unknown slug', async () => {
    const res = await app.get('/doesnotexist')
    expect(res.status).toBe(404)
  })
})

describe('PATCH /:ref — update org', () => {
  it('updates org name', async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    const res = await app.patch('/acme', { name: 'Acme Corp' })
    expect(res.status).toBe(200)
    const { org } = await json<{ org: { name: string } }>(res)
    expect(org.name).toBe('Acme Corp')
  })
})

describe('DELETE /:ref — delete org', () => {
  it('deletes org', async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    const del = await app.del('/acme')
    expect(del.status).toBe(200)
    const get = await app.get('/acme')
    expect(get.status).toBe(404)
  })
})

// ─── Workspaces ──────────────────────────────────────────────────

describe('Workspaces CRUD', () => {
  beforeEach(async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    // 'default' ws already exists from org provisioning
  })

  it('GET /:org/workspaces — lists workspaces', async () => {
    const res = await app.get('/acme/workspaces')
    expect(res.status).toBe(200)
    const { workspaces } = await json<{ workspaces: unknown[] }>(res)
    expect(workspaces.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /:org/workspaces — creates ws with default proj+env', async () => {
    const res = await app.post('/acme/workspaces', { name: 'Staging', slug: 'staging' })
    expect(res.status).toBe(201)
    const { workspace } = await json<{ workspace: { slug: string } }>(res)
    expect(workspace.slug).toBe('staging')

    // Verify default proj was created
    const projRes = await app.get('/acme/workspaces/staging/projects')
    const { projects } = await json<{ projects: { slug: string }[] }>(projRes)
    expect(projects.length).toBe(1)
    expect(projects[0]!.slug).toBe('main')

    // Verify default env was created
    const envRes = await app.get('/acme/workspaces/staging/projects/main/envs')
    const { envs } = await json<{ envs: { slug: string }[] }>(envRes)
    expect(envs[0]!.slug).toBe('production')
  })

  it('GET /:org/workspaces/:ws — gets specific workspace', async () => {
    const res = await app.get('/acme/workspaces/default')
    expect(res.status).toBe(200)
    const { workspace } = await json<{ workspace: { slug: string } }>(res)
    expect(workspace.slug).toBe('default')
  })

  it('GET /:org/workspaces/:ws — 404 for unknown workspace', async () => {
    const res = await app.get('/acme/workspaces/nope')
    expect(res.status).toBe(404)
  })

  it('PATCH /:org/workspaces/:ws — updates name', async () => {
    const res = await app.patch('/acme/workspaces/default', { name: 'Default WS' })
    expect(res.status).toBe(200)
    const { workspace } = await json<{ workspace: { name: string } }>(res)
    expect(workspace.name).toBe('Default WS')
  })

  it('DELETE /:org/workspaces/:ws — deletes workspace', async () => {
    await app.post('/acme/workspaces', { name: 'Temp', slug: 'temp' })
    const del = await app.del('/acme/workspaces/temp')
    expect(del.status).toBe(200)
    const get = await app.get('/acme/workspaces/temp')
    expect(get.status).toBe(404)
  })
})

// ─── Projects ────────────────────────────────────────────────────

describe('Projects CRUD', () => {
  beforeEach(async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    // org create already provisioned: default ws → main proj → production env
  })

  it('GET /:org/workspaces/:ws/projects — lists projects', async () => {
    const res = await app.get('/acme/workspaces/default/projects')
    expect(res.status).toBe(200)
    const { projects } = await json<{ projects: unknown[] }>(res)
    expect(projects.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /:org/workspaces/:ws/projects — creates proj with default env', async () => {
    const res = await app.post('/acme/workspaces/default/projects', { name: 'Beta', slug: 'beta' })
    expect(res.status).toBe(201)
    const { project } = await json<{ project: { slug: string } }>(res)
    expect(project.slug).toBe('beta')

    // Verify default env was created
    const envRes = await app.get('/acme/workspaces/default/projects/beta/envs')
    const { envs } = await json<{ envs: { slug: string }[] }>(envRes)
    expect(envs.length).toBe(1)
    expect(envs[0]!.slug).toBe('production')
  })

  it('GET /:org/workspaces/:ws/projects/:proj — gets specific project', async () => {
    const res = await app.get('/acme/workspaces/default/projects/main')
    expect(res.status).toBe(200)
    const { project } = await json<{ project: { slug: string } }>(res)
    expect(project.slug).toBe('main')
  })

  it('GET /:org/workspaces/:ws/projects/:proj — 404 for unknown', async () => {
    const res = await app.get('/acme/workspaces/default/projects/nope')
    expect(res.status).toBe(404)
  })

  it('DELETE /:org/workspaces/:ws/projects/:proj — deletes project', async () => {
    await app.post('/acme/workspaces/default/projects', { name: 'Temp', slug: 'temp' })
    const del = await app.del('/acme/workspaces/default/projects/temp')
    expect(del.status).toBe(200)
    const get = await app.get('/acme/workspaces/default/projects/temp')
    expect(get.status).toBe(404)
  })
})

// ─── Environments ─────────────────────────────────────────────────

describe('Environments CRUD', () => {
  const envBase = '/acme/workspaces/default/projects/main/envs'

  beforeEach(async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    // production env already exists from provisioning
  })

  it('GET envs — lists envs', async () => {
    const res = await app.get(envBase)
    expect(res.status).toBe(200)
    const { envs } = await json<{ envs: unknown[] }>(res)
    expect(envs.length).toBeGreaterThanOrEqual(1)
  })

  it('POST envs — creates env', async () => {
    const res = await app.post(envBase, { name: 'Staging', slug: 'staging' })
    expect(res.status).toBe(201)
    const { env } = await json<{ env: { slug: string; name: string } }>(res)
    expect(env.slug).toBe('staging')
    expect(env.name).toBe('Staging')
  })

  it('POST envs — auto-generates slug', async () => {
    const res = await app.post(envBase, { name: 'Dev Environment' })
    expect(res.status).toBe(201)
    const { env } = await json<{ env: { slug: string } }>(res)
    expect(env.slug).toMatch(/^[a-z0-9-]+$/)
  })

  it('POST envs — env appears in list', async () => {
    await app.post(envBase, { name: 'Staging', slug: 'staging' })
    const res = await app.get(envBase)
    const { envs } = await json<{ envs: { slug: string }[] }>(res)
    expect(envs.some(e => e.slug === 'staging')).toBe(true)
    expect(envs.some(e => e.slug === 'production')).toBe(true)
  })

  it('DELETE envs/:ref — deletes env', async () => {
    await app.post(envBase, { name: 'Temp', slug: 'temp' })
    const del = await app.del(`${envBase}/temp`)
    expect(del.status).toBe(200)
    const list = await app.get(envBase)
    const { envs } = await json<{ envs: { slug: string }[] }>(list)
    expect(envs.some(e => e.slug === 'temp')).toBe(false)
  })

  it('DELETE envs/:ref — 404 for unknown env', async () => {
    const del = await app.del(`${envBase}/nope`)
    expect(del.status).toBe(404)
  })
})

// ─── Auth ────────────────────────────────────────────────────────

describe('Auth isolation', () => {
  it('user cannot see another user\'s orgs', async () => {
    // User A creates org
    await app.post('/', { name: 'Acme', slug: 'acme' })

    // User B sees empty list
    const tokenB = makeToken('user-b-999')
    const res = await app.get('/', tokenB)
    const { orgs } = await json<{ orgs: unknown[] }>(res)
    expect(orgs).toEqual([])
  })

  it('user cannot access workspace of org they are not member of', async () => {
    await app.post('/', { name: 'Acme', slug: 'acme' })
    const tokenB = makeToken('user-b-999')
    const res = await app.get('/acme/workspaces', tokenB)
    expect(res.status).toBe(404)
  })
})
