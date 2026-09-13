import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth } from '../lib/auth.js'
import { StoreError, type Store } from '../store.js'
import { Role } from '@baseworks/org/events'
import { callerEmail, EmailUnavailable, StoreNotFound } from '../lib/caller-email.js'

const slug = z.string().min(1).regex(/^[a-z0-9-]+$/)

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

export function orgsRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  /**
   * Services allowed to write memberships, by token subject:
   *
   *   ORG_MEMBERSHIP_WRITERS=zone9-api,other-service
   *
   * Deny by default — an empty list means no service may. This exists because
   * the alternative in practice was worse: a product API that needed to add a
   * member was minting a token *as the inviting user* with the shared signing
   * secret, because acting as itself was not allowed. Naming the service here
   * grants exactly that one power, to exactly those services, and lets the
   * impersonation stop.
   *
   * It is an allowlist rather than "any service token" because a membership
   * write grants access to somebody's resources; reading the org list does not.
   */
  function mayWriteMembership(subject: string): boolean {
    const allowed = (process.env['ORG_MEMBERSHIP_WRITERS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return allowed.includes(subject)
  }

  async function requireOrg(ref: string, userId: string, roles?: Role[]): Promise<{ orgId: string }> {
    const row = await store.orgRowByRef(ref)
    if (!row) throw new StoreError(404, 'not_found')
    if (roles) {
      const role = await store.roleOf(row.id, userId)
      if (!role || !roles.includes(role)) throw new StoreError(403, 'forbidden')
    }
    return { orgId: row.id }
  }

  app.get('/orgs', async (c) => {
    const auth = c.get('auth')
    return c.json({ orgs: await store.listOrgsForUser(auth.userId) })
  })

  /**
   * Tüm org'lar. Yalnızca SERVİS token'ı: bu bir kullanıcı yüzeyi değil,
   * çağıran servisin (ör. bir platform paneli) kendi operatör yetkisini
   * kendi tarafında doğrulayıp kullandığı bir listedir.
   */
  app.get('/all-orgs', async (c) => {
    const auth = c.get('auth')
    if (auth.tokenType !== 'service') return c.json({ error: 'forbidden' }, 403)
    return c.json({ orgs: await store.listAllOrgs() })
  })

  app.post('/orgs', zValidator('json', z.object({ name: z.string().min(1), slug: slug.optional() })), async (c) => {
    const auth = c.get('auth')
    const input = c.req.valid('json')
    const org = await store.createOrg({ name: input.name, slug: input.slug, ownerId: auth.userId }).catch(fail)
    return c.json({ org }, 201)
  })

  /**
   * Read one org.
   *
   * Members of any role may read it; a service token may too, on the same basis
   * as `/v1/all-orgs` — a trusted caller that has done its own authorisation.
   *
   * A non-member gets **404, not 403**. 403 would confirm the org exists, which
   * turns a slug guess into a membership oracle: names, and whether a company
   * has an account here, leak one probe at a time. Until now this endpoint
   * checked nothing at all and any signed-in user could read any org by slug.
   */
  app.get('/orgs/:ref', async (c) => {
    const auth = c.get('auth')
    const row = await store.orgRowByRef(c.req.param('ref'))
    if (!row) return c.json({ error: 'not_found' }, 404)

    if (auth.tokenType !== 'service') {
      const role = await store.roleOf(row.id, auth.userId)
      if (!role) return c.json({ error: 'not_found' }, 404)
    }

    const org = await store.getOrg(c.req.param('ref'))
    return c.json({ org })
  })

  app.patch('/orgs/:ref', zValidator('json', z.object({ name: z.string().min(1).optional(), slug: slug.optional() })), async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    const org = await store.updateOrg(orgId, c.req.valid('json'), auth.userId).catch(fail)
    return c.json({ org })
  })

  app.delete('/orgs/:ref', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner'])
    await store.archiveOrg(orgId, auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  // ── metadata ──────────────────────────────────────────────────────────────

  app.patch('/orgs/:ref/metadata', zValidator('json', z.record(z.unknown())), async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    await store.setOrgMetadata(orgId, c.req.valid('json'), [], auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  app.delete('/orgs/:ref/metadata/:key', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    await store.setOrgMetadata(orgId, {}, [c.req.param('key')], auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  // ── members ─────────────────────────────────────────────────────────────────

  app.get('/orgs/:ref/members', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin', 'member', 'viewer'])
    return c.json({ members: await store.listMembers(orgId) })
  })

  /**
   * Resolve the org for a membership write.
   *
   * An owner or admin may do it. So may a service named in
   * ORG_MEMBERSHIP_WRITERS, acting as itself — the audit trail then records the
   * service as the actor, which is the truth, instead of a user who never
   * pressed anything.
   */
  async function orgForMembershipWrite(c: {
    req: { param: (k: string) => string }
  }, auth: { userId: string; tokenType: string }): Promise<{ orgId: string }> {
    if (auth.tokenType === 'service') {
      if (!mayWriteMembership(auth.userId)) throw new StoreError(403, 'forbidden')
      const row = await store.orgRowByRef(c.req.param('ref'))
      if (!row) throw new StoreError(404, 'not_found')
      return { orgId: row.id }
    }
    return requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
  }

  app.post('/orgs/:ref/members', zValidator('json', z.object({ user_id: z.string().min(1), role: Role })), async (c) => {
    const auth = c.get('auth')
    const { orgId } = await orgForMembershipWrite(c, auth)
    const input = c.req.valid('json')
    const member = await store.addMember({ orgId, userId: input.user_id, role: input.role, actor: auth.userId }).catch(fail)
    return c.json({ member }, 201)
  })

  app.delete('/orgs/:ref/members/:userId', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await orgForMembershipWrite(c, auth)
    await store.removeMember(orgId, c.req.param('userId'), auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  // ── invitations ─────────────────────────────────────────────────────────────
  //
  // An invitation is a pending intent addressed to an email. Accepting one
  // writes the membership; the invitation events remain the record of who
  // invited whom.

  /** The caller's email, or a 409 that says why it could not be determined. */
  async function emailOf(c: { req: { header: (k: string) => string | undefined } }, auth: { userId: string; email?: string }): Promise<string> {
    const bearer = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    try {
      return await callerEmail(auth, bearer)
    } catch (err) {
      if (err instanceof EmailUnavailable) throw new StoreError(409, 'email_unavailable', err.message)
      if (err instanceof StoreNotFound) throw new StoreError(409, 'no_email', err.message)
      throw err
    }
  }

  app.get('/orgs/:ref/invitations', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    return c.json({ invitations: await store.listInvitations(orgId) })
  })

  app.post(
    '/orgs/:ref/invitations',
    zValidator('json', z.object({ email: z.string().min(3).includes('@'), role: Role })),
    async (c) => {
      const auth = c.get('auth')
      const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
      const input = c.req.valid('json')
      const invitation = await store
        .createInvitation({ orgId, email: input.email, role: input.role, actor: auth.userId })
        .catch(fail)
      return c.json({ invitation }, 201)
    },
  )

  app.delete('/orgs/:ref/invitations/:id', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    await store.revokeInvitation(orgId, c.req.param('id'), auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  /** The caller's own pending invitations, across every org. */
  app.get('/invitations', async (c) => {
    const auth = c.get('auth')
    const email = await emailOf(c, auth)
    return c.json({ invitations: await store.listInvitationsForEmail(email) })
  })

  /**
   * Accept an invitation.
   *
   * The id is checked against the caller's own email, so an id seen in a log or
   * a screenshot is not enough to join an org — the invitation has to have been
   * addressed to you. A mismatch answers 404 rather than 403, which would
   * confirm the id is real.
   */
  app.post('/invitations/:id/accept', async (c) => {
    const auth = c.get('auth')
    const email = await emailOf(c, auth)
    const member = await store.acceptInvitation(c.req.param('id'), auth.userId, email).catch(fail)
    return c.json({ member }, 201)
  })

  return app
}
