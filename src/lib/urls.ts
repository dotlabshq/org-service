/**
 * Where the browser reaches this service's pages, and auth-service's.
 *
 * The pages are mounted under `/ui` and a gateway publishes them at `/org`
 * (workspace ADR 0003). The service does not know that; a link, a form action
 * and a redirect are addresses the browser follows, so they are built from
 * configuration and from nowhere else:
 *
 *   APP_PUBLIC_URL    the origin the browser is on           https://example.com
 *   ORG_UI_PATH       where the gateway publishes `/ui`      default `/org`
 *   ORG_AUTH_UI_URL   auth-service's pages                   default `/auth`
 *
 * With no `APP_PUBLIC_URL` the addresses are root-relative, which a browser
 * resolves against the origin it is already on. Run alone on a port, with no
 * gateway: `ORG_UI_PATH=/ui`.
 */

type Env = Record<string, string | undefined>

function prefix(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback
  const v = raw.trim().replace(/\/+$/, '')
  if (!v) return ''
  return v.startsWith('/') || /^https?:\/\//.test(v) ? v : `/${v}`
}

export interface PublicUrls {
  /** A page of this service as the browser reaches it: `ui('/choose')`. */
  ui(path?: string): string
  /** The same without the origin — what a `returnTo` may carry. */
  uiPath(path?: string): string
  /** A page of auth-service: `auth('/login?returnTo=…')`. */
  auth(path?: string): string
}

export function publicUrls(env: Env = process.env): PublicUrls {
  const origin = (env['APP_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '')
  const uiPrefix = prefix(env['ORG_UI_PATH'], '/org')
  const authUi = prefix(env['ORG_AUTH_UI_URL'], '/auth')
  return {
    ui: (path = '') => `${origin}${uiPrefix}${path}`,
    uiPath: (path = '') => `${uiPrefix}${path}`,
    auth: (path = '') => (/^https?:\/\//.test(authUi) ? `${authUi}${path}` : `${origin}${authUi}${path}`),
  }
}
