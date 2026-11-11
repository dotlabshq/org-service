/**
 * The mounts (workspace ADR 0003): the API under `/api`, which a gateway
 * publishes at `/v1/org`; internal routes at the root, which no gateway rule
 * reaches; and the two older API mounts, kept until every direct caller has
 * moved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestFoldBase, makeServiceToken, makeTestApp, type TestFoldBase } from './setup.js'

let fb: TestFoldBase
let app: Awaited<ReturnType<typeof makeTestApp>>

beforeAll(async () => {
  fb = await bootTestFoldBase()
  app = await makeTestApp(fb)
  await app.post('/api/orgs', { name: 'Acme', slug: 'acme' })
}, 30_000)
afterAll(async () => { await fb.stop() })

const json = async <T>(res: Response) => (await res.json()) as T

describe('the API is under /api', () => {
  it('answers the whole API there, discovery and the contract included', async () => {
    expect((await app.get('/api/orgs')).status).toBe(200)
    expect((await app.get('/api/orgs/acme')).status).toBe(200)
    expect((await app.get('/api/orgs/acme/members')).status).toBe(200)
    expect((await app.get('/api/orgs/acme/workspaces')).status).toBe(200)
    expect((await app.get('/api/invitations')).status).not.toBe(404)
    expect((await app.get('/api/apps')).status).toBe(200)

    const manifest = await json<{ name: string }>(await app.unauth('/api/.well-known/service'))
    expect(manifest.name).toBe('org')
    expect((await app.unauth('/api/openapi.yaml')).status).toBe(200)
  })

  it('is the same API the older mounts answer, not a copy that can drift', async () => {
    const viaApi = await json<{ org: { id: string } }>(await app.get('/api/orgs/acme'))
    const viaRoot = await json<{ org: { id: string } }>(await app.get('/orgs/acme'))
    const viaV1 = await json<{ org: { id: string } }>(await app.get('/v1/orgs/acme'))
    expect(viaRoot.org.id).toBe(viaApi.org.id)
    expect(viaV1.org.id).toBe(viaApi.org.id)
  })

  it('still asks for a token', async () => {
    expect((await app.unauth('/api/orgs')).status).toBe(401)
  })
})

describe('internal routes are at the root and nowhere a gateway publishes', () => {
  it('/all-orgs is not under /api, so replacing /v1/org with /api cannot expose it', async () => {
    const res = await app.get('/api/all-orgs', makeServiceToken())
    expect(res.status).toBe(404)
  })

  it('/all-orgs answers a service on the same network, at the root', async () => {
    const res = await app.get('/all-orgs', makeServiceToken())
    expect(res.status).toBe(200)
    const { orgs } = await json<{ orgs: Array<{ slug: string }> }>(res)
    expect(orgs.some((o) => o.slug === 'acme')).toBe(true)
  })

  it('/all-orgs refuses a person even there', async () => {
    expect((await app.get('/all-orgs')).status).toBe(403)
  })

  it('/healthz is at the root only', async () => {
    expect((await app.unauth('/healthz')).status).toBe(200)
    // Every path under /api asks for a token before it says whether it exists.
    expect((await app.unauth('/api/healthz')).status).toBe(401)
    expect((await app.get('/api/healthz')).status).toBe(404)
  })
})
