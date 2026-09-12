import { defineProjection, type PolicyDef } from '@baseworks/foldbase'
import { OrgEvents, ScopeEvents, MembershipEvents, InvitationEvents, AppEvents, AppPolicyEvents } from './events.js'

/**
 * Read-model definitions the service registers on boot (idempotent, like
 * migrations). Columns are inferred from the event field types. Archive events
 * delete the row — the events remain the durable audit trail (ADR 0001).
 *
 * `updated_at` is part of foldbase's read-model spine (server-maintained), so
 * it is never declared here. Only `created_at` is our own column.
 *
 * The service is the authorization layer (it does the membership join in-app),
 * so policies are permissive for the service's own `admin` identity; end-user
 * scoping is enforced in the route handlers, not in foldbase row policies.
 */

export const readOrgs = defineProjection('orgs', OrgEvents, (on) => ({
  OrgCreated: on.OrgCreated.upsert((e) => ({
    name: e.name,
    slug: e.slug,
    short_id: e.shortId,
    metadata: e.metadata,
    created_at: e.at,
  })),
  OrgUpdated: on.OrgUpdated.upsert((e) => ({
    name: e.name,
    slug: e.slug,
    metadata: e.metadata,
  })),
  OrgArchived: on.OrgArchived.delete(),
}))

export const readScopes = defineProjection('scopes', ScopeEvents, (on) => ({
  ScopeCreated: on.ScopeCreated.upsert((e) => ({
    org_id: e.orgId,
    kind: e.kind,
    parent_id: e.parentId,
    name: e.name,
    slug: e.slug,
    short_id: e.shortId,
    is_default: e.isDefault,
    created_at: e.at,
  })),
  ScopeUpdated: on.ScopeUpdated.upsert((e) => ({
    name: e.name,
    slug: e.slug,
    is_default: e.isDefault,
  })),
  ScopeArchived: on.ScopeArchived.delete(),
}))

export const readOrgMembers = defineProjection('org_members', MembershipEvents, (on) => ({
  MemberAdded: on.MemberAdded.upsert((e) => ({
    org_id: e.orgId,
    user_id: e.userId,
    role: e.role,
    created_at: e.at,
  })),
  MemberRoleChanged: on.MemberRoleChanged.upsert((e) => ({
    role: e.role,
  })),
  MemberRemoved: on.MemberRemoved.delete(),
}))

export const readOrgInvitations = defineProjection('org_invitations', InvitationEvents, (on) => ({
  InvitationCreated: on.InvitationCreated.upsert((e) => ({
    org_id: e.orgId,
    email: e.email,
    role: e.role,
    invited_by: e.invitedBy,
    created_at: e.at,
  })),
  // Accepting or revoking removes the pending row; the events remain the audit
  // trail, and acceptance is mirrored by a MemberAdded on the membership stream.
  InvitationAccepted: on.InvitationAccepted.delete(),
  InvitationRevoked: on.InvitationRevoked.delete(),
}))

export const readApps = defineProjection('apps', AppEvents, (on) => ({
  AppRegistered: on.AppRegistered.upsert((e) => ({
    name: e.name,
    origin: e.origin,
    created_at: e.at,
  })),
  AppOriginChanged: on.AppOriginChanged.upsert((e) => ({
    origin: e.origin,
  })),
}))

export const readAppPolicies = defineProjection('app_policies', AppPolicyEvents, (on) => ({
  PolicySet: on.PolicySet.upsert((e) => ({
    app: e.app,
    action: e.action,
    min_role: e.minRole,
    created_at: e.at,
  })),
}))

export const PROJECTIONS = [readOrgs, readScopes, readOrgMembers, readOrgInvitations, readApps, readAppPolicies] as const

/** Permissive policies for the service's own `admin` identity (see ADR 0001). */
export const POLICIES: PolicyDef[] = [
  { name: 'orgs', role: 'admin' },
  { name: 'scopes', role: 'admin' },
  { name: 'org_members', role: 'admin' },
  { name: 'org_invitations', role: 'admin' },
  { name: 'apps', role: 'admin' },
  { name: 'app_policies', role: 'admin' },
]
