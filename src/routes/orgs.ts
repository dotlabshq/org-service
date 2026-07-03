import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { requireAuth } from '../lib/auth.js'
import { generateId, generateShortId, generateSlug } from '@baseworks/core'
import type { DB } from '../db/client.js'
import { schema } from '../db/client.js'
import { provisionDefaults } from './defaults.js'

export function orgsRouter(db: DB) {
  const app = new Hono()
  const { organizations, orgMemberships } = schema

  app.use('*', requireAuth)

  app.get('/', async (c) => {
    const auth = c.get('auth')
    const rows = await db
      .select({ org: organizations })
      .from(organizations)
      .innerJoin(orgMemberships, eq(orgMemberships.organizationId, organizations.id))
      .where(eq(orgMemberships.userId, auth.userId))
      .orderBy(desc(organizations.createdAt))
    return c.json({ orgs: rows.map(r => r.org) })
  })

  app.post('/', zValidator('json', z.object({
    name: z.string().min(1),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  })), async (c) => {
    const auth  = c.get('auth')
    const input = c.req.valid('json')
    const now   = Date.now()
    const org   = {
      id:        generateId(),
      shortId:   generateShortId(),
      slug:      input.slug ?? generateSlug(input.name),
      name:      input.name,
      metadata:  null,
      createdAt: now,
      updatedAt: now,
    }
    await db.insert(organizations).values(org)
    await db.insert(orgMemberships).values({
      id:             generateId(),
      organizationId: org.id,
      userId:         auth.userId,
      role:           'admin',
      createdAt:      now,
      updatedAt:      now,
    })
    await provisionDefaults(db, { organizationId: org.id })
    return c.json({ org }, 201)
  })

  app.get('/:ref', async (c) => {
    const ref  = c.req.param('ref')
    const rows = await db.select().from(organizations).where(eq(organizations.slug, ref)).limit(1)
    const org  = rows[0] ?? (await db.select().from(organizations).where(eq(organizations.shortId, ref)).limit(1))[0]
    if (!org) return c.json({ error: 'Not found' }, 404)
    return c.json({ org })
  })

  app.patch('/:ref', zValidator('json', z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  })), async (c) => {
    const ref  = c.req.param('ref')
    const auth = c.get('auth')
    const rows = await db.select().from(organizations).where(eq(organizations.slug, ref)).limit(1)
    const org  = rows[0]
    if (!org) return c.json({ error: 'Not found' }, 404)

    const mem = await db.select().from(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
      .then(r => r.find(m => m.userId === auth.userId))
    if (!mem || mem.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const input = c.req.valid('json')
    await db.update(organizations).set({ ...input, updatedAt: Date.now() }).where(eq(organizations.id, org.id))
    const updated = await db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1)
    return c.json({ org: updated[0] })
  })

  app.delete('/:ref', async (c) => {
    const ref  = c.req.param('ref')
    const auth = c.get('auth')
    const rows = await db.select().from(organizations).where(eq(organizations.slug, ref)).limit(1)
    const org  = rows[0]
    if (!org) return c.json({ error: 'Not found' }, 404)

    const mem = await db.select().from(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
      .then(r => r.find(m => m.userId === auth.userId))
    if (!mem || mem.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    await db.delete(organizations).where(eq(organizations.id, org.id))
    return c.json({ ok: true })
  })

  app.get('/:ref/members', async (c) => {
    const ref  = c.req.param('ref')
    const rows = await db.select().from(organizations).where(eq(organizations.slug, ref)).limit(1)
    const org  = rows[0]
    if (!org) return c.json({ error: 'Not found' }, 404)
    const list = await db.select().from(orgMemberships).where(eq(orgMemberships.organizationId, org.id))
    return c.json({ members: list })
  })

  app.post('/:ref/members', zValidator('json', z.object({
    userId: z.string(),
    role:   z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
  })), async (c) => {
    const ref   = c.req.param('ref')
    const auth  = c.get('auth')
    const input = c.req.valid('json')

    const rows = await db.select().from(organizations).where(eq(organizations.slug, ref)).limit(1)
    const org  = rows[0]
    if (!org) return c.json({ error: 'Not found' }, 404)

    const allMembers = await db.select().from(orgMemberships).where(eq(orgMemberships.organizationId, org.id))
    const requester  = allMembers.find(m => m.userId === auth.userId)
    const isSelf     = input.userId === auth.userId
    const orgEmpty   = allMembers.length === 0

    if (!requester && !(isSelf && orgEmpty)) return c.json({ error: 'Forbidden' }, 403)
    if (requester && requester.role !== 'admin' && requester.role !== 'owner' && !(isSelf && orgEmpty)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const now    = Date.now()
    const member = {
      id:             generateId(),
      organizationId: org.id,
      userId:         input.userId,
      role:           input.role,
      createdAt:      now,
      updatedAt:      now,
    }
    await db.insert(orgMemberships).values(member)
    return c.json({ member }, 201)
  })

  app.delete('/:ref/members/:userId', async (c) => {
    const ref    = c.req.param('ref')
    const userId = c.req.param('userId')
    const auth   = c.get('auth')

    const rows = await db.select().from(organizations).where(eq(organizations.slug, ref)).limit(1)
    const org  = rows[0]
    if (!org) return c.json({ error: 'Not found' }, 404)

    const requester = await db.select().from(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
      .then(r => r.find(m => m.userId === auth.userId))

    if (!requester || (requester.role !== 'admin' && requester.role !== 'owner' && auth.userId !== userId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    await db.delete(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
    return c.json({ ok: true })
  })

  return app
}
