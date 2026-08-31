import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { FoldBase } from '@baseworks/foldbase'
import { signHs256Jwt } from '@baseworks/auth/jwt'
// The foldbase conformance harness boots the Go binary as a private sibling.
// @ts-expect-error — plain ESM helper, no types
import { bootServer, signJwt } from '../../../foldbase/conformance/harness.mjs'
import { createApp, registerDefinitions } from '../app.js'

const here = dirname(fileURLToPath(import.meta.url))
const FB_SECRET = 'org-service-foldbase-secret-32-chars!'
export const JWT_SECRET = 'test-secret-32-chars-long-enough!'
export const USER_ID = 'user-test-001'

process.env['JWT_SECRET'] = JWT_SECRET

export interface TestFoldBase {
  base: string
  svcToken: string
  stop: () => Promise<void>
}

/** Boot one foldbase Go sibling for a test file (fresh in-memory SQLite). */
export async function bootTestFoldBase(): Promise<TestFoldBase> {
  const es = await bootServer({
    cmd: './bin/foldbase',
    dir: resolve(here, '../../../foldbase/go'),
    env: { FOLDBASE_AUTH: 'service-jwt', FOLDBASE_JWT_SECRET: FB_SECRET },
  })
  const svcToken = signJwt({ sub: 'org-service', type: 'service' }, FB_SECRET)
  return { base: es.base, svcToken, stop: es.stop }
}

export function makeToken(userId = USER_ID): string {
  return signHs256Jwt({ sub: userId, type: 'human' }, JWT_SECRET, 3600)
}

/** Servis token'ı — kullanıcı yüzeyi olmayan uçlar için (ör. /v1/all-orgs). */
export function makeServiceToken(name = 'svc'): string {
  return signHs256Jwt({ sub: name, type: 'service' }, JWT_SECRET, 3600)
}

/**
 * Build an isolated org-service app on the shared foldbase. Each app gets a
 * unique tenant so tests don't see each other's events.
 */
export async function makeTestApp(fb: TestFoldBase) {
  const tenant = `t-${randomUUID()}`
  const client = new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant })
  await registerDefinitions(client)
  const app = createApp(client)

  function req(method: string, path: string, body?: unknown, token?: string) {
    const t = token ?? makeToken()
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    return app.fetch(new Request(`http://localhost${path}`, init))
  }

  return {
    app,
    tenant,
    get: (path: string, token?: string) => req('GET', path, undefined, token),
    post: (path: string, body: unknown, token?: string) => req('POST', path, body, token),
    patch: (path: string, body: unknown, token?: string) => req('PATCH', path, body, token),
    del: (path: string, token?: string) => req('DELETE', path, undefined, token),
    unauth: (path: string) => app.fetch(new Request(`http://localhost${path}`, { method: 'GET' })),
  }
}
