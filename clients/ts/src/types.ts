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
}

export interface Invitation {
  id: string
  org_id: string
  email: string
  role: Role
  invited_by: string
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
  createdAt: number
  updatedAt: number
}

export interface AppPolicy {
  id: string
  app: string
  action: string
  minRole: Role
  createdAt: number
  updatedAt: number
}

/** An app's boot-time policy manifest: action → minimum role. */
export interface AppManifest {
  name: string
  origin: string
  actions: Record<string, Role>
}

/** The effective role a user holds at a scope (org role, inherited downward). */
export interface EffectiveRole {
  role: Role | 'none'
  /** The scope that produced the role — the root org in v1. */
  via?: { scopeId: string; scopeKind: 'org' }
}

/** The PDP verdict for one `check`. */
export interface CheckResult {
  allowed: boolean
  role: Role | 'none'
  minRole?: Role
  reason?: 'no_policy' | 'insufficient_role'
}
