/**
 * The contract: what @baseworks/org (the client and the CLI) believes about
 * this service, checked against this service.
 *
 * The client's own tests run against hand-written fixtures, so they test the
 * client against its author's memory of the API. Twice that memory was wrong
 * and nothing failed: the CLI read `orgName` while the service sent
 * `org_name`, and read `via` without `scope_id`. Here the real client and the
 * real CLI talk over a real socket to a real org-service on a real foldbase.
 *
 * Every response is held to the client's declared type in both directions:
 * each required field is present, and no field arrives that the type does not
 * name. A rename on either side fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Command } from 'commander'
import { createApiClient } from '@baseworks/cli/client'
import { createContextManager } from '@baseworks/cli/context'
import { runCommand } from '@baseworks/cli/testing'
import { createOrgClient, type OrgClient } from '../../clients/ts/src/client.js'
import {
  addGlobalCommands, buildAccessCommand, buildEnvCommand, buildInvitesCommand,
  buildOrgCommand, buildProjCommand, buildWsCommand,
} from '../../clients/ts/src/cli.js'
import type {
  CheckResult, EffectiveRole, Invitation, Membership, Organization, RegisteredApp, AppPolicy, Scope,
} from '../../clients/ts/src/types.js'
import { bootTestFoldBase, makeServiceToken, makeTestApp, makeToken, USER_ID, type TestFoldBase } from './setup.js'

// ── the shape check ─────────────────────────────────────────────────────────

type Presence = 'req' | 'opt'
/** Every key of T, each marked required or optional — the compiler insists on all of them. */
type Spec<T> = { [K in keyof Required<T>]: Presence }

function expectShape<T>(value: unknown, spec: Spec<T>, what: string): asserts value is T {
  expect(value, what).toBeTypeOf('object')
  const got = Object.keys(value as object)
  const known = Object.keys(spec)
  const missing = known.filter((k) => spec[k as keyof Spec<T>] === 'req' && !got.includes(k))
  const unknown = got.filter((k) => !known.includes(k))
  expect({ what, missing, unknown }).toEqual({ what, missing: [], unknown: [] })
}

const ORG: Spec<Organization> = {
  id: 'req', short_id: 'req', slug: 'req', name: 'req', metadata: 'req',
  created_at: 'req', updated_at: 'req', role: 'opt',
}
const SCOPE: Spec<Scope> = {
  id: 'req', org_id: 'req', parent_id: 'req', kind: 'req', short_id: 'req', slug: 'req', name: 'req',
  is_default: 'req', created_at: 'req', updated_at: 'req',
}
const MEMBER: Spec<Membership> = {
  id: 'req', org_id: 'req', user_id: 'req', role: 'req', created_at: 'req', updated_at: 'req',
  email: 'opt', name: 'opt',
}
const INVITATION: Spec<Invitation> = {
  id: 'req', org_id: 'req', email: 'req', role: 'req', invited_by: 'req',
  invited_by_email: 'opt', invited_by_name: 'opt', created_at: 'req', updated_at: 'req',
  org_slug: 'opt', org_name: 'opt',
}
const ROLE: Spec<EffectiveRole> = { role: 'req', via: 'opt' }
const VIA: Spec<NonNullable<EffectiveRole['via']>> = { scope_id: 'req', scope_kind: 'req' }
const VERDICT: Spec<CheckResult> = { allowed: 'req', role: 'req', min_role: 'opt', reason: 'opt' }
const APP: Spec<RegisteredApp> = { id: 'req', name: 'req', origin: 'req', created_at: 'req', updated_at: 'req' }
const POLICY: Spec<AppPolicy> = { id: 'req', app: 'req', action: 'req', min_role: 'req', created_at: 'req', updated_at: 'req' }

// ── one real service on a real port ─────────────────────────────────────────

