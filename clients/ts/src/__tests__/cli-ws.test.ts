/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { run, mocks, server } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// use --org flag to override active org (context is empty in tests)
const ORG_SLUG = 'acme'
const OPT      = ['--org', ORG_SLUG]

const WS = {
  id:        '019f06aa-1111-7db6-956d-f323dfadba50',
  short_id:   'ws1234',
  slug:      'staging',
  name:      'Staging',
  is_default: true,
  created_at: 1782507760630,
  updated_at: 1782507760630,
}

const WS2 = {
  id:        '019f06ab-2222-7db6-956d-f323dfadba50',
  short_id:   'ws5678',
  slug:      'production',
  name:      'Production',
  is_default: false,
  created_at: 1782507760630,
  updated_at: 1782507760630,
}

// ── plural alias + ls subcommand ──────────────────────────────────────────────

describe('flect workspaces (plural alias) and ws ls', () => {
  it('`workspaces` plural alias lists', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces`, { workspaces: [WS, WS2] })
    const r = await run(['workspaces', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('ws1234')
  })

  it('`ws ls` runs the list action and honors --org override', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces`, { workspaces: [WS] })
    const r = await run(['ws', 'ls', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('ws1234')
  })

  it('`workspaces ls -o wide` shows FULL ID', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces`, { workspaces: [WS] })
    const r = await run(['workspaces', 'ls', '-o', 'wide', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(WS.id)
  })
})

// ── list ─────────────────────────────────────────────────────────────────────

describe('flect ws (list)', () => {
  it('default columns: ID → SLUG → NAME → DEFAULT', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces`, { workspaces: [WS, WS2] })
    const r = await run(['ws', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('ws1234')
    expect(r.stdout).toContain('staging')
    expect(r.stdout).toContain('Staging')
    expect(r.stdout.indexOf('ID')).toBeLessThan(r.stdout.indexOf('SLUG'))
    expect(r.stdout.indexOf('SLUG')).toBeLessThan(r.stdout.indexOf('NAME'))
  })

  it('does not show full UUID in default view', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces`, { workspaces: [WS] })
    const r = await run(['ws', ...OPT])
    expect(r.stdout).not.toContain(WS.id)
  })

  it('-o wide adds FULL ID column', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces`, { workspaces: [WS] })
    const r = await run(['ws', '-o', 'wide', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(WS.id)
  })

  it('-o json returns raw JSON array', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces`, { workspaces: [WS] })
    const r = await run(['ws', '-o', 'json', ...OPT])
    const parsed = JSON.parse(r.stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].short_id).toBe('ws1234')
  })
})

// ── create ───────────────────────────────────────────────────────────────────

describe('flect ws create', () => {
  it('sends only name when no slug given', async () => {
    const captured = mocks.mockPostCapture(`/orgs/${ORG_SLUG}/workspaces`, { workspace: WS })
    const r = await run(['ws', 'create', '--name', 'Staging', ...OPT])
    expect(r.exitCode).toBe(0)
    const body = captured.body as Record<string, unknown>
    expect(body.name).toBe('Staging')
    expect(body.slug).toBeUndefined()
  })

  it('sends explicit slug when provided', async () => {
    const captured = mocks.mockPostCapture(`/orgs/${ORG_SLUG}/workspaces`, { workspace: WS })
    await run(['ws', 'create', '--name', 'Staging', '--slug', 'staging', ...OPT])
    expect((captured.body as Record<string, unknown>).slug).toBe('staging')
  })

  it('shows short_id in output, not full UUID', async () => {
    mocks.mockPost(`/orgs/${ORG_SLUG}/workspaces`, { workspace: WS })
    const r = await run(['ws', 'create', '--name', 'Staging', ...OPT])
    expect(r.stdout).toContain('ws1234')
    expect(r.stdout).not.toContain(WS.id)
  })
})

// ── get ───────────────────────────────────────────────────────────────────────

describe('flect ws get', () => {
  it('works with slug', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces/staging`, { workspace: WS })
    const r = await run(['ws', 'get', 'staging', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Staging')
  })

  it('works with short_id', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces/ws1234`, { workspace: WS })
    const r = await run(['ws', 'get', 'ws1234', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Staging')
  })

  it('id field shows short_id, full_id field shows UUID', async () => {
    mocks.mockGet(`/orgs/${ORG_SLUG}/workspaces/staging`, { workspace: WS })
    const r = await run(['ws', 'get', 'staging', ...OPT])
    const lines  = r.stdout.split('\n')
    const idLine = lines.find(l => /^\s+id\s/.test(l))
    expect(idLine).toContain('ws1234')
    expect(idLine).not.toContain(WS.id)
  })
})

// ── update ────────────────────────────────────────────────────────────────────

describe('flect ws update', () => {
  it('works with slug', async () => {
    const captured = mocks.mockPatchCapture(`/orgs/${ORG_SLUG}/workspaces/staging`, { workspace: { ...WS, name: 'Staging Env' } })
    const r = await run(['ws', 'update', 'staging', '--name', 'Staging Env', ...OPT])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('Staging Env')
  })

  it('works with short_id', async () => {
    const captured = mocks.mockPatchCapture(`/orgs/${ORG_SLUG}/workspaces/ws1234`, { workspace: { ...WS, name: 'Staging Env' } })
    const r = await run(['ws', 'update', 'ws1234', '--name', 'Staging Env', ...OPT])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('Staging Env')
  })
})

// ── delete ────────────────────────────────────────────────────────────────────

describe('flect ws delete', () => {
  it('works with slug', async () => {
    mocks.mockDelete(`/orgs/${ORG_SLUG}/workspaces/staging`)
    const r = await run(['ws', 'delete', 'staging', ...OPT])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('staging')
  })

  it('works with short_id', async () => {
    mocks.mockDelete(`/orgs/${ORG_SLUG}/workspaces/ws1234`)
    const r = await run(['ws', 'delete', 'ws1234', ...OPT])
    expect(r.exitCode).toBe(0)
  })
})
