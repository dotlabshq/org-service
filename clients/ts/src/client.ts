import type {
  Organization,
  Scope,
  Membership,
  Invitation,
  Role,
  ScopeKind,
  RegisteredApp,
  AppPolicy,
  AppManifest,
  EffectiveRole,
  CheckResult,
} from './types.js'

export type {
  Organization,
  Scope,
  Workspace,
  Project,
  Environment,
  Membership,
  Invitation,
  Role,
  ScopeKind,
  OrgRow,
  ScopeRow,
  MemberRow,
  InvitationRow,
  RegisteredApp,
  AppPolicy,
  AppPolicyRow,
  AppRow,
  AppManifest,
  EffectiveRole,
  CheckResult,
} from './types.js'

/** Forwarded end-user identity (X-Auth-*) for a trusted service caller. */
export interface AuthContext {
  uid?: string
  role?: string
  email?: string
}

export interface OrgClientOptions {
  /** Base URL of org-service (resolved by the SDK, e.g. ORG_SERVICE_URL). */
  baseUrl: string
  /** Bearer token — the caller's service or user token. */
  token?: string
  /** Forwarded end-user identity. */
  auth?: AuthContext
  /** Injectable fetch (tests / non-global environments). */
  fetch?: typeof fetch
}

/** Thrown on any non-2xx response from org-service. */
export class OrgError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'OrgError'
  }
}

/** Minimal ApiClient shape — structurally compatible with @baseworks/cli. */
export interface HttpClient {
  api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>
  get<T>(path: string, headers?: Record<string, string>): Promise<T>
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  patch<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  del<T>(path: string, headers?: Record<string, string>): Promise<T>
}

/**
 * Typed HTTP client for org-service. Zod-free at the boundary (the service
 * validates); this is a thin, ergonomic wrapper over the REST surface. The
 * `.http` accessor exposes a generic ApiClient the CLI plugin consumes.
 */
/**
 * Paths here are the service's own — `/orgs`, not `/v1/orgs`.
 *
 * A service mounts its routes at its root and a gateway publishes it at
 * `/v1/<name>`, stripping that prefix before the request arrives (ADR-042 §4),
 * so a service never encodes where it happens to be mounted and neither does
 * its client. `baseUrl` is wherever the service answers: the gateway mount, or
 * the service itself.
 *
 * This means a server old enough to serve only the legacy `/v1` mount will not
 * answer this client. Both mounts exist today; the legacy one is transitional.
 */
