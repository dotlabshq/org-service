/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { run, mocks, server } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const ORG_SLUG  = 'acme'
const WS_SLUG   = 'staging'
const PROJ_SLUG = 'api'
const OPT       = ['--org', ORG_SLUG, '--ws', WS_SLUG, '--proj', PROJ_SLUG]
const BASE      = `/orgs/${ORG_SLUG}/workspaces/${WS_SLUG}/projects/${PROJ_SLUG}/envs`

const ENV = {
  id:        '019f08dd-5555-7db6-956d-f323dfadba50',
  short_id:   'ev1abc',
  slug:      'production',
  name:      'Production',
  is_default: true,
  created_at: 1782507760630,
  updated_at: 1782507760630,
}

const ENV2 = {
  id:        '019f08de-6666-7db6-956d-f323dfadba50',
  short_id:   'ev2xyz',
  slug:      'preview',
  name:      'Preview',
  is_default: false,
  created_at: 1782507760630,
  updated_at: 1782507760630,
}

// ── list ─────────────────────────────────────────────────────────────────────

describe('flect env (list)', () => {
  it('default columns: ID → SLUG → NAME → DEFAULT', async () => {
    mocks.mockGet(BASE, { envs: [ENV, ENV2] })
    const r = await run(['env', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('ev1abc')
    expect(r.stdout).toContain('production')
    expect(r.stdout).toContain('Production')
    expect(r.stdout.indexOf('ID')).toBeLessThan(r.stdout.indexOf('SLUG'))
    expect(r.stdout.indexOf('SLUG')).toBeLessThan(r.stdout.indexOf('NAME'))
  })

  it('does not show full UUID in default view', async () => {
    mocks.mockGet(BASE, { envs: [ENV] })
    const r = await run(['env', ...OPT])
    expect(r.stdout).not.toContain(ENV.id)
  })

  it('-o wide adds FULL ID column', async () => {
    mocks.mockGet(BASE, { envs: [ENV] })
    const r = await run(['env', '-o', 'wide', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(ENV.id)
  })

  it('-o json returns raw JSON array', async () => {
    mocks.mockGet(BASE, { envs: [ENV] })
    const r = await run(['env', '-o', 'json', ...OPT])
    const parsed = JSON.parse(r.stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].short_id).toBe('ev1abc')
  })
})

// ── create ───────────────────────────────────────────────────────────────────

describe('flect env create', () => {
  it('sends only name when no slug given', async () => {
    const captured = mocks.mockPostCapture(BASE, { env: ENV })
    const r = await run(['env', 'create', '--name', 'Production', ...OPT])
    expect(r.exitCode).toBe(0)
    const body = captured.body as Record<string, unknown>
    expect(body.name).toBe('Production')
    expect(body.slug).toBeUndefined()
  })

  it('sends explicit slug when provided', async () => {
    const captured = mocks.mockPostCapture(BASE, { env: ENV })
    await run(['env', 'create', '--name', 'Production', '--slug', 'production', ...OPT])
    expect((captured.body as Record<string, unknown>).slug).toBe('production')
  })

  it('shows short_id in output, not full UUID', async () => {
    mocks.mockPost(BASE, { env: ENV })
    const r = await run(['env', 'create', '--name', 'Production', ...OPT])
    expect(r.stdout).toContain('ev1abc')
    expect(r.stdout).not.toContain(ENV.id)
  })
})

// ── get ───────────────────────────────────────────────────────────────────────

describe('flect env get', () => {
  it('works with slug', async () => {
    mocks.mockGet(`${BASE}/production`, { env: ENV })
    const r = await run(['env', 'get', 'production', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Production')
  })

  it('works with short_id', async () => {
    mocks.mockGet(`${BASE}/ev1abc`, { env: ENV })
    const r = await run(['env', 'get', 'ev1abc', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Production')
  })

  it('id field shows short_id, full_id field shows UUID', async () => {
    mocks.mockGet(`${BASE}/production`, { env: ENV })
    const r = await run(['env', 'get', 'production', ...OPT])
    const lines  = r.stdout.split('\n')
    const idLine = lines.find(l => /^\s+id\s/.test(l))
    expect(idLine).toContain('ev1abc')
    expect(idLine).not.toContain(ENV.id)
  })
})

// ── update ────────────────────────────────────────────────────────────────────

describe('flect env update', () => {
  it('works with slug', async () => {
    const captured = mocks.mockPatchCapture(`${BASE}/production`, { env: { ...ENV, name: 'Production v2' } })
    const r = await run(['env', 'update', 'production', '--name', 'Production v2', ...OPT])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('Production v2')
  })

  it('works with short_id', async () => {
    const captured = mocks.mockPatchCapture(`${BASE}/ev1abc`, { env: { ...ENV, name: 'Production v2' } })
    const r = await run(['env', 'update', 'ev1abc', '--name', 'Production v2', ...OPT])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('Production v2')
  })
})

// ── delete ────────────────────────────────────────────────────────────────────

describe('flect env delete', () => {
  it('works with slug', async () => {
    mocks.mockDelete(`${BASE}/production`)
    const r = await run(['env', 'delete', 'production', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('production')
  })

  it('works with short_id', async () => {
    mocks.mockDelete(`${BASE}/ev1abc`)
    const r = await run(['env', 'delete', 'ev1abc', ...OPT])
    expect(r.exitCode).toBe(0)
  })
})
