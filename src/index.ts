import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createEnv } from '@baseworks/sdk'
import { createApp, registerDefinitions } from './app.js'

const env = createEnv()

// org-service pins tenant 'platform' (FOLDBASE_TENANT); org ids are read-model
// keys, not tenants (ADR 0001). The foldbase sibling is its private store.
const fb = env.service('foldbase')

await registerDefinitions(fb)

const root = new Hono()
root.use('*', logger())
root.route('/', createApp(fb))

const port = Number(env.var('PORT') ?? 3000)
serve({ fetch: root.fetch, port }, () => {
  console.log(`org-service listening on :${port}`)
})
