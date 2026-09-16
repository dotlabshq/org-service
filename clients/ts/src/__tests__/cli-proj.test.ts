/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { run, mocks, server } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const ORG_SLUG = 'acme'
const WS_SLUG  = 'staging'
const OPT      = ['--org', ORG_SLUG, '--ws', WS_SLUG]
const BASE     = `/orgs/${ORG_SLUG}/workspaces/${WS_SLUG}/projects`

const PROJ = {
  id:        '019f07cc-3333-7db6-956d-f323dfadba50',
  short_id:   'pj9abc',
  slug:      'api',
  name:      'API',
  is_default: true,
  created_at: 1782507760630,
  updated_at: 1782507760630,
}

const PROJ2 = {
  id:        '019f07cd-4444-7db6-956d-f323dfadba50',
  short_id:   'pjxyz1',
  slug:      'web',
  name:      'Web',
  is_default: false,
  created_at: 1782507760630,
  updated_at: 1782507760630,
}

// ── list ─────────────────────────────────────────────────────────────────────

describe('flect proj (list)', () => {
  it('default columns: ID → SLUG → NAME → DEFAULT', async () => {
    mocks.mockGet(BASE, { projects: [PROJ, PROJ2] })
    const r = await run(['proj', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('pj9abc')
    expect(r.stdout).toContain('api')
    expect(r.stdout).toContain('API')
    expect(r.stdout.indexOf('ID')).toBeLessThan(r.stdout.indexOf('SLUG'))
    expect(r.stdout.indexOf('SLUG')).toBeLessThan(r.stdout.indexOf('NAME'))
  })

  it('does not show full UUID in default view', async () => {
    mocks.mockGet(BASE, { projects: [PROJ] })
    const r = await run(['proj', ...OPT])
    expect(r.stdout).not.toContain(PROJ.id)
  })

  it('-o wide adds FULL ID column', async () => {
    mocks.mockGet(BASE, { projects: [PROJ] })
    const r = await run(['proj', '-o', 'wide', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(PROJ.id)
  })

  it('-o json returns raw JSON array', async () => {
    mocks.mockGet(BASE, { projects: [PROJ] })
    const r = await run(['proj', '-o', 'json', ...OPT])
    const parsed = JSON.parse(r.stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].short_id).toBe('pj9abc')
  })
})

// ── create ───────────────────────────────────────────────────────────────────

describe('flect proj create', () => {
  it('sends only name when no slug given', async () => {
    const captured = mocks.mockPostCapture(BASE, { project: PROJ })
    const r = await run(['proj', 'create', '--name', 'API', ...OPT])
    expect(r.exitCode).toBe(0)
    const body = captured.body as Record<string, unknown>
    expect(body.name).toBe('API')
    expect(body.slug).toBeUndefined()
  })

  it('sends explicit slug when provided', async () => {
    const captured = mocks.mockPostCapture(BASE, { project: PROJ })
    await run(['proj', 'create', '--name', 'API', '--slug', 'api', ...OPT])
    expect((captured.body as Record<string, unknown>).slug).toBe('api')
  })

  it('shows short_id in output, not full UUID', async () => {
    mocks.mockPost(BASE, { project: PROJ })
    const r = await run(['proj', 'create', '--name', 'API', ...OPT])
    expect(r.stdout).toContain('pj9abc')
    expect(r.stdout).not.toContain(PROJ.id)
  })
})

// ── get ───────────────────────────────────────────────────────────────────────

describe('flect proj get', () => {
  it('works with slug', async () => {
    mocks.mockGet(`${BASE}/api`, { project: PROJ })
    const r = await run(['proj', 'get', 'api', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('API')
  })

  it('works with short_id', async () => {
    mocks.mockGet(`${BASE}/pj9abc`, { project: PROJ })
    const r = await run(['proj', 'get', 'pj9abc', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('API')
  })

  it('id field shows short_id, full_id field shows UUID', async () => {
    mocks.mockGet(`${BASE}/api`, { project: PROJ })
    const r = await run(['proj', 'get', 'api', ...OPT])
    const lines  = r.stdout.split('\n')
    const idLine = lines.find(l => /^\s+id\s/.test(l))
    expect(idLine).toContain('pj9abc')
    expect(idLine).not.toContain(PROJ.id)
  })
})

// ── update ────────────────────────────────────────────────────────────────────

describe('flect proj update', () => {
  it('works with slug', async () => {
    const captured = mocks.mockPatchCapture(`${BASE}/api`, { project: { ...PROJ, name: 'API v2' } })
    const r = await run(['proj', 'update', 'api', '--name', 'API v2', ...OPT])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('API v2')
  })

  it('works with short_id', async () => {
    const captured = mocks.mockPatchCapture(`${BASE}/pj9abc`, { project: { ...PROJ, name: 'API v2' } })
    const r = await run(['proj', 'update', 'pj9abc', '--name', 'API v2', ...OPT])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('API v2')
  })
})

// ── delete ────────────────────────────────────────────────────────────────────

describe('flect proj delete', () => {
  it('works with slug', async () => {
    mocks.mockDelete(`${BASE}/api`)
    const r = await run(['proj', 'delete', 'api', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('api')
  })

  it('works with short_id', async () => {
    mocks.mockDelete(`${BASE}/pj9abc`)
    const r = await run(['proj', 'delete', 'pj9abc', ...OPT])
    expect(r.exitCode).toBe(0)
  })
})
