/// <reference types="vitest/globals" />
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { createApiClient } from '@baseworks/cli/client'
import { createContextManager } from '@baseworks/cli/context'
import { runCommand } from '@baseworks/cli/testing'
import { addGlobalCommands, buildInvitesCommand } from '../cli.js'
import { mocks, server, TEST_BASE } from './helpers.js'

// A context of its own, so what `use` writes can be read back.
const APP = 'org-test-use'
const ctx = createContextManager(APP)
const program = () => {
  const http = createApiClient(() => 'test-token', () => TEST_BASE)
  const deps = { http, ctx, appBase: TEST_BASE, cliName: 'flect' }
  const p = new Command('flect').exitOverride().enablePositionalOptions()
  addGlobalCommands(p, deps)
  p.addCommand(buildInvitesCommand(deps))
  return p
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => { server.close(); rmSync(join(homedir(), `.${APP}`), { recursive: true, force: true }) })

const ORG = { id: 'org-full-id', short_id: 'n2shs8', slug: 'acme', name: 'Acme' }
const WS = { id: 'ws-full-id', short_id: 'xrjnvw', slug: 'default', name: 'Default', is_default: true }
const PROJ = { id: 'proj-full-id', short_id: '8gjvdq', slug: 'notes', name: 'notes' }
const ENV = { id: 'env-full-id', short_id: 'k4mr7t', slug: 'staging', name: 'staging' }

describe('flect use', () => {
  it('remembers every level by slug, by id and by short id', async () => {
    mocks.mockGet('/orgs/acme', { org: ORG })
    mocks.mockGet('/orgs/acme/workspaces', { workspaces: [WS] })
    mocks.mockGet('/orgs/acme/workspaces/default/projects', { projects: [PROJ] })
    mocks.mockGet('/orgs/acme/workspaces/default/projects/notes/envs', { envs: [ENV] })

    const r = await runCommand(program(), ['use', 'acme/default/notes/staging'])
    expect(r.exitCode).toBe(0)
    expect(ctx.getContext()).toMatchObject({
      org: 'acme', orgId: 'org-full-id', orgShort: 'n2shs8',
      workspace: 'default', workspaceId: 'ws-full-id', workspaceShort: 'xrjnvw',
      project: 'notes', projectId: 'proj-full-id', projectShort: '8gjvdq',
      env: 'staging', envId: 'env-full-id', envShort: 'k4mr7t',
    })
  })

  it('an org alone is remembered by its short id too', async () => {
    mocks.mockGet('/orgs/acme', { org: ORG })
    const r = await runCommand(program(), ['use', 'acme'])
    expect(r.exitCode).toBe(0)
    expect(ctx.getContext()).toMatchObject({ org: 'acme', orgId: 'org-full-id', orgShort: 'n2shs8' })
  })
})

describe('flect invites', () => {
  it('shows the org each invitation is from — the service sends org_name and org_slug', async () => {
    mocks.mockGet('/invitations', {
      invitations: [{ id: 'inv-1', org_id: 'org-full-id', org_name: 'Acme', org_slug: 'acme', email: 'a@b.c', role: 'member', invited_by: 'Deniz', created_at: 1782507760630, updated_at: 1782507760630 }],
    })
    const r = await runCommand(program(), ['invites'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Acme')
    expect(r.stdout).toContain('acme')
  })
})

describe('flect ls', () => {
  it('names only the levels that are selected', async () => {
    mocks.mockGet('/orgs/acme', { org: ORG })
    await runCommand(program(), ['use', 'acme'])
    mocks.mockGet('/orgs', { orgs: [ORG] })
    mocks.mockGet('/orgs/acme/workspaces', { workspaces: [WS] })
    mocks.mockGet('/orgs/acme/workspaces/default/projects', { projects: [PROJ] })
    const r = await runCommand(program(), ['ls'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/active: \S*acme/)
    expect(r.stdout).not.toContain('undefined')
  })
})
