import type { FoldBase } from '@baseworks/foldbase'
import { OrgEvents, ScopeEvents, MembershipEvents, AppEvents, AppPolicyEvents } from '@baseworks/org/events'
import type {
  Organization,
  Scope,
  Membership,
  Role,
  ScopeKind,
  OrgRow,
  ScopeRow,
  MemberRow,
  AppRow,
  AppPolicyRow,
  RegisteredApp,
  AppPolicy,
  AppManifest,
  EffectiveRole,
  CheckResult,
} from '@baseworks/org'
import { generateShortId, generateSlug } from '@baseworks/core'

/**
 * The org domain, expressed over foldbase. This is the owning-app logic
 * (foldbase rule 2 keeps it out of folds): it composes the "joins" foldbase's
 * single-model query cannot, enforces kind ordering + slug uniqueness, and
 * turns deletes into subtree archives. Read as admin (the service is the authz
 * layer); write via typed catalogs.
 */

const PARENT_KIND: Record<ScopeKind, ScopeKind | 'organization'> = {
  workspace: 'organization',
  project: 'workspace',
  environment: 'project',
}
const CHILD_KIND: Partial<Record<ScopeKind, ScopeKind>> = {
  workspace: 'project',
  project: 'environment',
}

/** Role rank for highest-wins / at-least comparisons (the PDP). */
const RANK: Record<Role | 'none', number> = { none: 0, viewer: 1, member: 2, admin: 3, owner: 4 }
export function roleAtLeast(role: Role | 'none', min: Role): boolean {
  return RANK[role] >= RANK[min]
}

export class StoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'StoreError'
  }
}

