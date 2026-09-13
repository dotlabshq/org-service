import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireAuth } from '../lib/auth.js'
import { StoreError, type Store } from '../store.js'
import type { Role, ScopeRow } from '@baseworks/org'

const slug = z.string().min(1).regex(/^[a-z0-9-]+$/)
const body = z.object({ name: z.string().min(1), slug: slug.optional() })
const patchBody = z.object({ name: z.string().min(1).optional(), slug: slug.optional(), is_default: z.boolean().optional() })

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/** Workspace / project / environment — one scope aggregate, three nested levels. */
export function scopesRouter(store: Store) {
  const app = new Hono()
  app.use('*', requireAuth)

  async function orgCtx(orgRef: string, userId: string): Promise<{ orgId: string; role: Role }> {
    const row = await store.orgRowByRef(orgRef)
    if (!row) throw new StoreError(404, 'not_found')
    const role = await store.roleOf(row.id, userId)
    if (!role) throw new StoreError(404, 'not_found')
    return { orgId: row.id, role }
  }
  const canWrite = (r: Role) => r !== 'viewer'
  const canDelete = (r: Role) => r === 'owner' || r === 'admin'

  async function resolve(orgId: string, kind: ScopeRow['kind'], parentId: string, ref: string): Promise<ScopeRow> {
    const row = await store.scopeByRef(orgId, kind, parentId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    return row
  }

  // ── workspaces ───────────────────────────────────────────────────────────────

  app.get('/orgs/:orgRef/workspaces', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await orgCtx(c.req.param('orgRef'), auth.userId)
    return c.json({ workspaces: await store.listScopes(orgId, 'workspace', orgId) })
  })

  app.post('/orgs/:orgRef/workspaces', zValidator('json', body), async (c) => {
    const auth = c.get('auth')
    const { orgId, role } = await orgCtx(c.req.param('orgRef'), auth.userId)
    if (!canWrite(role)) return c.json({ error: 'forbidden' }, 403)
    const input = c.req.valid('json')
    const workspace = await store.createScope({ orgId, kind: 'workspace', parentId: orgId, name: input.name, slug: input.slug, actor: auth.userId, provision: true }).catch(fail)
    return c.json({ workspace }, 201)
  })

  app.get('/orgs/:orgRef/workspaces/:wsRef', async (c) => {
    const auth = c.get('auth')
    const { orgId } = await orgCtx(c.req.param('orgRef'), auth.userId)
    const ws = await resolve(orgId, 'workspace', orgId, c.req.param('wsRef'))
    return c.json({ workspace: store.toScope(ws) })
  })

  app.patch('/orgs/:orgRef/workspaces/:wsRef', zValidator('json', patchBody), async (c) => {
    const auth = c.get('auth')
    const { orgId, role } = await orgCtx(c.req.param('orgRef'), auth.userId)
    if (!canWrite(role)) return c.json({ error: 'forbidden' }, 403)
    const ws = await resolve(orgId, 'workspace', orgId, c.req.param('wsRef'))
    const workspace = await store.updateScope(ws.id, c.req.valid('json'), auth.userId).catch(fail)
    return c.json({ workspace })
  })

  app.delete('/orgs/:orgRef/workspaces/:wsRef', async (c) => {
    const auth = c.get('auth')
    const { orgId, role } = await orgCtx(c.req.param('orgRef'), auth.userId)
    if (!canDelete(role)) return c.json({ error: 'forbidden' }, 403)
    const ws = await resolve(orgId, 'workspace', orgId, c.req.param('wsRef'))
    await store.archiveScope(ws.id, auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  // ── projects ─────────────────────────────────────────────────────────────────

  async function wsCtx(c: { req: { param: (k: string) => string } }, userId: string) {
    const { orgId, role } = await orgCtx(c.req.param('orgRef'), userId)
    const ws = await resolve(orgId, 'workspace', orgId, c.req.param('wsRef'))
    return { orgId, role, wsId: ws.id }
  }

  app.get('/orgs/:orgRef/workspaces/:wsRef/projects', async (c) => {
    const auth = c.get('auth')
    const { orgId, wsId } = await wsCtx(c, auth.userId)
    return c.json({ projects: await store.listScopes(orgId, 'project', wsId) })
  })

  app.post('/orgs/:orgRef/workspaces/:wsRef/projects', zValidator('json', body), async (c) => {
    const auth = c.get('auth')
    const { orgId, role, wsId } = await wsCtx(c, auth.userId)
    if (!canWrite(role)) return c.json({ error: 'forbidden' }, 403)
    const input = c.req.valid('json')
    const project = await store.createScope({ orgId, kind: 'project', parentId: wsId, name: input.name, slug: input.slug, actor: auth.userId, provision: true }).catch(fail)
    return c.json({ project }, 201)
  })

  app.get('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef', async (c) => {
    const auth = c.get('auth')
    const { orgId, wsId } = await wsCtx(c, auth.userId)
    const proj = await resolve(orgId, 'project', wsId, c.req.param('projRef'))
    return c.json({ project: store.toScope(proj) })
  })

  app.patch('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef', zValidator('json', patchBody), async (c) => {
    const auth = c.get('auth')
    const { orgId, role, wsId } = await wsCtx(c, auth.userId)
    if (!canWrite(role)) return c.json({ error: 'forbidden' }, 403)
    const proj = await resolve(orgId, 'project', wsId, c.req.param('projRef'))
    const project = await store.updateScope(proj.id, c.req.valid('json'), auth.userId).catch(fail)
    return c.json({ project })
  })

  app.delete('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef', async (c) => {
    const auth = c.get('auth')
    const { orgId, role, wsId } = await wsCtx(c, auth.userId)
    if (!canDelete(role)) return c.json({ error: 'forbidden' }, 403)
    const proj = await resolve(orgId, 'project', wsId, c.req.param('projRef'))
    await store.archiveScope(proj.id, auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  // ── environments ──────────────────────────────────────────────────────────────

  async function projCtx(c: { req: { param: (k: string) => string } }, userId: string) {
    const { orgId, role, wsId } = await wsCtx(c, userId)
    const proj = await resolve(orgId, 'project', wsId, c.req.param('projRef'))
    return { orgId, role, projId: proj.id }
  }

  app.get('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef/envs', async (c) => {
    const auth = c.get('auth')
    const { orgId, projId } = await projCtx(c, auth.userId)
    return c.json({ envs: await store.listScopes(orgId, 'environment', projId) })
  })

  app.post('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef/envs', zValidator('json', body), async (c) => {
    const auth = c.get('auth')
    const { orgId, role, projId } = await projCtx(c, auth.userId)
    if (!canWrite(role)) return c.json({ error: 'forbidden' }, 403)
    const input = c.req.valid('json')
    const env = await store.createScope({ orgId, kind: 'environment', parentId: projId, name: input.name, slug: input.slug, actor: auth.userId }).catch(fail)
    return c.json({ env }, 201)
  })

  app.get('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef/envs/:envRef', async (c) => {
    const auth = c.get('auth')
    const { orgId, projId } = await projCtx(c, auth.userId)
    const env = await resolve(orgId, 'environment', projId, c.req.param('envRef'))
    return c.json({ env: store.toScope(env) })
  })

  app.patch('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef/envs/:envRef', zValidator('json', patchBody), async (c) => {
    const auth = c.get('auth')
    const { orgId, role, projId } = await projCtx(c, auth.userId)
    if (!canWrite(role)) return c.json({ error: 'forbidden' }, 403)
    const env = await resolve(orgId, 'environment', projId, c.req.param('envRef'))
    const updated = await store.updateScope(env.id, c.req.valid('json'), auth.userId).catch(fail)
    return c.json({ env: updated })
  })

  app.delete('/orgs/:orgRef/workspaces/:wsRef/projects/:projRef/envs/:envRef', async (c) => {
    const auth = c.get('auth')
    const { orgId, role, projId } = await projCtx(c, auth.userId)
    if (!canDelete(role)) return c.json({ error: 'forbidden' }, 403)
    const env = await resolve(orgId, 'environment', projId, c.req.param('envRef'))
    await store.archiveScope(env.id, auth.userId).catch(fail)
    return c.json({ ok: true })
  })

  return app
}
