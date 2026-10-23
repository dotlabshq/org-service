import type { Context, MiddlewareHandler, Next } from 'hono'
import { createOrgClient, OrgError } from './client.js'
import type { Role } from './types.js'

/**
 * Hono middleware: which organisation — and optionally which scope — this
 * request is for, resolved and authorised (ADR-042 §3).
 *
 * `X-Org-Id` is a reference, not a fact. It may carry an id, a slug or a
 * short id; a console sends the id it has, a terminal that ran `use acme`
 * sends the slug. The header is never what gets stored against: the org id is
 * the storage tenant, so `acme` and the org's real id would be two tenants for
 * one organisation — whichever client wrote last. The PDP answers with the
 * scope it resolved, and that canonical id is what the service uses.
 *
 * This used to be the same twenty lines in every product service. One copy
 * means one set of answers: the same codes, the same 404-not-403 for a
 * stranger, and the checks a copy tends to forget — a narrowed token's org,
 * for one.
 *
 * After it runs, the context carries:
 *   orgId    the canonical org id — the tenant
 *   orgRole  the caller's role there ('service' for a service token)
 *   bearer   the caller's token, to forward
 *   scopeId  the canonical scope id, when `X-Flect-Scope` named one
 *
 * Expects `requireAuth` from @baseworks/auth/hono to have run first.
 */

declare module 'hono' {
  interface ContextVariableMap {
    orgId: string
    orgRole: Role | 'service'
    bearer: string
    scopeId?: string
  }
}

export interface RequireOrgOptions {
  /** org-service base URL, e.g. ORG_SERVICE_URL or the gateway's /v1/org. */
  baseUrl: string
  /**
   * Whether to read `X-Flect-Scope` too and resolve it inside the org.
   * Default true; the header stays optional either way — a missing one sets
   * no scopeId, a bad one is 404.
   */
  scope?: boolean
  /** The scope header's name. Default `X-Flect-Scope`. */
  scopeHeader?: string
  fetch?: typeof fetch
}

export function requireOrg(opts: RequireOrgOptions): MiddlewareHandler {
  const scopeHeader = opts.scopeHeader ?? 'X-Flect-Scope'
  const readScope = opts.scope !== false

  return async (c: Context, next: Next) => {
    const auth = c.get('auth')
    if (!auth) return c.json({ error: 'unauthorized', message: 'requireOrg needs requireAuth before it' }, 401)

    const orgRef = c.req.header('X-Org-Id')
    if (!orgRef) {
      return c.json({ error: 'org_required', message: 'Missing X-Org-Id — run `use <org>` first' }, 400)
    }
    const bearer = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    c.set('bearer', bearer)
    const org = createOrgClient({ baseUrl: opts.baseUrl, token: bearer, ...(opts.fetch ? { fetch: opts.fetch } : {}) })

    let orgId: string
    if (auth.tokenType === 'service') {
      // A service is a trusted plane caller acting as itself: no membership
      // to check, and therefore no resolution either — it must name the org
      // by its id. A slug from a service would land in a tenant of its own.
      orgId = orgRef
      c.set('orgRole', 'service')
    } else {
      try {
        const { role, via } = await org.effectiveRole(orgRef)
        if (role === 'none') {
          // Not 404: the org may well exist. But a non-member learns nothing
          // more than "not yours" — the PDP already hid whether `orgRef` is
          // real by answering the same way for a stranger and a ghost.
          return c.json({ error: 'forbidden', message: 'Not a member of this org' }, 403)
        }
        orgId = via?.scope_id ?? orgRef
        c.set('orgRole', role)
      } catch (e) {
        if (e instanceof OrgError && e.status === 404) {
          return c.json({ error: 'org_not_found', message: 'Active org does not exist — run `use <org>` with a valid org' }, 404)
        }
        return c.json({ error: 'authz_unavailable', message: (e as Error).message }, 502)
      }
    }

    // A narrowed token (auth-service `/exchange`) is restricted to one org.
    // `org_id` on it is a restriction, not a grant: membership was checked
    // above; this checks the restriction. Without it, a token narrowed to
    // org A would work in org B wherever its subject is also a member.
    if (auth.orgId && auth.orgId !== orgId) {
      return c.json({ error: 'org_mismatch', message: 'This token is restricted to another organisation' }, 403)
    }
    c.set('orgId', orgId)

    if (readScope) {
      const scopeRef = c.req.header(scopeHeader)
      if (scopeRef) {
        try {
          const scope = await org.scope(orgId, scopeRef)
          c.set('scopeId', scope.id)
        } catch (e) {
          if (e instanceof OrgError && e.status === 404) {
            return c.json({ error: 'scope_not_found', message: `No scope ${scopeRef} in this org — run \`use\` again` }, 404)
          }
          return c.json({ error: 'authz_unavailable', message: (e as Error).message }, 502)
        }
      }
    }

    return next()
  }
}
