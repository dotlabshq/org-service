/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { run, mocks, server } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const ORG = {
  id:        '019f05bd-ebf7-7db6-956d-f323dfadba50',
  short_id:   'n2shs8',
  slug:      'acme',
  name:      'Acme',
  metadata:  null,
  created_at: 1782507760630,
  updated_at: 1782507760630,
}

const ORG2 = {
  id:        '019f05bc-8f7c-716d-8530-3a3683ea2411',
  short_id:   'kf5wnb',
  slug:      'acme',
  name:      'Acme Inc',
  metadata:  null,
  created_at: 1782507671419,
  updated_at: 1782507671419,
}

// ── list ─────────────────────────────────────────────────────────────────────

describe('flect org (list)', () => {
  it('default columns: ID (short_id) → SLUG → NAME', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG, ORG2] })
    const r = await run(['org'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('n2shs8')
    expect(r.stdout).toContain('acme')
    expect(r.stdout).toContain('Acme')
    expect(r.stdout.indexOf('ID')).toBeLessThan(r.stdout.indexOf('SLUG'))
    expect(r.stdout.indexOf('SLUG')).toBeLessThan(r.stdout.indexOf('NAME'))
  })

  it('does not show full UUID in default view', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG] })
    const r = await run(['org'])
    expect(r.stdout).not.toContain(ORG.id)
  })

  it('-o wide adds CREATED and FULL ID columns', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG] })
    const r = await run(['org', '-o', 'wide'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('CREATED')
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(ORG.id)
  })

  it('-o json returns raw JSON array', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG] })
    const r = await run(['org', '-o', 'json'])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].short_id).toBe('n2shs8')
  })
})

// ── plural alias + ls subcommand ──────────────────────────────────────────────

describe('flect orgs (plural alias) and ls subcommand', () => {
  it('`orgs` plural alias lists like the bare command', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG, ORG2] })
    const r = await run(['orgs'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('n2shs8')
    expect(r.stdout).toContain('acme')
  })

  it('`org ls` runs the list action', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG] })
    const r = await run(['org', 'ls'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('n2shs8')
  })

  it('`orgs ls` runs the list action', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG] })
    const r = await run(['orgs', 'ls'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('n2shs8')
  })

  it('`orgs ls -o wide` still shows FULL ID', async () => {
    mocks.mockGet('/orgs', { orgs: [ORG] })
    const r = await run(['orgs', 'ls', '-o', 'wide'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(ORG.id)
  })

  it('`orgs create` works through the plural alias', async () => {
    const captured = mocks.mockPostCapture('/orgs', { org: ORG })
    const r = await run(['orgs', 'create', '--name', 'Acme', '--slug', 'acme'])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).slug).toBe('acme')
  })
})

// ── create ───────────────────────────────────────────────────────────────────

describe('flect org create', () => {
  it('sends only name when no slug given (API generates slug from name)', async () => {
    const captured = mocks.mockPostCapture('/orgs', { org: { ...ORG, slug: 'my-org', short_id: 'abc123' } })
    const r = await run(['org', 'create', '--name', 'My Org'])
    expect(r.exitCode).toBe(0)
    const body = captured.body as Record<string, unknown>
    expect(body.name).toBe('My Org')
    expect(body.slug).toBeUndefined()
  })

  it('sends explicit slug when provided', async () => {
    const captured = mocks.mockPostCapture('/orgs', { org: ORG })
    await run(['org', 'create', '--name', 'Acme', '--slug', 'acme'])
    expect((captured.body as Record<string, unknown>).slug).toBe('acme')
  })

  it('shows short_id (not full UUID) in output', async () => {
    mocks.mockPost('/orgs', { org: ORG })
    const r = await run(['org', 'create', '--name', 'Acme'])
    expect(r.stdout).toContain('n2shs8')
    expect(r.stdout).not.toContain(ORG.id)
  })
})

// ── get ───────────────────────────────────────────────────────────────────────

describe('flect org get', () => {
  it('works with slug', async () => {
    mocks.mockGet('/orgs/acme', { org: ORG })
    const r = await run(['org', 'get', 'acme'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Acme')
  })

  it('works with short_id', async () => {
    mocks.mockGet('/orgs/n2shs8', { org: ORG })
    const r = await run(['org', 'get', 'n2shs8'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Acme')
  })

  it('id field shows short_id, full_id field shows UUID', async () => {
    mocks.mockGet('/orgs/acme', { org: ORG })
    const r = await run(['org', 'get', 'acme'])
    const lines = r.stdout.split('\n')
    const idLine = lines.find(l => /^\s+id\s/.test(l))
    expect(idLine).toContain('n2shs8')
    expect(idLine).not.toContain(ORG.id)
  })
})

// ── update ────────────────────────────────────────────────────────────────────

describe('flect org update', () => {
  it('works with slug', async () => {
    const captured = mocks.mockPatchCapture('/orgs/acme', { org: { ...ORG, name: 'Acme HQ' } })
    const r = await run(['org', 'update', 'acme', '--name', 'Acme HQ'])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('Acme HQ')
  })

  it('works with short_id', async () => {
    const captured = mocks.mockPatchCapture('/orgs/n2shs8', { org: { ...ORG, name: 'Acme HQ' } })
    const r = await run(['org', 'update', 'n2shs8', '--name', 'Acme HQ'])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('Acme HQ')
  })
})

// ── delete ────────────────────────────────────────────────────────────────────

describe('flect org delete', () => {
  it('works with slug', async () => {
    mocks.mockDelete('/orgs/acme')
    const r = await run(['org', 'delete', 'acme'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('acme')
  })

  it('works with short_id', async () => {
    mocks.mockDelete('/orgs/n2shs8')
    const r = await run(['org', 'delete', 'n2shs8'])
    expect(r.exitCode).toBe(0)
  })
})
