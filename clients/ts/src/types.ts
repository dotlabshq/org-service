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
  shortId: string
  slug: string
  name: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface Scope {
  id: string
  organizationId: string
  parentId: string
  kind: ScopeKind
  shortId: string
  slug: string
  name: string
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

// Backwards-friendly aliases — a scope of each kind is still a Workspace /
// Project / Environment to callers, just backed by one aggregate.
export type Workspace = Scope
export type Project = Scope
export type Environment = Scope

export interface Membership {
  id: string
  organizationId: string
  userId: string
  role: Role
  createdAt: number
  updatedAt: number
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
