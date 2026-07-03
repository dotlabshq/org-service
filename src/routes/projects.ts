import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { requireAuth } from '../lib/auth.js'
import { generateId, generateShortId, generateSlug } from '@baseworks/core'
import type { DB } from '../db/client.js'
import { schema } from '../db/client.js'
import { provisionDefaults } from './defaults.js'

export function projectsRouter(db: DB) {
  const app = new Hono()
  const { organizations, workspaces, projects, environments, orgMemberships } = schema

  app.use('*', requireAuth)

  async function resolveWorkspace(orgRef: string, wsRef: string, userId: string) {
    const orgRows = await db.select().from(organizations).where(eq(organizations.slug, orgRef)).limit(1)
    const org = orgRows[0]
    if (!org) return null
    const mem = await db.select().from(orgMemberships)
      .where(eq(orgMemberships.organizationId, org.id))
      .then(r => r.find(m => m.userId === userId))
    if (!mem) return null
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.slug, wsRef)).limit(1)
    const ws = wsRows[0]
    if (!ws || ws.organizationId !== org.id) return null
    return { org, ws, role: mem.role }
  }

  // Projects
  app.get('/:orgRef/workspaces/:wsRef/projects', async (c) => {
    const auth = c.get('auth')
    const ctx  = await resolveWorkspace(c.req.param('orgRef'), c.req.param('wsRef'), auth.userId)
    if (!ctx) return c.json({ error: 'Not found' }, 404)

    const list = await db.select().from(projects)
      .where(eq(projects.workspaceId, ctx.ws.id))
      .orderBy(desc(projects.createdAt))
    return c.json({ projects: list })
  })

  app.post('/:orgRef/workspaces/:wsRef/projects', zValidator('json', z.object({
    name:      z.string().min(1),
    slug:      z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
    isDefault: z.boolean().optional(),
  })), async (c) => {
    const auth  = c.get('auth')
    const ctx   = await resolveWorkspace(c.req.param('orgRef'), c.req.param('wsRef'), auth.userId)
    if (!ctx) return c.json({ error: 'Not found' }, 404)
    if (ctx.role === 'viewer') return c.json({ error: 'Forbidden' }, 403)

    const input = c.req.valid('json')
    const now   = Date.now()
    const proj  = {
      id:          generateId(),
      workspaceId: ctx.ws.id,
      shortId:     generateShortId(),
      slug:        input.slug ?? generateSlug(input.name),
      name:        input.name,
      isDefault:   input.isDefault ?? false,
      metadata:    null,
      createdAt:   now,
      updatedAt:   now,
    }
    await db.insert(projects).values(proj)
    await provisionDefaults(db, { projectId: proj.id })
    return c.json({ project: proj }, 201)
  })

  app.get('/:orgRef/workspaces/:wsRef/projects/:projRef', async (c) => {
    const auth = c.get('auth')
    const ctx  = await resolveWorkspace(c.req.param('orgRef'), c.req.param('wsRef'), auth.userId)
    if (!ctx) return c.json({ error: 'Not found' }, 404)

    const projRef = c.req.param('projRef')
    const rows    = await db.select().from(projects).where(eq(projects.slug, projRef)).limit(1)
    const proj    = rows[0]
    if (!proj || proj.workspaceId !== ctx.ws.id) return c.json({ error: 'Not found' }, 404)
    return c.json({ project: proj })
  })

  app.delete('/:orgRef/workspaces/:wsRef/projects/:projRef', async (c) => {
    const auth = c.get('auth')
    const ctx  = await resolveWorkspace(c.req.param('orgRef'), c.req.param('wsRef'), auth.userId)
    if (!ctx) return c.json({ error: 'Not found' }, 404)
    if (ctx.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const projRef = c.req.param('projRef')
    const rows    = await db.select().from(projects).where(eq(projects.slug, projRef)).limit(1)
    const proj    = rows[0]
    if (!proj || proj.workspaceId !== ctx.ws.id) return c.json({ error: 'Not found' }, 404)
    await db.delete(projects).where(eq(projects.id, proj.id))
    return c.json({ ok: true })
  })

  // Environments
  app.get('/:orgRef/workspaces/:wsRef/projects/:projRef/envs', async (c) => {
    const auth = c.get('auth')
    const ctx  = await resolveWorkspace(c.req.param('orgRef'), c.req.param('wsRef'), auth.userId)
    if (!ctx) return c.json({ error: 'Not found' }, 404)

    const projRef = c.req.param('projRef')
    const rows    = await db.select().from(projects).where(eq(projects.slug, projRef)).limit(1)
    const proj    = rows[0]
    if (!proj || proj.workspaceId !== ctx.ws.id) return c.json({ error: 'Not found' }, 404)

    const list = await db.select().from(environments).where(eq(environments.projectId, proj.id))
    return c.json({ envs: list })
  })

  app.post('/:orgRef/workspaces/:wsRef/projects/:projRef/envs', zValidator('json', z.object({
    name: z.string().min(1),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  })), async (c) => {
    const auth = c.get('auth')
    const ctx  = await resolveWorkspace(c.req.param('orgRef'), c.req.param('wsRef'), auth.userId)
    if (!ctx) return c.json({ error: 'Not found' }, 404)
    if (ctx.role === 'viewer') return c.json({ error: 'Forbidden' }, 403)

    const projRef = c.req.param('projRef')
    const rows    = await db.select().from(projects).where(eq(projects.slug, projRef)).limit(1)
    const proj    = rows[0]
    if (!proj || proj.workspaceId !== ctx.ws.id) return c.json({ error: 'Not found' }, 404)

    const input = c.req.valid('json')
    const now   = Date.now()
    const env   = {
      id:        generateId(),
      projectId: proj.id,
      shortId:   generateShortId(),
      slug:      input.slug ?? generateSlug(input.name),
      name:      input.name,
      createdAt: now,
      updatedAt: now,
    }
    await db.insert(environments).values(env)
    return c.json({ env }, 201)
  })

  app.delete('/:orgRef/workspaces/:wsRef/projects/:projRef/envs/:envRef', async (c) => {
    const auth = c.get('auth')
    const ctx  = await resolveWorkspace(c.req.param('orgRef'), c.req.param('wsRef'), auth.userId)
    if (!ctx) return c.json({ error: 'Not found' }, 404)
    if (ctx.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const projRef = c.req.param('projRef')
    const envRef  = c.req.param('envRef')
    const projRows = await db.select().from(projects).where(eq(projects.slug, projRef)).limit(1)
    const proj     = projRows[0]
    if (!proj || proj.workspaceId !== ctx.ws.id) return c.json({ error: 'Not found' }, 404)

    const envRows = await db.select().from(environments).where(eq(environments.slug, envRef)).limit(1)
    const env     = envRows[0]
    if (!env || env.projectId !== proj.id) return c.json({ error: 'Not found' }, 404)

    await db.delete(environments).where(eq(environments.id, env.id))
    return c.json({ ok: true })
  })

  return app
}