const OWNER_EMAIL = 'owner@contract.test'
const INVITEE = 'user-contract-invitee'
const INVITEE_EMAIL = 'invitee@contract.test'
const OTHER = 'user-contract-other'

let fb: TestFoldBase
let server: ServerType
let base: string

beforeAll(async () => {
  fb = await bootTestFoldBase()
  const { app } = await makeTestApp(fb)
  server = await new Promise<ServerType>((ok) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => ok(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}, 30_000)

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()))
  await fb.stop()
  rmSync(join(homedir(), `.${CTX_APP}`), { recursive: true, force: true })
})

const client = (token = makeToken(USER_ID, OWNER_EMAIL)): OrgClient => createOrgClient({ baseUrl: base, token })

// A context directory of its own, removed afterwards.
const CTX_APP = 'org-contract-test'
const ctx = createContextManager(CTX_APP)
function cli(token = makeToken(USER_ID, OWNER_EMAIL)) {
  const http = createApiClient(() => token, () => base)
  const deps = { http, ctx, appBase: base, cliName: 'flect' }
  const p = new Command('flect').exitOverride().enablePositionalOptions()
  addGlobalCommands(p, deps)
  for (const build of [buildOrgCommand, buildWsCommand, buildProjCommand, buildEnvCommand, buildAccessCommand, buildInvitesCommand]) {
    p.addCommand(build(deps))
  }
  return (...args: string[]) => runCommand(p, args)
}

// ── the client ──────────────────────────────────────────────────────────────

// Built up across the suite, in order: an org, its scopes, an app.
let org: Organization
let ws: Scope
let proj: Scope
let env: Scope

