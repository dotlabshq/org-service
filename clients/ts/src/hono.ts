import type { Context, MiddlewareHandler, Next } from 'hono'
import { createOrgClient, OrgError } from './client.js'
import type { Role } from './types.js'

/**
 * Which organisation — and optionally which scope — a request is for,
 * resolved and authorised (ADR-042 §3).
 *
 * `X-Org-Id` is a reference, not a fact. It may carry an id, a slug or a
 * short id; a console sends the id it has, a terminal that ran `use acme`
 * sends the slug. The header is never what gets stored against: the org id is
 * the storage tenant, so `acme` and the org's real id would be two tenants for
 * one organisation — whichever client wrote last. The PDP answers with the
 * scope it resolved, and that canonical id is what the service uses.
 *
 * Two shapes of the same thing:
 *
 *   resolveOrgContext  the decision, as a function — for a service whose
 *                      request pipeline is not Hono middleware (the flect
 *                      broker authenticates app tokens that are not realm
 *                      JWTs, then canonicalises the headers the same way)
 *   requireOrg         the decision as Hono middleware, for every product
 *                      service after requireAuth
 *
 * This used to be the same twenty lines in every product service. One copy
 * means one set of answers: the same codes, the same 404-not-403 for a
 * stranger, and the checks a copy tends to forget — a narrowed token's org,
 * for one.
 */

declare module 'hono' {
  interface ContextVariableMap {
    orgId: string
    orgRole: Role | 'service'
    bearer: string
    scopeId?: string
  }
}

export interface ResolveOrgOptions {
  /** org-service base URL, e.g. ORG_SERVICE_URL or the gateway's /v1/org. */
  baseUrl: string
  fetch?: typeof fetch
}

export interface ResolveOrgInput {
  /** The caller's token, forwarded to org-service so the PDP sees the acting user. */
  bearer: string
  /** From the verified token: who is calling, and what kind of token it is. */
  auth: { userId: string; tokenType: 'user' | 'service' | 'assistant'; orgId?: string }
  /** `X-Org-Id` as sent. */
  orgRef: string | undefined
  /** `X-Flect-Scope` as sent, if any. */
  scopeRef?: string | undefined
}

export type ResolvedOrg = {
  ok: true
  /** The canonical org id — the tenant. */
  orgId: string
  orgRole: Role | 'service'
  /** The canonical scope id, when a scope was named. */
  scopeId?: string
}

export type OrgRefusal = {
  ok: false
  status: 400 | 403 | 404 | 502
  error: 'org_required' | 'forbidden' | 'org_not_found' | 'org_mismatch' | 'scope_not_found' | 'authz_unavailable'
  message: string
}

/** The decision: a canonical org (and scope), or why not. Never throws. */
export async function resolveOrgContext(opts: ResolveOrgOptions, input: ResolveOrgInput): Promise<ResolvedOrg | OrgRefusal> {
  const { auth, orgRef, scopeRef } = input
  if (!orgRef) {
    return { ok: false, status: 400, error: 'org_required', message: 'Missing X-Org-Id — run `use <org>` first' }
  }
  const org = createOrgClient({ baseUrl: opts.baseUrl, token: input.bearer, ...(opts.fetch ? { fetch: opts.fetch } : {}) })

  let orgId: string
  let orgRole: Role | 'service'
  if (auth.tokenType === 'service') {
    // A service is a trusted plane caller acting as itself: no membership to
    // check, and therefore no resolution either — it must name the org by its
    // id. A slug from a service would land in a tenant of its own.
    orgId = orgRef
    orgRole = 'service'
  } else {
    try {
      const { role, via } = await org.effectiveRole(orgRef)
      if (role === 'none') {
        // Not 404: the org may well exist. A non-member learns nothing more
        // than "not yours" — the PDP already hid whether `orgRef` is real by
        // answering the same way for a stranger and for a ghost.
        return { ok: false, status: 403, error: 'forbidden', message: 'Not a member of this org' }
      }
      orgId = via?.scope_id ?? orgRef
      orgRole = role
    } catch (e) {
      if (e instanceof OrgError && e.status === 404) {
        return { ok: false, status: 404, error: 'org_not_found', message: 'Active org does not exist — run `use <org>` with a valid org' }
      }
      return { ok: false, status: 502, error: 'authz_unavailable', message: (e as Error).message }
    }
  }

  // A narrowed token (auth-service `/exchange`) is restricted to one org.
  // `org_id` on it is a restriction, not a grant: membership was checked
  // above; this checks the restriction. Without it, a token narrowed to org A
  // would work in org B wherever its subject is also a member.
  if (auth.orgId && auth.orgId !== orgId) {
    return { ok: false, status: 403, error: 'org_mismatch', message: 'This token is restricted to another organisation' }
  }

  if (!scopeRef) return { ok: true, orgId, orgRole }
  try {
    const scope = await org.scope(orgId, scopeRef)
    return { ok: true, orgId, orgRole, scopeId: scope.id }
  } catch (e) {
    if (e instanceof OrgError && e.status === 404) {
      return { ok: false, status: 404, error: 'scope_not_found', message: `No scope ${scopeRef} in this org — run \`use\` again` }
    }
    return { ok: false, status: 502, error: 'authz_unavailable', message: (e as Error).message }
  }
}

export interface RequireOrgOptions extends ResolveOrgOptions {
  /**
   * Whether to read `X-Flect-Scope` too and resolve it inside the org.
   * Default true; the header stays optional either way — a missing one sets
   * no scopeId, a bad one is 404.
   */
  scope?: boolean
  /** The scope header's name. Default `X-Flect-Scope`. */
  scopeHeader?: string
}

/**
 * Hono middleware over `resolveOrgContext`. Expects `requireAuth` from
 * @baseworks/auth/hono to have run first. Afterwards the context carries
 * `orgId`, `orgRole`, `bearer` and — when `X-Flect-Scope` named one — `scopeId`.
 */
export function requireOrg(opts: RequireOrgOptions): MiddlewareHandler {
  const scopeHeader = opts.scopeHeader ?? 'X-Flect-Scope'
  const readScope = opts.scope !== false

  return async (c: Context, next: Next) => {
    const auth = c.get('auth')
    if (!auth) return c.json({ error: 'unauthorized', message: 'requireOrg needs requireAuth before it' }, 401)

    const bearer = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    c.set('bearer', bearer)

    const r = await resolveOrgContext(opts, {
      bearer,
      auth,
      orgRef: c.req.header('X-Org-Id'),
      ...(readScope ? { scopeRef: c.req.header(scopeHeader) } : {}),
    })
    if (!r.ok) return c.json({ error: r.error, message: r.message }, r.status)

    c.set('orgId', r.orgId)
    c.set('orgRole', r.orgRole)
    if (r.scopeId) c.set('scopeId', r.scopeId)
    return next()
  }
}
