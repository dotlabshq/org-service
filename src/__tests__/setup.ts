import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { Hono } from 'hono'
import * as sqliteSchema from '../db/schema.js'
import { orgsRouter } from '../routes/orgs.js'
import { workspacesRouter } from '../routes/workspaces.js'
import { projectsRouter } from '../routes/projects.js'
import { signHs256Jwt } from '@baseworks/auth/jwt'

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY NOT NULL,
  short_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS org_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  short_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(organization_id, slug)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  short_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, slug)
);
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, slug)
);
`

export const JWT_SECRET = 'test-secret-32-chars-long-enough!'
export const USER_ID    = 'user-test-001'

export function makeToken(userId = USER_ID, orgId?: string) {
  return signHs256Jwt(
    { sub: userId, org_id: orgId, type: 'human' },
    JWT_SECRET,
    3600,
  )
}

export async function createTestApp() {
  process.env['JWT_SECRET'] = JWT_SECRET

  const client = createClient({ url: ':memory:' })

  // Run migrations inline
  const stmts = MIGRATION_SQL
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
  for (const sql of stmts) {
    await client.execute(sql)
  }

  const db = drizzle(client as never, { schema: sqliteSchema })

  const app = new Hono()
  app.route('/', orgsRouter(db))
  app.route('/', workspacesRouter(db))
  app.route('/', projectsRouter(db))

  function req(method: string, path: string, body?: unknown, token?: string) {
    const t = token ?? makeToken()
    const init: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${t}`,
        'Content-Type': 'application/json',
      },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    return app.fetch(new Request(`http://localhost${path}`, init))
  }

  function unauth(method: string, path: string) {
    return app.fetch(new Request(`http://localhost${path}`, { method }))
  }

  return {
    db,
    fetch:  app.fetch.bind(app),
    get:    (path: string, token?: string) => req('GET', path, undefined, token),
    post:   (path: string, body: unknown, token?: string) => req('POST', path, body, token),
    patch:  (path: string, body: unknown, token?: string) => req('PATCH', path, body, token),
    del:    (path: string, token?: string) => req('DELETE', path, undefined, token),
    unauth: (path: string) => unauth('GET', path),
  }
}
