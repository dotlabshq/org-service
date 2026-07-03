import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createEnv, runMigrations } from '@dotlabshq/flect-sdk'
import { createDB } from './db/client.js'
import { orgsRouter } from './routes/orgs.js'
import { workspacesRouter } from './routes/workspaces.js'
import { projectsRouter } from './routes/projects.js'

const app = new Hono()
app.use('*', logger())
app.get('/healthz', (c) => c.json({ ok: true, service: 'org-service' }))

const env = createEnv()

await runMigrations(env.db('DB'), { app: 'org-service', dir: './migrations' })

const db = createDB(env.libsql('DB'))

app.route('/', orgsRouter(db))
app.route('/', workspacesRouter(db))
app.route('/', projectsRouter(db))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

const port = parseInt(process.env['PORT'] ?? '3000')

serve({ fetch: app.fetch, port }, () => {
  console.log(`org-service listening on :${port}`)
})
