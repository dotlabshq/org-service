import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { requireAuth } from '../lib/auth.js'
import { generateId, generateShortId, generateSlug } from '@baseworks/core'
import type { DB } from '../db/client.js'
import { schema } from '../db/client.js'
import { provisionDefaults } from './defaults.js'

export function workspacesRouter(db: DB) {
  const app = new Hono()
  const { organizations, workspaces, orgMemberships } = schema

  app.use('*', requireAuth)

  async function getOrgForUser(ref: string, userId: string) {
    const rows = await db.select().from(organizations).where(eq(organizations.slug, ref)).limit(1)
    const org  = rows[0]
    if (!org) return null
    const mem = await db.select().from(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
      .then(r => r.find(m => m.userId === userId))
    return mem ? org : null
  }

  app.get('/:orgRef/workspaces', async (c) => {
    const auth = c.get('auth')
    const org  = await getOrgForUser(c.req.param('orgRef'), auth.userId)
    if (!org) return c.json({ error: 'Not found' }, 404)

    const list = await db.select().from(workspaces)
      .where(eq(workspaces.organizationId, org.id))
      .orderBy(desc(workspaces.createdAt))
    return c.json({ workspaces: list })
  })

  app.post('/:orgRef/workspaces', zValidator('json', z.object({
    name:      z.string().min(1),
    slug:      z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
    isDefault: z.boolean().optional(),
  })), async (c) => {
    const auth  = c.get('auth')
    const org   = await getOrgForUser(c.req.param('orgRef'), auth.userId)
    if (!org) return c.json({ error: 'Not found' }, 404)

    const input = c.req.valid('json')
    const now   = Date.now()
    const ws    = {
      id:             generateId(),
      organizationId: org.id,
      shortId:        generateShortId(),
      slug:           input.slug ?? generateSlug(input.name),
      name:           input.name,
      isDefault:      input.isDefault ?? false,
      createdAt:      now,
      updatedAt:      now,
    }
    await db.insert(workspaces).values(ws)
    await provisionDefaults(db, { workspaceId: ws.id })
    return c.json({ workspace: ws }, 201)
  })

  app.get('/:orgRef/workspaces/:wsRef', async (c) => {
    const auth = c.get('auth')
    const org  = await getOrgForUser(c.req.param('orgRef'), auth.userId)
    if (!org) return c.json({ error: 'Not found' }, 404)

    const wsRef = c.req.param('wsRef')
    const rows  = await db.select().from(workspaces)
      .where(eq(workspaces.slug, wsRef)).limit(1)
    const ws = rows[0]
    if (!ws || ws.organizationId !== org.id) return c.json({ error: 'Not found' }, 404)
    return c.json({ workspace: ws })
  })

  app.patch('/:orgRef/workspaces/:wsRef', zValidator('json', z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  })), async (c) => {
    const auth = c.get('auth')
    const org  = await getOrgForUser(c.req.param('orgRef'), auth.userId)
    if (!org) return c.json({ error: 'Not found' }, 404)

    const mem = await db.select().from(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
      .then(r => r.find(m => m.userId === auth.userId))
    if (!mem || mem.role === 'viewer') return c.json({ error: 'Forbidden' }, 403)

    const wsRef = c.req.param('wsRef')
    const rows  = await db.select().from(workspaces).where(eq(workspaces.slug, wsRef)).limit(1)
    const ws    = rows[0]
    if (!ws || ws.organizationId !== org.id) return c.json({ error: 'Not found' }, 404)

    const input = c.req.valid('json')
    await db.update(workspaces).set({ ...input, updatedAt: Date.now() }).where(eq(workspaces.id, ws.id))
    const updated = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
    return c.json({ workspace: updated[0] })
  })

  app.delete('/:orgRef/workspaces/:wsRef', async (c) => {
    const auth = c.get('auth')
    const org  = await getOrgForUser(c.req.param('orgRef'), auth.userId)
    if (!org) return c.json({ error: 'Not found' }, 404)

    const mem = await db.select().from(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
      .then(r => r.find(m => m.userId === auth.userId))
    if (!mem || mem.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const wsRef = c.req.param('wsRef')
    const rows  = await db.select().from(workspaces).where(eq(workspaces.slug, wsRef)).limit(1)
    const ws    = rows[0]
    if (!ws || ws.organizationId !== org.id) return c.json({ error: 'Not found' }, 404)

    await db.delete(workspaces).where(eq(workspaces.id, ws.id))
    return c.json({ ok: true })
  })

  return app
}
