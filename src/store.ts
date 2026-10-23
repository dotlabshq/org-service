import type { FoldBase } from '@baseworks/foldbase'
import { OrgEvents, ScopeEvents, MembershipEvents, InvitationEvents, AppEvents, AppPolicyEvents } from '@baseworks/org/events'
import type {
  Organization,
  Scope,
  Membership,
  Role,
  ScopeKind,
  OrgRow,
  ScopeRow,
  MemberRow,
  Invitation,
  InvitationRow,
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

// Bodies use the same names as the rows (ADR-043), so these no longer rename
// anything. What is left is the work that is genuinely storage-shaped: metadata
// arrives as a JSON string, and `is_default` as whatever the driver gives back.
// A field added to a projection now reaches the body on its own instead of
// waiting to be remembered here.

const toOrg = (r: OrgRow): Organization => ({ ...r, metadata: parseMeta(r.metadata) })

const toScope = (r: ScopeRow): Scope => ({ ...r, is_default: !!r.is_default })

const toInvitation = (r: InvitationRow): Invitation => ({ ...r })

const toMember = (r: MemberRow): Membership => ({ ...r })

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
  const invitations = fb.catalog(InvitationEvents)
  const apps = fb.catalog(AppEvents)
  const policies = fb.catalog(AppPolicyEvents)

  async function version(streamId: string): Promise<number> {
    return (await fb.streamVersion(streamId)).version
  }

  // ── organizations ──────────────────────────────────────────────────────────

  /**
   * Bir org'a üç yoldan da erişilebilir: slug, short_id ve id. Kimliği tutan
   * çağıranın (ör. bir kapı servisi) slug'ı ayrıca taşımak zorunda kalmaması
   * için birincil anahtar da bir ref sayılır.
   */
  async function orgRowByRef(ref: string): Promise<OrgRow | null> {
    const bySlug = await q.query<OrgRow>('orgs', { where: { slug: { eq: ref } }, limit: 1 })
    if (bySlug.rows[0]) return bySlug.rows[0]
    const byShort = await q.query<OrgRow>('orgs', { where: { short_id: { eq: ref } }, limit: 1 })
    if (byShort.rows[0]) return byShort.rows[0]
    const byId = await q.query<OrgRow>('orgs', { where: { id: { eq: ref } }, limit: 1 })
    return byId.rows[0] ?? null
  }

  async function listOrgsForUser(userId: string): Promise<(Organization & { role: Role })[]> {
    const mem = await q.query<MemberRow>('org_members', { where: { user_id: { eq: userId } } })
    if (!mem.rows.length) return []
    // Aynı sorgudan gelen üyelik satırları rolü zaten taşıyor — ayrıca sorgulamaya gerek yok.
    const roleByOrg = new Map(mem.rows.map((m) => [m.org_id, m.role]))
    const res = await q.query<OrgRow>('orgs', { where: { id: { in: [...roleByOrg.keys()] } }, sort: ['-created_at'] })
    return res.rows.map((row) => ({ ...toOrg(row), role: roleByOrg.get(row.id) ?? 'viewer' }))
  }

  /**
   * Tüm org'lar — üyelikten bağımsız. Platform işletmesi için: bir kaynağı
   * (ör. IP adresi) hangi org'a vereceğini seçen operatör, üyesi olmadığı
   * org'ları da görmek zorundadır. Uç servis token'ına kapalıdır (routes/orgs).
   */
  async function listAllOrgs(limit = 500): Promise<Organization[]> {
    const res = await q.query<OrgRow>('orgs', { sort: ['-created_at'], limit })
    return res.rows.map(toOrg)
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
      // A slug is not a display name: hostnames, URLs and bookmarks are derived
      // from it downstream — zone9 builds `<slug>.zone9.run` — and renaming it
      // breaks all of them silently, in another system, with nothing here to
      // show for it. Refused unless a realm explicitly takes that on.
      if (process.env['ORG_ALLOW_SLUG_CHANGE'] !== 'true') {
        throw new StoreError(
          409,
          'slug_immutable',
          'Org slug cannot be changed; names derived from it (hostnames, URLs) would break. ' +
            'Set ORG_ALLOW_SLUG_CHANGE=true only if nothing in this realm derives names from slugs.',
        )
      }
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

  /**
   * An organisation must never be left with nobody who can administer it.
   *
   * Owner is the only role that can hand out owner, so the last one leaving or
   * being demoted would lock the org: the remaining members could not invite,
   * could not promote, and could not delete it. The check is here rather than in
   * the routes because every path that could do it goes through this file —
   * removing a member, changing a role, and `addMember`, which quietly changes
   * the role of someone who is already in.
   */
  async function refuseIfLastOwner(orgId: string, userId: string, nextRole: Role | null): Promise<void> {
    if (nextRole === 'owner') return
    const current = await roleOf(orgId, userId)
    if (current !== 'owner') return
    const owners = await q.query<MemberRow>('org_members', { where: { org_id: { eq: orgId }, role: { eq: 'owner' } } })
    if (owners.rows.length <= 1) throw new StoreError(409, 'last_owner')
  }

  async function changeMemberRole(orgId: string, userId: string, role: Role, actor: string): Promise<Membership> {
    const res = await q.query<MemberRow>('org_members', { where: { org_id: { eq: orgId }, user_id: { eq: userId } }, limit: 1 })
    const row = res.rows[0]
    // Not a member: 404 rather than creating one. Adding somebody is `addMember`,
    // a different decision with a different endpoint.
    if (!row) throw new StoreError(404, 'not_found')
    await refuseIfLastOwner(orgId, userId, role)
    const now = Date.now()
    await members.emit(row.id, await version(row.id), 'MemberRoleChanged', { role, at: now }, { actor })
    return toMember({ ...row, role, updated_at: now })
  }

  async function addMember(input: { orgId: string; userId: string; role: Role; actor: string }): Promise<Membership> {
    const existing = await q.query<MemberRow>('org_members', { where: { org_id: { eq: input.orgId }, user_id: { eq: input.userId } }, limit: 1 })
    const now = Date.now()
    if (existing.rows[0]) {
      await refuseIfLastOwner(input.orgId, input.userId, input.role)
      const id = existing.rows[0].id
      await members.emit(id, await version(id), 'MemberRoleChanged', { role: input.role, at: now }, { actor: input.actor })
      return toMember({ ...existing.rows[0], role: input.role, updated_at: now })
    }
    const id = MembershipEvents.newId()
    await members.emit(id, 0, 'MemberAdded', { orgId: input.orgId, userId: input.userId, role: input.role, at: now }, { actor: input.actor })
    return { id, org_id: input.orgId, user_id: input.userId, role: input.role, created_at: now, updated_at: now }
  }

  async function removeMember(orgId: string, userId: string, actor: string): Promise<void> {
    const res = await q.query<MemberRow>('org_members', { where: { org_id: { eq: orgId }, user_id: { eq: userId } }, limit: 1 })
    const row = res.rows[0]
    if (!row) throw new StoreError(404, 'not_found')
    await refuseIfLastOwner(orgId, userId, null)
    await members.emit(row.id, await version(row.id), 'MemberRemoved', {}, { actor })
  }

  // ── invitations ────────────────────────────────────────────────────────────
  //
  // An invitation is a pending intent, not a membership. Accepting one emits a
  // MemberAdded on the membership stream and deletes the pending row; the
  // invitation events stay as the audit trail of who invited whom.
  //
  // The email is normalised on the way in. Without that, `Ada@Example.com ` and
  // `ada@example.com` are two invitations for one person, and only one of them
  // is ever findable.

  const normaliseEmail = (email: string): string => email.trim().toLowerCase()

  async function listInvitations(orgId: string): Promise<Invitation[]> {
    const res = await q.query<InvitationRow>('org_invitations', {
      where: { org_id: { eq: orgId } },
      sort: ['-created_at'],
    })
    return res.rows.map(toInvitation)
  }

  /**
   * Invite an email, or re-point an existing pending invitation at a new role.
   *
   * Idempotent per (org, email): inviting the same person twice must not create
   * a second row that the first acceptance leaves behind as a ghost.
   */
  async function createInvitation(input: {
    orgId: string
    email: string
    role: Role
    actor: string
  }): Promise<Invitation> {
    const email = normaliseEmail(input.email)
    const now = Date.now()

    const existing = await q.query<InvitationRow>('org_invitations', {
      where: { org_id: { eq: input.orgId }, email: { eq: email } },
      limit: 1,
    })
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (row.role === input.role) return toInvitation(row)
      // Changing the role re-issues rather than editing: the event log should
      // show both decisions, not silently overwrite the first.
      await invitations.emit(row.id, await version(row.id), 'InvitationRevoked', {}, { actor: input.actor })
    }

    const id = InvitationEvents.newId()
    await invitations.emit(
      id, 0, 'InvitationCreated',
      { orgId: input.orgId, email, role: input.role, invitedBy: input.actor, at: now },
      { actor: input.actor },
    )
    return {
      id, org_id: input.orgId, email, role: input.role,
      invited_by: input.actor, created_at: now, updated_at: now,
    }
  }

  async function invitationById(id: string): Promise<InvitationRow | null> {
    const res = await q.query<InvitationRow>('org_invitations', { where: { id: { eq: id } }, limit: 1 })
    return res.rows[0] ?? null
  }

  async function revokeInvitation(orgId: string, id: string, actor: string): Promise<void> {
    const row = await invitationById(id)
    // Scoped to the org in the path: an id alone must not let an admin of one
    // org revoke another org's invitation.
    if (!row || row.org_id !== orgId) throw new StoreError(404, 'not_found')
    await invitations.emit(id, await version(id), 'InvitationRevoked', {}, { actor })
  }

  /** Pending invitations addressed to an email, enriched with the org's name. */
  async function listInvitationsForEmail(email: string): Promise<Invitation[]> {
    const res = await q.query<InvitationRow>('org_invitations', {
      where: { email: { eq: normaliseEmail(email) } },
      sort: ['-created_at'],
    })
    return Promise.all(res.rows.map(async (row) => {
      const org = await orgById(row.org_id)
      return {
        ...toInvitation(row),
        ...(org ? { org_slug: org.slug, org_name: org.name } : {}),
      }
    }))
  }

  /**
   * Accept an invitation and become a member.
   *
   * The caller must prove the invitation is theirs by presenting the email it
   * was addressed to — the id alone is not enough, or anyone who saw an id in a
   * log could join the org.
   */
  async function acceptInvitation(id: string, userId: string, email: string): Promise<Membership> {
    const row = await invitationById(id)
    if (!row || row.email !== normaliseEmail(email)) throw new StoreError(404, 'not_found')

    const member = await addMember({ orgId: row.org_id, userId, role: row.role, actor: userId })
    // Only after the membership is written: if this crashed first, the invitee
    // would be left with neither a membership nor an invitation to retry.
    await invitations.emit(id, await version(id), 'InvitationAccepted', { userId, at: Date.now() }, { actor: userId })
    return member
  }

  /**
   * Decline an invitation. Like accepting, the caller proves it is theirs with
   * the email it was addressed to; an id on its own is not proof of anything.
   *
   * Declining is not revoking. It leaves a different event in the log, so a
   * later question — did they say no, or did we withdraw it? — has an answer.
   */
  async function declineInvitation(id: string, userId: string, email: string): Promise<void> {
    const row = await invitationById(id)
    if (!row || row.email !== normaliseEmail(email)) throw new StoreError(404, 'not_found')
    await invitations.emit(id, await version(id), 'InvitationDeclined', { userId, at: Date.now() }, { actor: userId })
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

  /**
   * A short id no other scope in this org has. The space is 27^6; a collision
   * is unlikely and must still be impossible, because the short id is how a
   * scope is named from outside — on the CLI, in a URL, in a header — and two
   * scopes answering to one name would be a scope-level version of the
   * X-Org-Id bug this service exists to prevent.
   */
  async function freshShortId(orgId: string): Promise<string> {
    for (;;) {
      const candidate = generateShortId()
      const taken = await q.query<ScopeRow>('scopes', { where: { org_id: { eq: orgId }, short_id: { eq: candidate } }, limit: 1 })
      if (!taken.rows[0]) return candidate
    }
  }

  /**
   * A scope anywhere in the org, by the refs that are unique there: its short
   * id, or its id. Not by slug — two projects in different workspaces may both
   * be `main`. This is what a caller holding only `X-Flect-Scope` resolves
   * through.
   */
  async function scopeInOrgByRef(orgId: string, ref: string): Promise<ScopeRow | null> {
    const byShort = await q.query<ScopeRow>('scopes', { where: { org_id: { eq: orgId }, short_id: { eq: ref } }, limit: 1 })
    if (byShort.rows[0]) return byShort.rows[0]
    const byId = await q.query<ScopeRow>('scopes', { where: { org_id: { eq: orgId }, id: { eq: ref } }, limit: 1 })
    return byId.rows[0] ?? null
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
      shortId: await freshShortId(input.orgId),
      isDefault: input.isDefault ?? false,
      at: now,
    }, { actor: input.actor })
    const created: Scope = {
      id, org_id: input.orgId, parent_id: input.parentId, kind: input.kind,
      short_id: '', slug, name: input.name, is_default: input.isDefault ?? false,
      created_at: now, updated_at: now,
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
   * By short id alone, with no org to narrow it: what the PDP gets from a
   * caller that sends `X-Flect-Scope` and nothing else. Short ids are unique
   * within an org, not across orgs, so two matches is a real ambiguity and is
   * refused rather than resolved by luck.
   */
  async function scopeRowByShortId(shortId: string): Promise<ScopeRow | null> {
    const res = await q.query<ScopeRow>('scopes', { where: { short_id: { eq: shortId } }, limit: 2 })
    if (res.rows.length > 1) throw new StoreError(409, 'ambiguous', `scope short id ${shortId} exists in more than one org; name the org`)
    return res.rows[0] ?? null
  }

  /**
   * The role a user holds at `scopeId`. Roles live at the org (membership),
   * inherited downward: a sub-scope's effective role is the user's role at its
   * root org. `scopeId` may be an org id or a workspace/project/environment id.
   * (v1: no per-sub-scope grants — extend the membership model if needed.)
   */
  /**
   * The effective role at a scope.
   *
   * The scope may be named the way every other org endpoint accepts — id, slug
   * or short id — because `X-Org-Id` is allowed to carry any of them
   * (ADR-042 §3) and the header is where this argument comes from. Resolving
   * only ids meant a CLI that had run `use acme` was refused by every service
   * that asks the PDP, while a console sending the id was not: the same
   * membership, two answers, depending on which spelling arrived.
   */
  async function effectiveRole(userId: string, scopeId: string): Promise<EffectiveRole> {
    let orgId: string
    const org = await orgRowByRef(scopeId)
    if (org) orgId = org.id
    else {
      const scope = (await scopeRowById(scopeId)) ?? (await scopeRowByShortId(scopeId))
      if (!scope) throw new StoreError(404, 'not_found', `scope not found: ${scopeId}`)
      orgId = scope.org_id
    }
    const role = await roleOf(orgId, userId)
    return role ? { role, via: { scope_id: orgId, scope_kind: 'org' } } : { role: 'none' }
  }

  const toApp = (r: AppRow): RegisteredApp => ({
    id: r.id, name: r.name, origin: r.origin, created_at: r.created_at, updated_at: r.updated_at,
  })
  const toPolicy = (r: AppPolicyRow): AppPolicy => ({
    id: r.id, app: r.app, action: r.action, min_role: r.min_role, created_at: r.created_at, updated_at: r.updated_at,
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
      return { allowed: false, role, min_role: policy.min_role, reason: 'insufficient_role' }
    }
    return { allowed: true, role, min_role: policy.min_role }
  }

  return {
    // orgs
    orgRowByRef, listOrgsForUser, listAllOrgs, createOrg, getOrg, updateOrg, setOrgMetadata, archiveOrg,
    // members
    roleOf, listMembers, addMember, changeMemberRole, removeMember,
    // invitations
    listInvitations, createInvitation, revokeInvitation, listInvitationsForEmail, acceptInvitation, declineInvitation,
    // scopes
    listScopes, scopeByRef, scopeInOrgByRef, createScope, updateScope, archiveScope, provisionDefaults,
    // PDP
    effectiveRole, check, registerManifest, setPolicy, listApps, listPolicies,
    // helpers
    toScope,
    _PARENT_KIND: PARENT_KIND,
  }
}
