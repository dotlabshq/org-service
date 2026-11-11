import { z } from 'zod'
import { defineAggregate } from '@baseworks/foldbase'

/**
 * Event catalogs — the single source of truth for org-service payloads.
 * Shared by the service (typed emit) and tests. Three aggregates:
 *
 *   org         — the organization root (id = read-model key, NOT tenant)
 *   scope       — workspace | project | environment, keyed by `kind` + parentId
 *   membership  — a (user, org, role) grant; one stream per membership
 *
 * All timestamps are epoch millis carried in the payload (`at`) so folds stay
 * deterministic and independent of server clocks. `metadata` is a JSON string;
 * the service merges it before emit (ADR 0001, decision 6).
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export const Role = z.enum(ROLES)
export type Role = z.infer<typeof Role>

export const SCOPE_KINDS = ['workspace', 'project', 'environment'] as const
export const ScopeKind = z.enum(SCOPE_KINDS)
export type ScopeKind = z.infer<typeof ScopeKind>

// ── org ───────────────────────────────────────────────────────────────────────

export const OrgEvents = defineAggregate('org', {
  OrgCreated: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    shortId: z.string().min(1),
    metadata: z.string(), // JSON object, serialized
    at: z.number().int(),
  }),
  OrgUpdated: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    metadata: z.string(),
    at: z.number().int(),
  }),
  OrgArchived: z.object({
    reason: z.string().optional(),
  }),
})

// ── scope (workspace / project / environment) ─────────────────────────────────

export const ScopeEvents = defineAggregate('scope', {
  ScopeCreated: z.object({
    orgId: z.string().min(1),
    kind: ScopeKind,
    parentId: z.string().min(1), // workspace→orgId, project→wsId, environment→projId
    name: z.string().min(1),
    slug: z.string().min(1),
    shortId: z.string().min(1),
    isDefault: z.boolean(),
    at: z.number().int(),
  }),
  ScopeUpdated: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    isDefault: z.boolean(),
    at: z.number().int(),
  }),
  ScopeArchived: z.object({
    reason: z.string().optional(),
  }),
})

// ── membership ────────────────────────────────────────────────────────────────

export const MembershipEvents = defineAggregate('membership', {
  MemberAdded: z.object({
    orgId: z.string().min(1),
    userId: z.string().min(1),
    role: Role,
    at: z.number().int(),
  }),
  MemberRoleChanged: z.object({
    role: Role,
    at: z.number().int(),
  }),
  MemberRemoved: z.object({}),
})

// ── invitation ──────────────────────────────────────────────────────────────
//
// A pending grant addressed to an *email* rather than a user id — the piece the
// membership model can't express, since `MemberAdded` needs a concrete userId up
// front. An owner/admin creates one; the invitee resolves it on their next login
// (email is matched against the token's `email` claim) and `InvitationAccepted`
// materializes a `MemberAdded`. One stream per invitation; the row is deleted on
// accept, decline or revoke (the event log stays the audit trail, like
// memberships).

export const InvitationEvents = defineAggregate('invitation', {
  InvitationCreated: z.object({
    orgId: z.string().min(1),
    email: z.string().min(1), // normalized (lowercased, trimmed) by the service
    role: Role,
    invitedBy: z.string().min(1),
    at: z.number().int(),
  }),
  InvitationAccepted: z.object({
    userId: z.string().min(1),
    at: z.number().int(),
  }),
  /**
   * The invitee said no. Separate from `InvitationRevoked` on purpose: both
   * remove the pending row, but one is the organisation withdrawing an offer
   * and the other is the person refusing it. The log is the audit trail, and
   * collapsing the two would lose which of them happened.
   */
  InvitationDeclined: z.object({
    userId: z.string().min(1),
    at: z.number().int(),
  }),
  InvitationRevoked: z.object({}),
})

// ── app registry + policy (the PDP) ───────────────────────────────────────────
//
// The PDP answers "may user U do action A at scope S?". Apps register a manifest
// (action → minimum role) at boot; an action with no policy asks for `member`. Roles
// resolve over org membership, inherited downward to every sub-scope (v1: no
// per-sub-scope grants — those extend the membership model later if needed).

export const AppEvents = defineAggregate('app', {
  AppRegistered: z.object({
    name: z.string().min(1),
    origin: z.string().min(1),
    at: z.number().int(),
  }),
  AppOriginChanged: z.object({
    origin: z.string().min(1),
    at: z.number().int(),
  }),
})

export const AppPolicyEvents = defineAggregate('app_policy', {
  // Set (or override) the minimum role for one app action. One stream per
  // (app, action); re-setting emits again to the same stream.
  PolicySet: z.object({
    app: z.string().min(1),
    action: z.string().min(1),
    minRole: Role,
    at: z.number().int(),
  }),
})