const toOrg = (r: OrgRow): Organization => ({
  id: r.id,
  shortId: r.short_id,
  slug: r.slug,
  name: r.name,
  metadata: parseMeta(r.metadata),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toScope = (r: ScopeRow): Scope => ({
  id: r.id,
  organizationId: r.org_id,
  parentId: r.parent_id,
  kind: r.kind,
  shortId: r.short_id,
  slug: r.slug,
  name: r.name,
  isDefault: !!r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toMember = (r: MemberRow): Membership => ({
  id: r.id,
  organizationId: r.org_id,
  userId: r.user_id,
  role: r.role,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

function parseMeta(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {}
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}

export type Store = ReturnType<typeof createStore>

export function createStore(fb: FoldBase) {
  // Reads run as the service's own admin identity; the handlers do end-user authz.
  const q = fb.withAuth({ uid: 'org-service', role: 'admin' })
  const orgs = fb.catalog(OrgEvents)
  const scopes = fb.catalog(ScopeEvents)
  const members = fb.catalog(MembershipEvents)
  const apps = fb.catalog(AppEvents)
  const policies = fb.catalog(AppPolicyEvents)

  async function version(streamId: string): Promise<number> {
    return (await fb.streamVersion(streamId)).version
  }

  // ── organizations ──────────────────────────────────────────────────────────

  async function orgRowByRef(ref: string): Promise<OrgRow | null> {
    const bySlug = await q.query<OrgRow>('orgs', { where: { slug: { eq: ref } }, limit: 1 })
    if (bySlug.rows[0]) return bySlug.rows[0]
    const byShort = await q.query<OrgRow>('orgs', { where: { short_id: { eq: ref } }, limit: 1 })
    return byShort.rows[0] ?? null
  }

  async function listOrgsForUser(userId: string): Promise<(Organization & { role: Role })[]> {
    const mem = await q.query<MemberRow>('org_members', { where: { user_id: { eq: userId } } })
    if (!mem.rows.length) return []
    // Aynı sorgudan gelen üyelik satırları rolü zaten taşıyor — ayrıca sorgulamaya gerek yok.
    const roleByOrg = new Map(mem.rows.map((m) => [m.org_id, m.role]))
    const res = await q.query<OrgRow>('orgs', { where: { id: { in: [...roleByOrg.keys()] } }, sort: ['-created_at'] })
    return res.rows.map((row) => ({ ...toOrg(row), role: roleByOrg.get(row.id) ?? 'viewer' }))
  }

  async function createOrg(input: { name: string; slug?: string; ownerId: string }): Promise<Organization> {
    const slug = input.slug ?? generateSlug(input.name)
    if ((await q.query<OrgRow>('orgs', { where: { slug: { eq: slug } }, limit: 1 })).rows[0]) {
      throw new StoreError(409, 'slug_taken', `Org slug '${slug}' is taken`)
    }
    const id = OrgEvents.newId()
    const now = Date.now()
    await orgs.emit(id, 0, 'OrgCreated', {
      name: input.name,
      slug,
      shortId: generateShortId(),
      metadata: '{}',
      at: now,
    }, { actor: input.ownerId })
    await addMember({ orgId: id, userId: input.ownerId, role: 'owner', actor: input.ownerId })
    await provisionDefaults({ orgId: id, actor: input.ownerId })
    return (await orgById(id))!
  }

  async function getOrg(ref: string): Promise<Organization | null> {
    const row = await orgRowByRef(ref)
    return row ? toOrg(row) : null
  }

  async function orgById(id: string): Promise<Organization | null> {
    const res = await q.query<OrgRow>('orgs', { where: { id: { eq: id } }, limit: 1 })
    return res.rows[0] ? toOrg(res.rows[0]) : null
  }

  async function updateOrg(orgId: string, patch: { name?: string; slug?: string; metadata?: Record<string, unknown> }, actor: string): Promise<Organization> {
    const row = await q.query<OrgRow>('orgs', { where: { id: { eq: orgId } }, limit: 1 })
    const cur = row.rows[0]
    if (!cur) throw new StoreError(404, 'not_found')
    const slug = patch.slug ?? cur.slug
    if (patch.slug && patch.slug !== cur.slug) {
      if ((await q.query<OrgRow>('orgs', { where: { slug: { eq: patch.slug } }, limit: 1 })).rows[0]) {
        throw new StoreError(409, 'slug_taken', `Org slug '${patch.slug}' is taken`)
      }
    }
    const metadata = patch.metadata ? JSON.stringify(patch.metadata) : cur.metadata
    await orgs.emit(orgId, await version(orgId), 'OrgUpdated', {
      name: patch.name ?? cur.name,
      slug,
      metadata,
      at: Date.now(),
    }, { actor })
    return (await orgById(orgId))!
  }

  async function setOrgMetadata(orgId: string, changes: Record<string, unknown>, remove: string[], actor: string): Promise<void> {
    const row = await q.query<OrgRow>('orgs', { where: { id: { eq: orgId } }, limit: 1 })
    const cur = row.rows[0]
    if (!cur) throw new StoreError(404, 'not_found')
    const meta = parseMeta(cur.metadata)
    for (const [k, v] of Object.entries(changes)) meta[k] = v
    for (const k of remove) delete meta[k]
    await orgs.emit(orgId, await version(orgId), 'OrgUpdated', {
      name: cur.name,
      slug: cur.slug,
      metadata: JSON.stringify(meta),
      at: Date.now(),
    }, { actor })
  }

  /** Archive the org and its whole scope subtree + memberships. Events persist. */
  async function archiveOrg(orgId: string, actor: string): Promise<void> {
    const wss = await q.query<ScopeRow>('scopes', { where: { parent_id: { eq: orgId }, kind: { eq: 'workspace' } } })
    for (const ws of wss.rows) await archiveScope(ws.id, actor)
    const mem = await q.query<MemberRow>('org_members', { where: { org_id: { eq: orgId } } })
    for (const m of mem.rows) await members.emit(m.id, await version(m.id), 'MemberRemoved', {}, { actor })
    await orgs.emit(orgId, await version(orgId), 'OrgArchived', {}, { actor })
  }

  // ── memberships ────────────────────────────────────────────────────────────

  async function roleOf(orgId: string, userId: string): Promise<Role | null> {
    const res = await q.query<MemberRow>('org_members', { where: { org_id: { eq: orgId }, user_id: { eq: userId } }, limit: 1 })
    return res.rows[0]?.role ?? null
  }

  async function listMembers(orgId: string): Promise<Membership[]> {
    const res = await q.query<MemberRow>('org_members', { where: { org_id: { eq: orgId } }, sort: ['created_at'] })
    return res.rows.map(toMember)
  }

  async function addMember(input: { orgId: string; userId: string; role: Role; actor: string }): Promise<Membership> {
    const existing = await q.query<MemberRow>('org_members', { where: { org_id: { eq: input.orgId }, user_id: { eq: input.userId } }, limit: 1 })
    const now = Date.now()
    if (existing.rows[0]) {
      const id = existing.rows[0].id
      await members.emit(id, await version(id), 'MemberRoleChanged', { role: input.role, at: now }, { actor: input.actor })
      return toMember({ ...existing.rows[0], role: input.role, updated_at: now })
    }
    const id = MembershipEvents.newId()
    await members.emit(id, 0, 'MemberAdded', { orgId: input.orgId, userId: input.userId, role: input.role, at: now }, { actor: input.actor })
    return { id, organizationId: input.orgId, userId: input.userId, role: input.role, createdAt: now, updatedAt: now }
  }

  async function removeMember(orgId: string, userId: string, actor: string): Promise<void> {
    const res = await q.query<MemberRow>('org_members', { where: { org_id: { eq: orgId }, user_id: { eq: userId } }, limit: 1 })
    const row = res.rows[0]
    if (!row) throw new StoreError(404, 'not_found')
    await members.emit(row.id, await version(row.id), 'MemberRemoved', {}, { actor })
  }

  // ── scopes ─────────────────────────────────────────────────────────────────

  async function listScopes(orgId: string, kind: ScopeKind, parentId: string): Promise<Scope[]> {
    const res = await q.query<ScopeRow>('scopes', {
      where: { org_id: { eq: orgId }, kind: { eq: kind }, parent_id: { eq: parentId } },
      sort: ['-created_at'],
    })
    return res.rows.map(toScope)
  }

  async function scopeByRef(orgId: string, kind: ScopeKind, parentId: string, ref: string): Promise<ScopeRow | null> {
    const bySlug = await q.query<ScopeRow>('scopes', {
      where: { org_id: { eq: orgId }, kind: { eq: kind }, parent_id: { eq: parentId }, slug: { eq: ref } },
      limit: 1,
    })
    if (bySlug.rows[0]) return bySlug.rows[0]
    const byShort = await q.query<ScopeRow>('scopes', {
      where: { org_id: { eq: orgId }, kind: { eq: kind }, parent_id: { eq: parentId }, short_id: { eq: ref } },
      limit: 1,
    })
    return byShort.rows[0] ?? null
  }

  async function createScope(input: {
    orgId: string
    kind: ScopeKind
    parentId: string
    name: string
    slug?: string
    isDefault?: boolean
    actor: string
    provision?: boolean
  }): Promise<Scope> {
    const slug = input.slug ?? generateSlug(input.name)
    const dup = await q.query<ScopeRow>('scopes', {
      where: { org_id: { eq: input.orgId }, kind: { eq: input.kind }, parent_id: { eq: input.parentId }, slug: { eq: slug } },
      limit: 1,
    })
    if (dup.rows[0]) throw new StoreError(409, 'slug_taken', `${input.kind} slug '${slug}' is taken`)
    const id = ScopeEvents.newId()
    const now = Date.now()
    await scopes.emit(id, 0, 'ScopeCreated', {
      orgId: input.orgId,
      kind: input.kind,
      parentId: input.parentId,
      name: input.name,
      slug,
      shortId: generateShortId(),
      isDefault: input.isDefault ?? false,
      at: now,
    }, { actor: input.actor })
    const created: Scope = {
      id, organizationId: input.orgId, parentId: input.parentId, kind: input.kind,
      shortId: '', slug, name: input.name, isDefault: input.isDefault ?? false, createdAt: now, updatedAt: now,
    }
    // Chain the default child (workspace→project→environment) when provisioning.
    if (input.provision) {
      const child = CHILD_KIND[input.kind]
      if (child) {
        await createScope({
          orgId: input.orgId, kind: child, parentId: id,
          name: child === 'project' ? 'Main' : 'Production',
          slug: child === 'project' ? 'main' : 'production',
          isDefault: true, actor: input.actor, provision: true,
        })
      }
    }
    const fresh = await q.query<ScopeRow>('scopes', { where: { id: { eq: id } }, limit: 1 })
    return fresh.rows[0] ? toScope(fresh.rows[0]) : created
  }

  async function updateScope(scopeId: string, patch: { name?: string; slug?: string; isDefault?: boolean }, actor: string): Promise<Scope> {
    const res = await q.query<ScopeRow>('scopes', { where: { id: { eq: scopeId } }, limit: 1 })
    const cur = res.rows[0]
    if (!cur) throw new StoreError(404, 'not_found')
    if (patch.slug && patch.slug !== cur.slug) {
      const dup = await q.query<ScopeRow>('scopes', {
        where: { org_id: { eq: cur.org_id }, kind: { eq: cur.kind }, parent_id: { eq: cur.parent_id }, slug: { eq: patch.slug } },
        limit: 1,
      })
      if (dup.rows[0]) throw new StoreError(409, 'slug_taken', `${cur.kind} slug '${patch.slug}' is taken`)
    }
    await scopes.emit(scopeId, await version(scopeId), 'ScopeUpdated', {
      name: patch.name ?? cur.name,
      slug: patch.slug ?? cur.slug,
      isDefault: patch.isDefault ?? !!cur.is_default,
      at: Date.now(),
    }, { actor })
    const fresh = await q.query<ScopeRow>('scopes', { where: { id: { eq: scopeId } }, limit: 1 })
    return toScope(fresh.rows[0]!)
  }

  /** Archive a scope and everything beneath it. */
  async function archiveScope(scopeId: string, actor: string): Promise<void> {
    const children = await q.query<ScopeRow>('scopes', { where: { parent_id: { eq: scopeId } } })
    for (const c of children.rows) await archiveScope(c.id, actor)
    await scopes.emit(scopeId, await version(scopeId), 'ScopeArchived', {}, { actor })
  }

  async function provisionDefaults(input: { orgId: string; actor: string }): Promise<void> {
    await createScope({
      orgId: input.orgId, kind: 'workspace', parentId: input.orgId,
      name: 'Default', slug: 'default', isDefault: true, actor: input.actor, provision: true,
    })
  }

  // ── PDP: apps, policies, effective role, check ───────────────────────────────

  async function scopeRowById(id: string): Promise<ScopeRow | null> {
    const res = await q.query<ScopeRow>('scopes', { where: { id: { eq: id } }, limit: 1 })
    return res.rows[0] ?? null
  }

  /**
   * The role a user holds at `scopeId`. Roles live at the org (membership),
   * inherited downward: a sub-scope's effective role is the user's role at its
   * root org. `scopeId` may be an org id or a workspace/project/environment id.
   * (v1: no per-sub-scope grants — extend the membership model if needed.)
   */
  async function effectiveRole(userId: string, scopeId: string): Promise<EffectiveRole> {
    let orgId: string
    const org = await orgById(scopeId)
    if (org) orgId = org.id
    else {
      const scope = await scopeRowById(scopeId)
      if (!scope) throw new StoreError(404, 'not_found', `scope not found: ${scopeId}`)
      orgId = scope.org_id
    }
    const role = await roleOf(orgId, userId)
    return role ? { role, via: { scopeId: orgId, scopeKind: 'org' } } : { role: 'none' }
  }

  const toApp = (r: AppRow): RegisteredApp => ({
    id: r.id, name: r.name, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at,
  })
  const toPolicy = (r: AppPolicyRow): AppPolicy => ({
    id: r.id, app: r.app, action: r.action, minRole: r.min_role, createdAt: r.created_at, updatedAt: r.updated_at,
  })

  async function appRowByName(name: string): Promise<AppRow | null> {
    const res = await q.query<AppRow>('apps', { where: { name: { eq: name } }, limit: 1 })
    return res.rows[0] ?? null
  }

  async function policyRow(app: string, action: string): Promise<AppPolicyRow | null> {
    const res = await q.query<AppPolicyRow>('app_policies', {
      where: { app: { eq: app }, action: { eq: action } }, limit: 1,
    })
    return res.rows[0] ?? null
  }

  /**
   * Boot-time registration: upsert the app (origin refreshed) and insert
   * defaults ONLY for actions that have no policy yet — explicit admin overrides
   * survive redeploys.
   */
  async function registerManifest(manifest: AppManifest, actor: string): Promise<RegisteredApp> {
    const now = Date.now()
    const existing = await appRowByName(manifest.name)
    if (existing) {
      if (existing.origin !== manifest.origin) {
        await apps.emit(existing.id, await version(existing.id), 'AppOriginChanged', { origin: manifest.origin, at: now }, { actor })
      }
    } else {
      const id = AppEvents.newId()
      await apps.emit(id, 0, 'AppRegistered', { name: manifest.name, origin: manifest.origin, at: now }, { actor })
    }
    for (const [action, minRole] of Object.entries(manifest.actions)) {
      if (!(await policyRow(manifest.name, action))) {
        const pid = AppPolicyEvents.newId()
        await policies.emit(pid, 0, 'PolicySet', { app: manifest.name, action, minRole, at: now }, { actor })
      }
    }
    return toApp((await appRowByName(manifest.name))!)
  }

  /** Explicit override of an action's minimum role. */
  async function setPolicy(app: string, action: string, minRole: Role, actor: string): Promise<AppPolicy> {
    const now = Date.now()
    const existing = await policyRow(app, action)
    if (existing) {
      await policies.emit(existing.id, await version(existing.id), 'PolicySet', { app, action, minRole, at: now }, { actor })
      return toPolicy({ ...existing, min_role: minRole, updated_at: now })
    }
    const pid = AppPolicyEvents.newId()
    await policies.emit(pid, 0, 'PolicySet', { app, action, minRole, at: now }, { actor })
    return toPolicy((await policyRow(app, action))!)
  }

  async function listApps(): Promise<RegisteredApp[]> {
    const res = await q.query<AppRow>('apps', { sort: ['name'] })
    return res.rows.map(toApp)
  }

  async function listPolicies(app: string): Promise<AppPolicy[]> {
    const res = await q.query<AppPolicyRow>('app_policies', { where: { app: { eq: app } }, sort: ['action'] })
    return res.rows.map(toPolicy)
  }

  /** The PDP: may `userId` perform `action` of `app` at `scopeId`? Deny-by-default. */
  async function check(input: { app: string; action: string; userId: string; scopeId: string }): Promise<CheckResult> {
    const policy = await policyRow(input.app, input.action)
    const { role } = await effectiveRole(input.userId, input.scopeId)
    if (!policy) return { allowed: false, role, reason: 'no_policy' }
    if (!roleAtLeast(role, policy.min_role)) {
      return { allowed: false, role, minRole: policy.min_role, reason: 'insufficient_role' }
    }
    return { allowed: true, role, minRole: policy.min_role }
  }

  return {
    // orgs
    orgRowByRef, listOrgsForUser, createOrg, getOrg, updateOrg, setOrgMetadata, archiveOrg,
    // members
    roleOf, listMembers, addMember, removeMember,
    // scopes
    listScopes, scopeByRef, createScope, updateScope, archiveScope, provisionDefaults,
    // PDP
    effectiveRole, check, registerManifest, setPolicy, listApps, listPolicies,
    // helpers
    toScope,
    _PARENT_KIND: PARENT_KIND,
  }
}