describe('the client against the service', () => {
  it('orgs: create, list, read, rename, metadata', async () => {
    const c = client()
    org = await c.createOrg({ name: 'Contract Co', slug: 'contract-co' })
    expectShape<Organization>(org, ORG, 'createOrg')
    expect(org.role).toBe('owner')

    const [listed] = await c.listOrgs()
    expectShape<Organization>(listed, ORG, 'listOrgs[]')
    expect(listed!.short_id).toBe(org.short_id)

    for (const ref of [org.slug, org.short_id, org.id]) {
      expectShape<Organization>(await c.getOrg(ref), ORG, `getOrg(${ref})`)
    }

    const renamed = await c.updateOrg(org.short_id, { name: 'Contract Company' })
    expectShape<Organization>(renamed, ORG, 'updateOrg')
    expect(renamed.name).toBe('Contract Company')

    await c.setOrgMetadata(org.short_id, { plan: 'pro', seats: 3 })
    expect((await c.getOrg(org.short_id)).metadata).toEqual({ plan: 'pro', seats: 3 })
    await c.deleteOrgMetadataKey(org.short_id, 'seats')
    expect((await c.getOrg(org.short_id)).metadata).toEqual({ plan: 'pro' })
  })

  it('scopes: the default chain, new ones at each level, and lookup anywhere by short id or id', async () => {
    const c = client()
    const [defaultWs] = await c.listWorkspaces(org.short_id)
    expectShape<Scope>(defaultWs, SCOPE, 'listWorkspaces[]')
    expect(defaultWs!.is_default).toBe(true)

    ws = await c.createWorkspace(org.short_id, { name: 'Platform' })
    expectShape<Scope>(ws, SCOPE, 'createWorkspace')
    proj = await c.createProject(org.short_id, ws.short_id, { name: 'Notes' })
    expectShape<Scope>(proj, SCOPE, 'createProject')
    env = await c.createEnvironment(org.short_id, ws.short_id, proj.short_id, { name: 'Staging' })
    expectShape<Scope>(env, SCOPE, 'createEnvironment')
    expect([ws.kind, proj.kind, env.kind]).toEqual(['workspace', 'project', 'environment'])
    expect(env.parent_id).toBe(proj.id)

    expectShape<Scope>((await c.listProjects(org.short_id, ws.short_id))[0], SCOPE, 'listProjects[]')
    const envs = await c.listEnvironments(org.short_id, ws.short_id, proj.short_id)
    for (const e of envs) expectShape<Scope>(e, SCOPE, 'listEnvironments[]')
    expect(envs.map((e) => e.short_id)).toContain(env.short_id)

    for (const ref of [env.short_id, env.id]) {
      const found = await c.scope(org.short_id, ref)
      expectShape<Scope>(found, SCOPE, `scope(${ref})`)
      expect(found.id).toBe(env.id)
    }
  })

  it('members: add, change role, remove', async () => {
    const c = client()
    for (const m of await c.listMembers(org.short_id)) expectShape<Membership>(m, MEMBER, 'listMembers[]')

    const added = await c.addMember(org.short_id, { user_id: OTHER, role: 'member' })
    expectShape<Membership>(added, MEMBER, 'addMember')
    const changed = await c.changeMemberRole(org.short_id, OTHER, 'admin')
    expectShape<Membership>(changed, MEMBER, 'changeMemberRole')
    expect(changed.role).toBe('admin')

    await c.removeMember(org.short_id, OTHER)
    expect((await c.listMembers(org.short_id)).map((m) => m.user_id)).not.toContain(OTHER)
  })

  it('invitations: the org side, the invitee side with the org named, accept, decline, revoke', async () => {
    const owner = client()
    const invitee = client(makeToken(INVITEE, INVITEE_EMAIL))

    const sent = await owner.createInvitation(org.short_id, { email: INVITEE_EMAIL, role: 'member' })
    expectShape<Invitation>(sent, INVITATION, 'createInvitation')
    for (const i of await owner.listInvitations(org.short_id)) expectShape<Invitation>(i, INVITATION, 'listInvitations[]')

    const [mine] = await invitee.listMyInvitations()
    expectShape<Invitation>(mine, INVITATION, 'listMyInvitations[]')
    // What the CLI's `invites` table shows: the org, by name and slug.
    expect(mine).toMatchObject({ org_name: 'Contract Company', org_slug: 'contract-co' })

    const joined = await invitee.acceptInvitation(mine!.id)
    expectShape<Membership>(joined, MEMBER, 'acceptInvitation')
    expect(joined.user_id).toBe(INVITEE)

    const second = await owner.createInvitation(org.short_id, { email: 'declines@contract.test', role: 'member' })
    await client(makeToken('user-decliner', 'declines@contract.test')).declineInvitation(second.id)
    const third = await owner.createInvitation(org.short_id, { email: 'revoked@contract.test', role: 'member' })
    await owner.revokeInvitation(org.short_id, third.id)
    expect(await owner.listInvitations(org.short_id)).toEqual([])
  })

  it('the PDP: effective role, app registry, policies, a verdict', async () => {
    const c = client()
    const role = await c.effectiveRole(env.id)
    expectShape<EffectiveRole>(role, ROLE, 'effectiveRole')
    expectShape<NonNullable<EffectiveRole['via']>>(role.via, VIA, 'effectiveRole.via')
    expect(role).toEqual({ role: 'owner', via: { scope_id: org.id, scope_kind: 'org' } })
    // Asking about somebody else, and registering an app, are a service's to
    // do: the app's own identity, here.
    const asApp = client(makeServiceToken('contract-app'))
    expect((await asApp.effectiveRole(env.id, INVITEE)).role).toBe('member')

    const app = await asApp.registerApp({ name: 'contract-app', origin: 'http://app.test', actions: { deploy: 'admin', read: 'viewer' } })
    expectShape<RegisteredApp>(app, APP, 'registerApp')
    for (const a of await c.listApps()) expectShape<RegisteredApp>(a, APP, 'listApps[]')
    const policies = await c.listAppPolicies('contract-app')
    for (const p of policies) expectShape<AppPolicy>(p, POLICY, 'listAppPolicies[]')
    expect(policies.map((p) => [p.action, p.min_role]).sort()).toEqual([['deploy', 'admin'], ['read', 'viewer']])

    const yes = await c.check({ app: 'contract-app', action: 'deploy', scopeId: env.id })
    expectShape<CheckResult>(yes, VERDICT, 'check(allowed)')
    expect(yes.allowed).toBe(true)
    const no = await asApp.check({ app: 'contract-app', action: 'deploy', scopeId: env.id, userId: INVITEE })
    expectShape<CheckResult>(no, VERDICT, 'check(denied)')
    expect(no).toMatchObject({ allowed: false, role: 'member', min_role: 'admin', reason: 'insufficient_role' })
  })
})

