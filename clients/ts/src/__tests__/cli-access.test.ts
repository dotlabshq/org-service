/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { run, mocks, server } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// ── access role ────────────────────────────────────────────────────────────

describe('flect access role', () => {
  it('shows the effective role and where it comes from', async () => {
    mocks.mockGet('/authz/role', { role: 'owner', via: { scope_kind: 'org' } })
    const r = await run(['access', 'role', 'org-1'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('owner')
    expect(r.stdout).toContain('org')
  })
})

// ── access check ────────────────────────────────────────────────────────────

describe('flect access check', () => {
  it('exits 0 when allowed', async () => {
    mocks.mockPost('/authz/check', { allowed: true, role: 'owner', min_role: 'member' })
    const r = await run(['access', 'check', 'flect', 'deploy', 'proj-1'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('yes')
  })

  it('exits non-zero when denied', async () => {
    mocks.mockPost('/authz/check', { allowed: false, role: 'member', min_role: 'admin', reason: 'insufficient_role' })
    const r = await run(['access', 'check', 'flect', 'db.manage', 'proj-1'])
    expect(r.exitCode).not.toBe(0)
    expect(r.stdout).toContain('insufficient_role')
  })
})

// ── access app ──────────────────────────────────────────────────────────────

describe('flect access app', () => {
  it('list renders APP / ORIGIN', async () => {
    mocks.mockGet('/apps', { apps: [{ name: 'flect', origin: 'https://flect.cloud' }] })
    const r = await run(['access', 'app', 'list'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('flect')
    expect(r.stdout).toContain('flect.cloud')
  })

  it('policies renders ACTION / MIN ROLE', async () => {
    mocks.mockGet('/apps/flect/policies', {
      policies: [{ action: 'deploy', min_role: 'member' }, { action: 'db.manage', min_role: 'admin' }],
    })
    const r = await run(['access', 'app', 'policies', 'flect'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('deploy')
    expect(r.stdout).toContain('member')
  })
})
