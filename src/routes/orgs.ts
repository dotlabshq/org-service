import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth } from '../lib/auth.js'
import { StoreError, type Store } from '../store.js'
import { Role } from '@baseworks/org/events'

const slug = z.string().min(1).regex(/^[a-z0-9-]+$/)

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

export function orgsRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  async function requireOrg(ref: string, userId: string, roles?: Role[]): Promise<{ orgId: string }> {
    const row = await store.orgRowByRef(ref)
    if (!row) throw new StoreError(404, 'not_found')
    if (roles) {
      const role = await store.roleOf(row.id, userId)
      if (!role || !roles.includes(role)) throw new StoreError(403, 'forbidden')
    }
    return { orgId: row.id }
  }

  app.get('/v1/orgs', async (c) => {
    const auth = c.get('auth')
    return c.json({ orgs: await store.listOrgsForUser(auth.userId) })
  })

  /**
   * Tüm org'lar. Yalnızca SERVİS token'ı: bu bir kullanıcı yüzeyi değil,
   * çağıran servisin (ör. bir platform paneli) kendi operatör yetkisini
   * kendi tarafında doğrulayıp kullandığı bir listedir.
   */
  app.get('/v1/all-orgs', async (c) => {
    const auth = c.get('auth')
    if (auth.tokenType !== 'service') return c.json({ error: 'forbidden' }, 403)
    return c.json({ orgs: await store.listAllOrgs() })
  })

  app.post('/v1/orgs', zValidator('json', z.object({ name: z.string().min(1), slug: slug.optional() })), async (c) => {
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
  app.get('/v1/orgs/:ref', async (c) => {
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

  app.patch('/v1/orgs/:ref', zValidator('json', z.object({ name: z.string().min(1).optional(), slug: slug.optional() })), async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    const org = await store.updateOrg(orgId, c.req.valid('json'), auth.userId).catch(fail)
    return c.json({ org })
  })

  app.delete('/v1/orgs/:ref', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner'])
    await store.archiveOrg(orgId, auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  // ── metadata ──────────────────────────────────────────────────────────────

  app.patch('/v1/orgs/:ref/metadata', zValidator('json', z.record(z.unknown())), async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    await store.setOrgMetadata(orgId, c.req.valid('json'), [], auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  app.delete('/v1/orgs/:ref/metadata/:key', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    await store.setOrgMetadata(orgId, {}, [c.req.param('key')], auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  // ── members ─────────────────────────────────────────────────────────────────

  app.get('/v1/orgs/:ref/members', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin', 'member', 'viewer'])
    return c.json({ members: await store.listMembers(orgId) })
  })

  app.post('/v1/orgs/:ref/members', zValidator('json', z.object({ userId: z.string().min(1), role: Role })), async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    const input = c.req.valid('json')
    const member = await store.addMember({ orgId, userId: input.userId, role: input.role, actor: auth.userId }).catch(fail)
    return c.json({ member }, 201)
  })

  app.delete('/v1/orgs/:ref/members/:userId', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await requireOrg(c.req.param('ref'), auth.userId, ['owner', 'admin'])
    await store.removeMember(orgId, c.req.param('userId'), auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  return app
}