// ── the CLI ─────────────────────────────────────────────────────────────────

describe('the CLI against the service', () => {
  it('use remembers every level by slug, id and short id', async () => {
    const r = await cli()('use', `${org.slug}/${ws.slug}/${proj.slug}/${env.slug}`)
    expect(r.stderr).toBe('')
    expect(r.exitCode).toBe(0)
    expect(ctx.getContext()).toMatchObject({
      org: org.slug, orgId: org.id, orgShort: org.short_id,
      workspace: ws.slug, workspaceId: ws.id, workspaceShort: ws.short_id,
      project: proj.slug, projectId: proj.id, projectShort: proj.short_id,
      env: env.slug, envId: env.id, envShort: env.short_id,
    })
  })

  it('every list shows what the service sent', async () => {
    const run = cli()
    const expectShown = async (args: string[], values: string[]) => {
      const r = await run(...args)
      expect(r.exitCode, `${args.join(' ')}: ${r.stderr}`).toBe(0)
      for (const v of values) expect(r.stdout, `${args.join(' ')} shows ${v}`).toContain(v)
    }
    await expectShown(['org', 'ls'], [org.short_id, org.slug, 'Contract Company'])
    await expectShown(['ws', 'ls'], [ws.short_id, ws.slug])
    await expectShown(['proj', 'ls'], [proj.short_id, proj.slug])
    await expectShown(['env', 'ls'], [env.short_id, env.slug])
    await expectShown(['org', 'members', '-o', 'wide'], [USER_ID, INVITEE, 'owner', 'member'])
    await expectShown(['ls'], [org.slug, ws.slug, proj.slug])
    await expectShown(['access', 'role', env.id], ['owner', 'org'])
    await expectShown(['access', 'check', 'contract-app', 'read', env.id], ['yes', 'owner', 'viewer'])
    await expectShown(['access', 'app', 'list'], ['contract-app', 'http://app.test'])
    await expectShown(['access', 'app', 'policies', 'contract-app'], ['deploy', 'admin'])

    await client().createInvitation(org.short_id, { email: 'cli@contract.test', role: 'viewer' })
    await expectShown(['org', 'invites'], ['cli@contract.test', 'viewer'])
    const r = await cli(makeToken('user-cli', 'cli@contract.test'))('invites')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain('Contract Company')
    expect(r.stdout).toContain('contract-co')
  })

  it('JSON output is the service rows, field for field', async () => {
    const r = await cli()('org', 'ls', '-o', 'json')
    expect(r.exitCode, r.stderr).toBe(0)
    const rows = JSON.parse(r.stdout) as unknown[]
    for (const row of rows) expectShape<Organization>(row, ORG, 'org ls -o json')
  })

  it('a denied check exits non-zero, so scripts can branch on it', async () => {
    const r = await cli(makeToken(INVITEE, INVITEE_EMAIL))('access', 'check', 'contract-app', 'deploy', env.id)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('no')
  })

  it('deleting the org is the last thing, and it is gone after', async () => {
    const c = client()
    const scratch = await c.createOrg({ name: 'Scratch' })
    await c.deleteOrg(scratch.short_id)
    expect((await c.listOrgs()).map((o) => o.short_id)).not.toContain(scratch.short_id)
  })
})
