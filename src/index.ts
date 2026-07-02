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

const env      = createEnv()
const dbClient = env.libsql('DB')

await runMigrations(dbClient, { app: 'org-service', dir: './migrations' })

const db = createDB(dbClient)

app.route('/v1', orgsRouter(db))
app.route('/v1', workspacesRouter(db))
app.route('/v1', projectsRouter(db))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

const port = parseInt(process.env['PORT'] ?? '3000')

serve({ fetch: app.fetch, port }, () => {
  console.log(`org-service listening on :${port}`)
})
