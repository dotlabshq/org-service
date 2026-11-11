// Scope-model domain types. Foldbase-native: read-model row shapes (snake_case,
// as stored) and REST DTOs (camelCase, as the API + CLI consume them).

import type { Role, ScopeKind } from './events.js'
export type { Role, ScopeKind } from './events.js'
export { ROLES, SCOPE_KINDS } from './events.js'

// ── read-model rows (snake_case — foldbase read_<name> tables) ────────────────

export interface OrgRow {
  id: string
  name: string
  slug: string
  short_id: string
  metadata: string // JSON string
  created_at: number
  updated_at: number
}

export interface ScopeRow {
  id: string
  org_id: string
  kind: ScopeKind
  parent_id: string
  name: string
  slug: string
  short_id: string
  is_default: boolean
  created_at: number
  updated_at: number
}

export interface MemberRow {
  id: string
  org_id: string
  user_id: string
  role: Role
  created_at: number
  updated_at: number
}

export interface InvitationRow {
  id: string
  org_id: string
  email: string
  role: Role
  invited_by: string
  created_at: number
  updated_at: number
}

export interface AppRow {
  id: string
  name: string
  origin: string
  created_at: number
  updated_at: number
}

export interface AppPolicyRow {
  id: string
  app: string
  action: string
  min_role: Role
  /** Null on a row written before 0.12 (PolicySet): read as `write`, anyone, no service. */
  access?: string | null
  requires?: string | null
  services?: string | null
  created_at: number
  updated_at: number
}

// ── REST DTOs (camelCase — API responses + CLI input) ─────────────────────────

export interface Organization {
  id: string
  short_id: string
  slug: string
  name: string
  metadata: Record<string, unknown>
  created_at: number
  updated_at: number
  /** The caller's own role; present on listings, absent on a plain read. */
  role?: Role
}

export interface Scope {
  id: string
  org_id: string
  parent_id: string
  kind: ScopeKind
  short_id: string
  slug: string
  name: string
  is_default: boolean
  created_at: number
  updated_at: number
}

// Backwards-friendly aliases — a scope of each kind is still a Workspace /
// Project / Environment to callers, just backed by one aggregate.
export type Workspace = Scope
export type Project = Scope
export type Environment = Scope

export interface Membership {
  id: string
  org_id: string
  user_id: string
  role: Role
  created_at: number
  updated_at: number
  /**
   * Who the member is, joined from iam-service when a realm has one. Absent
   * means the realm runs without iam, or iam does not know this id (a deleted
   * account) — never that the person has no email.
   */
  email?: string
  name?: string
}

export interface Invitation {
  id: string
  org_id: string
  email: string
  role: Role
  /** The inviter's user id. Readable forms below, when iam can supply them. */
  invited_by: string
  invited_by_email?: string
  invited_by_name?: string
  created_at: number
  updated_at: number
  // Enriched on the invitee-facing list (`GET /invitations`) so a client can
  // show which org an invite is for without a second lookup.
  org_slug?: string
  org_name?: string
}

// ── PDP (app registry + access decisions) ─────────────────────────────────────

export interface RegisteredApp {
  id: string
  name: string
  origin: string
  created_at: number
  updated_at: number
}

/** Whether an action only looks, or changes something. What a credential's scope is matched against. */
export type Access = 'read' | 'write'

/**
 * A limit on the *kind of credential*, whatever the role:
 * `person` — a person's own credential (their session or their personal token),
 * never an organization's key; `session` — a person who signed in, never any
 * token (so a leaked token cannot, say, mint more tokens).
 */
export type Requires = 'person' | 'session'

/** What one action asks for. */
export interface ActionSpec {
  /** The least role that may do it. Built-in roles are ordered: viewer < member < admin < owner. */
  min_role: Role
  /** Default `write`. A credential scoped to `read` cannot do a `write` action. */
  access?: Access
  requires?: Requires
  /**
   * Service identities that may do this as themselves, with no person
   * involved (a webhook, a scheduled job). Empty by default: a service gets
   * nothing it was not named for.
   */
  services?: string[]
}

export interface AppPolicy {
  id: string
  app: string
  action: string
  min_role: Role
  access: Access
  requires?: Requires
  services: string[]
  created_at: number
  updated_at: number
}

/**
 * An app's manifest: every action it has and what each asks for. `"admin"` is
 * short for `{ min_role: "admin" }`. Registering makes org-service's record of
 * the app equal to this — changed actions are updated, missing ones removed.
 */
export interface AppManifest {
  name: string
  origin: string
  actions: Record<string, Role | ActionSpec>
}

/**
 * What the caller is holding, as the service that verified it knows it. Only a
 * service may state this; from a person's own token the credential is their
 * session.
 */
export interface Credential {
  /** `session`: a signed-in person. `token`: a person's API token. `org_key`: an organization's key, no person. */
  kind: 'session' | 'token' | 'org_key'
  /** What a token or key is limited to. Absent: no limit beyond the role. */
  scopes?: Access[]
  /** For `org_key` only: the role the key acts with. */
  role?: Role
}

/**
 * Everything one principal may do in one app at one organization — the answer
 * a service fetches once and keeps briefly, then tests with `can()`
 * (`@baseworks/core/permissions`). org-service evaluated it; holding it is not
 * deciding.
 */
export interface PermissionSet {
  app: string
  /** The organization the answer is for (the resolved id). */
  scope_id: string
  /** The role that produced it: a member's role, a key's, `service`, or `none`. */
  role: Role | 'none' | 'service'
  permissions: string[]
}

/** The effective role a user holds at a scope (org role, inherited downward). */
export interface EffectiveRole {
  role: Role | 'none'
  /** The scope that produced the role — the root org in v1. */
  via?: { scope_id: string; scope_kind: 'org' }
}

/** The PDP verdict for one `check`. */
export interface CheckResult {
  allowed: boolean
  role: Role | 'none' | 'service'
  /** What the action asks for, as the app declared it. Absent with `no_policy`. */
  min_role?: Role
  /**
   * Why not. `no_policy`: the app declared nothing for this action (or
   * registered no manifest), so nobody may do it. `insufficient_role`: it is
   * declared, and this person's role is below it. `insufficient_scope`: the
   * credential is limited to reading and this writes. `person_only` /
   * `session_only`: the action is closed to this kind of credential.
   * `service_not_allowed`: a service asked as itself and is not named for it.
   */
  reason?: 'no_policy' | 'insufficient_role' | 'insufficient_scope' | 'person_only' | 'session_only' | 'service_not_allowed'
}