export class OrgClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: OrgClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  /** Return a new client that forwards a different end-user identity. */
  withAuth(auth: AuthContext): OrgClient {
    return new OrgClient({ ...this.opts, auth })
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`
    if (this.opts.auth?.uid) h['X-Auth-UID'] = this.opts.auth.uid
    if (this.opts.auth?.role) h['X-Auth-Role'] = this.opts.auth.role
    if (this.opts.auth?.email) h['X-Auth-Email'] = this.opts.auth.email
    return { ...h, ...extra }
  }

  async api<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined, extra),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 204) return null as T
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string | { code?: string; message?: string }; message?: string }
      const code = typeof e.error === 'string' ? e.error : e.error?.code ?? 'error'
      const msg = typeof e.error === 'object' ? e.error?.message : e.message
      throw new OrgError(res.status, code, msg)
    }
    return data as T
  }

  /** Generic ApiClient (get/post/patch/del) — used by the CLI plugin. */
  get http(): HttpClient {
    return {
      api: this.api.bind(this),
      get: <T>(p: string, h?: Record<string, string>) => this.api<T>('GET', p, undefined, h),
      post: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('POST', p, b, h),
      patch: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('PATCH', p, b, h),
      del: <T>(p: string, h?: Record<string, string>) => this.api<T>('DELETE', p, undefined, h),
    }
  }

  // ── organizations ─────────────────────────────────────────────────────────

  async listOrgs(): Promise<Organization[]> {
    const { orgs } = await this.api<{ orgs: Organization[] }>('GET', '/orgs')
    return orgs
  }
  async getOrg(ref: string): Promise<Organization> {
    const { org } = await this.api<{ org: Organization }>('GET', `/orgs/${ref}`)
    return org
  }
  async createOrg(input: { name: string; slug?: string }): Promise<Organization> {
    const { org } = await this.api<{ org: Organization }>('POST', '/orgs', input)
    return org
  }
  async updateOrg(ref: string, input: { name?: string; slug?: string }): Promise<Organization> {
    const { org } = await this.api<{ org: Organization }>('PATCH', `/orgs/${ref}`, input)
    return org
  }
  async deleteOrg(ref: string): Promise<void> {
    await this.api('DELETE', `/orgs/${ref}`)
  }
  async setOrgMetadata(ref: string, patch: Record<string, unknown>): Promise<void> {
    await this.api('PATCH', `/orgs/${ref}/metadata`, patch)
  }
  async deleteOrgMetadataKey(ref: string, key: string): Promise<void> {
    await this.api('DELETE', `/orgs/${ref}/metadata/${key}`)
  }

  // ── memberships ───────────────────────────────────────────────────────────

  async listMembers(ref: string): Promise<Membership[]> {
    const { members } = await this.api<{ members: Membership[] }>('GET', `/orgs/${ref}/members`)
    return members
  }
  async addMember(ref: string, input: { user_id: string; role: Role }): Promise<Membership> {
    const { member } = await this.api<{ member: Membership }>('POST', `/orgs/${ref}/members`, input)
    return member
  }
  /** Change a member's role. 404 if they are not a member; adding is `addMember`. */
  async changeMemberRole(ref: string, userId: string, role: Role): Promise<Membership> {
    const { member } = await this.api<{ member: Membership }>(
      'PATCH', `/orgs/${encodeURIComponent(ref)}/members/${encodeURIComponent(userId)}`, { role },
    )
    return member
  }

  async removeMember(ref: string, userId: string): Promise<void> {
    await this.api('DELETE', `/orgs/${ref}/members/${userId}`)
  }

  // ── invitations ─────────────────────────────────────────────────────────────

  /** Pending invitations for an org (owner/admin). */
  async listInvitations(ref: string): Promise<Invitation[]> {
    const { invitations } = await this.api<{ invitations: Invitation[] }>('GET', `/orgs/${ref}/invitations`)
    return invitations
  }
  /** Invite an email to an org with a role (owner/admin). Idempotent per email. */
  async createInvitation(ref: string, input: { email: string; role: Role }): Promise<Invitation> {
    const { invitation } = await this.api<{ invitation: Invitation }>('POST', `/orgs/${ref}/invitations`, input)
    return invitation
  }
  /** Revoke a pending invitation (owner/admin). */
  async revokeInvitation(ref: string, id: string): Promise<void> {
    await this.api('DELETE', `/orgs/${ref}/invitations/${id}`)
  }
  /** The caller's own pending invitations, matched on their token email claim. */
  async listMyInvitations(): Promise<Invitation[]> {
    const { invitations } = await this.api<{ invitations: Invitation[] }>('GET', '/invitations')
    return invitations
  }
  /** Accept an invitation addressed to the caller's email → become a member. */
  /** Refuse an invitation addressed to you. Not the same as the org revoking it. */
  async declineInvitation(id: string): Promise<void> {
    await this.api('POST', `/invitations/${encodeURIComponent(id)}/decline`, {})
  }

  async acceptInvitation(id: string): Promise<Membership> {
    const { member } = await this.api<{ member: Membership }>('POST', `/invitations/${id}/accept`, {})
    return member
  }

  // ── scopes (workspaces / projects / environments) ──────────────────────────

  async listWorkspaces(orgRef: string): Promise<Scope[]> {
    const { workspaces } = await this.api<{ workspaces: Scope[] }>('GET', `/orgs/${orgRef}/workspaces`)
    return workspaces
  }
  async createWorkspace(orgRef: string, input: { name: string; slug?: string }): Promise<Scope> {
    const { workspace } = await this.api<{ workspace: Scope }>('POST', `/orgs/${orgRef}/workspaces`, input)
    return workspace
  }
  async listProjects(orgRef: string, wsRef: string): Promise<Scope[]> {
    const { projects } = await this.api<{ projects: Scope[] }>('GET', `/orgs/${orgRef}/workspaces/${wsRef}/projects`)
    return projects
  }
  async createProject(orgRef: string, wsRef: string, input: { name: string; slug?: string }): Promise<Scope> {
    const { project } = await this.api<{ project: Scope }>('POST', `/orgs/${orgRef}/workspaces/${wsRef}/projects`, input)
    return project
  }
  async listEnvironments(orgRef: string, wsRef: string, projRef: string): Promise<Scope[]> {
    const { envs } = await this.api<{ envs: Scope[] }>('GET', `/orgs/${orgRef}/workspaces/${wsRef}/projects/${projRef}/envs`)
    return envs
  }
  async createEnvironment(orgRef: string, wsRef: string, projRef: string, input: { name: string; slug?: string }): Promise<Scope> {
    const { env } = await this.api<{ env: Scope }>('POST', `/orgs/${orgRef}/workspaces/${wsRef}/projects/${projRef}/envs`, input)
    return env
  }

  // ── PDP (access decisions + app registry) ──────────────────────────────────

  /** The effective role a user holds at a scope (org role, inherited downward). */
  async effectiveRole(scopeId: string, userId?: string): Promise<EffectiveRole> {
    const q = new URLSearchParams({ scope: scopeId, ...(userId ? { user: userId } : {}) })
    return this.api<EffectiveRole>('GET', `/authz/role?${q}`)
  }

  /** Ask the PDP whether an app action is allowed at a scope (deny-by-default). */
  async check(input: { app: string; action: string; scopeId: string; userId?: string }): Promise<CheckResult> {
    return this.api<CheckResult>('POST', '/authz/check', {
      app: input.app,
      action: input.action,
      scope_id: input.scopeId,
      ...(input.userId ? { user_id: input.userId } : {}),
    })
  }

  /** Register (or refresh) an app's policy manifest. */
  async registerApp(manifest: AppManifest): Promise<RegisteredApp> {
    const { app } = await this.api<{ app: RegisteredApp }>('POST', '/apps/register', manifest)
    return app
  }

  async listApps(): Promise<RegisteredApp[]> {
    const { apps } = await this.api<{ apps: RegisteredApp[] }>('GET', '/apps')
    return apps
  }

  async listAppPolicies(name: string): Promise<AppPolicy[]> {
    const { policies } = await this.api<{ policies: AppPolicy[] }>('GET', `/apps/${encodeURIComponent(name)}/policies`)
    return policies
  }
}

/** Factory used by the SDK capability registry. */
export function createOrgClient(opts: OrgClientOptions): OrgClient {
  return new OrgClient(opts)
}

export type { ScopeKind as Kind }
