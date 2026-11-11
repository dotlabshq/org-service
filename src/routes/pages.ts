import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { brand, pagePrefs, PAGE_HEADERS, returnOrigins, safeReturnTo } from '@baseworks/core/pages'
import type { Invitation, Membership, Organization, Role } from '@baseworks/org'
import { ROLES } from '@baseworks/org/events'
import { publicUrls } from '../lib/urls.js'
import {
  acceptPage, choosePage, invitationProblemPage, invitationsPage, leaveTo, membersPage, newPage,
  problemPage, settingsPage, type PageContext,
} from '../pages/org.js'
import { strings } from '../pages/strings.js'

/** The cookie auth-service sets at sign-in: the realm's identity token, on the host the pages share. */
const TOKEN_COOKIE = 'oidc_token'

type Org = Organization & { role?: Role }
type Vars = { Variables: { page: PageContext; token: string } }
type Ctx = Context<Vars>

/** The `sub` and `email` a token carries. Read, not verified: the API verifies it on every call below. */
function claims(token: string): { sub?: string; email?: string } {
  try {
    const seg = token.split('.')[1] ?? ''
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const p = JSON.parse(json) as Record<string, unknown>
    return { sub: typeof p['sub'] === 'string' ? p['sub'] : undefined, email: typeof p['email'] === 'string' ? p['email'] : undefined }
  } catch {
    return {}
  }
}

/**
 * The organization pages, mounted under `/ui` and published at `/org`.
 *
 * **A page is a client of this service's own API.** Every read and every write
 * goes through `api` — the same router a gateway publishes at `/v1/org` — with
 * the person's own token. So the rules live in one place: who may see an
 * organization, who may change a role, that the last owner cannot be removed,
 * that an invitation is matched to the caller's email. A page adds no rule and
 * can skip none, and a product that calls the API gets the same answer a
 * person gets here.
 *
 * **The session is auth-service's.** Sign-in leaves the realm's identity token
 * in a cookie on the host (`oidc_token`), and this service verifies it like any
 * other bearer, with the realm's published keys. Without one the person is
 * sent to the sign-in page and brought back.
 *
 * **Writes are forms.** The cookie is `SameSite=Lax`, so a form posted from
 * another site arrives without it and is asked to sign in. Each write answers
 * with a redirect to the page it came from, carrying a code (`?ok=`, `?err=`)
 * the page turns into a sentence; a code is never echoed.
 */
export function pagesRouter(api: Hono, opts: { mount: string }) {
  const app = new Hono<Vars>()
  const env = () => process.env as Record<string, string | undefined>

  /** Ask the API, as the person. */
  async function call<T = Record<string, unknown>>(c: Ctx, method: string, path: string, body?: unknown): Promise<{ status: number; data: T & { error?: string } }> {
    const res = await api.fetch(new Request(`http://org.internal${path}`, {
      method,
      headers: { authorization: `Bearer ${c.get('token')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    return { status: res.status, data }
  }

  /** This request's own address as the browser knows it, for coming back after a sign-in. */
  function here(c: Ctx | Context): string {
    const url = new URL(c.req.url)
    const path = url.pathname.startsWith(opts.mount) ? url.pathname.slice(opts.mount.length) : url.pathname
    return publicUrls(env()).uiPath(`${path}${url.search}`)
  }

  const toSignIn = (c: Context, back: string) =>
    c.redirect(publicUrls(env()).auth(`/login?returnTo=${encodeURIComponent(back)}`))

  function respond(c: Context, html: string, status: 200 | 400 | 403 | 404 | 409 = 200): Response {
    for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value)
    return c.html(html, status)
  }

  // Every page: who is this, in what language, and where did they come from.
  app.use('*', async (c, next) => {
    const urls = publicUrls(env())
    const token = getCookie(c, TOKEN_COOKIE)
    // A form that arrives without the cookie goes to the page it belongs to
    // after sign-in, not back to itself: a POST cannot be replayed by a link.
    if (!token) return toSignIn(c, c.req.method === 'GET' ? here(c) : urls.uiPath('/choose'))

    const prefs = pagePrefs({
      query: (name) => c.req.query(name),
      cookie: (name) => getCookie(c, name),
      acceptLanguage: c.req.header('accept-language'),
      secure: env()['NODE_ENV'] === 'production',
    })
    for (const cookie of prefs.setCookies) c.header('Set-Cookie', cookie, { append: true })

    // `returnTo` travels in the query on a page and in a hidden field on a form.
    let raw = c.req.query('returnTo')
    if (raw === undefined && c.req.method === 'POST') {
      const form = await c.req.parseBody()
      raw = typeof form['returnTo'] === 'string' ? form['returnTo'] : undefined
    }
    const returnTo = raw ? safeReturnTo(raw, returnOrigins(env(), 'ORG_RETURN_ORIGINS')) : undefined

    const who = claims(token)
    c.set('token', token)
    c.set('page', {
      lang: prefs.lang,
      theme: prefs.theme,
      brand: brand(env(), 'ORG'),
      t: strings(prefs.lang),
      urls,
      returnTo: returnTo === '/' && raw !== '/' ? undefined : returnTo,
      who: who.email,
      userId: who.sub ?? '',
      ok: c.req.query('ok'),
      err: c.req.query('err'),
    })
    await next()
  })

  const page = (c: Ctx) => c.get('page')

  /** After a form: back to a page, saying what happened. */
  function after(c: Ctx, path: string, result: { ok?: string; err?: string }) {
    const p = page(c)
    const q = new URLSearchParams()
    if (result.ok) q.set('ok', result.ok)
    if (result.err) q.set('err', result.err)
    if (p.returnTo) q.set('returnTo', p.returnTo)
    const qs = q.toString()
    return c.redirect(p.urls.ui(`${path}${qs ? `?${qs}` : ''}`))
  }

  /** What the API said went wrong, as a code the page has a sentence for. */
  function problem(r: { status: number; data: { error?: string } }): string {
    if (r.data.error === 'slug_taken' || r.data.error === 'last_owner') return r.data.error
    if (r.status === 403) return 'forbidden'
    if (r.status === 404) return 'not_found'
    return 'unknown'
  }

  /**
   * The organization a page is about, with the person's role in it — or the
   * response to send instead. Found in the person's own list, so an
   * organization they are not in is simply not there (the API's rule: absence
   * is not disclosed).
   */
  async function orgOr(c: Ctx): Promise<Org | Response> {
    const ref = c.req.param('ref') ?? ''
    const r = await call<{ orgs: Org[] }>(c, 'GET', '/orgs')
    if (r.status === 401) return toSignIn(c, here(c))
    const org = (r.data.orgs ?? []).find((o) => o.slug === ref || o.id === ref || o.short_id === ref)
    return org ?? respond(c, problemPage(page(c), 'notFound'), 404)
  }

  const manages = (org: Org) => org.role === 'owner' || org.role === 'admin'
  const slugOf = (org: Org) => `/${encodeURIComponent(org.slug)}`
  const field = async (c: Ctx, name: string) => {
    const v = (await c.req.parseBody())[name]
    return typeof v === 'string' ? v.trim() : ''
  }

  app.get('/', (c) => after(c, '/choose', {}))

  // ── choose ────────────────────────────────────────────────────────────────
  app.get('/choose', async (c) => {
    const orgs = await call<{ orgs: Org[] }>(c, 'GET', '/orgs')
    if (orgs.status === 401) return toSignIn(c, here(c))
    // A realm that cannot say what the person's email is has no invitations to
    // show them; that is not an error on this page.
    const inv = await call<{ invitations: Invitation[] }>(c, 'GET', '/invitations')
    return respond(c, choosePage(page(c), {
      orgs: orgs.data.orgs ?? [],
      invitations: inv.status === 200 ? (inv.data.invitations ?? []) : [],
    }))
  })

  // ── new ───────────────────────────────────────────────────────────────────
  app.get('/new', (c) => respond(c, newPage(page(c))))

  app.post('/new', async (c) => {
    const p = page(c)
    const name = await field(c, 'name')
    const slug = await field(c, 'slug')
    const fail = (err: string, status: 400 | 409 = 400) => respond(c, newPage({ ...p, err }, { name, slug }), status)
    if (!name) return fail('name')
    if (slug && !/^[a-z0-9-]+$/.test(slug)) return fail('slug')

    const r = await call<{ org: Org }>(c, 'POST', '/orgs', { name, ...(slug ? { slug } : {}) })
    if (r.status === 401) return toSignIn(c, p.urls.uiPath('/new'))
    if (r.status !== 201) return fail(problem(r), r.status === 409 ? 409 : 400)
    return c.redirect(leaveTo(p, r.data.org))
  })

  // ── invitations, the invitee's side ───────────────────────────────────────
  // Registered before `/:ref/...`, so `invitations`, `new` and `choose` are not
  // addresses an organization's page can be reached at.
  app.get('/invitations/:id', async (c) => {
    const p = page(c)
    const r = await call<{ invitations: Invitation[] }>(c, 'GET', '/invitations')
    if (r.status === 401) return toSignIn(c, here(c))
    if (r.status === 409) return respond(c, invitationProblemPage(p, 'no_email', here(c)), 409)
    const inv = (r.data.invitations ?? []).find((i) => i.id === c.req.param('id'))
    // Somebody else's invitation and one that does not exist look the same:
    // an id seen in a screenshot must not confirm anything.
    if (!inv) return respond(c, invitationProblemPage(p, 'gone', here(c)), 404)
    return respond(c, acceptPage(p, inv))
  })

  app.post('/invitations/:id/accept', async (c) => {
    const p = page(c)
    const id = c.req.param('id')
    // Read before accepting: afterwards the invitation is gone, and the page
    // has to know which organization to go to.
    const mine = await call<{ invitations: Invitation[] }>(c, 'GET', '/invitations')
    const inv = (mine.data.invitations ?? []).find((i) => i.id === id)
    const r = await call(c, 'POST', `/invitations/${encodeURIComponent(id)}/accept`)
    if (r.status === 401) return toSignIn(c, p.urls.uiPath(`/invitations/${encodeURIComponent(id)}`))
    if (r.status !== 201 || !inv) return respond(c, invitationProblemPage(p, r.status === 409 ? 'no_email' : 'gone', p.urls.uiPath(`/invitations/${encodeURIComponent(id)}`)), r.status === 409 ? 409 : 404)
    return c.redirect(leaveTo(p, { id: inv.org_id, slug: inv.org_slug ?? inv.org_id }))
  })

  app.post('/invitations/:id/decline', async (c) => {
    const id = c.req.param('id')
    const r = await call(c, 'POST', `/invitations/${encodeURIComponent(id)}/decline`)
    if (r.status === 401) return toSignIn(c, page(c).urls.uiPath('/choose'))
    return after(c, '/choose', r.status === 200 ? { ok: 'declined' } : { err: problem(r) })
  })

  // ── members ───────────────────────────────────────────────────────────────
  app.get('/:ref/members', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    const r = await call<{ members: Membership[] }>(c, 'GET', `/orgs/${encodeURIComponent(org.id)}/members`)
    return respond(c, membersPage(page(c), org, r.data.members ?? []))
  })

  app.post('/:ref/members/:userId/role', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    const role = await field(c, 'role')
    if (!(ROLES as readonly string[]).includes(role)) return after(c, `${slugOf(org)}/members`, { err: 'unknown' })
    const r = await call(c, 'PATCH', `/orgs/${encodeURIComponent(org.id)}/members/${encodeURIComponent(c.req.param('userId'))}`, { role })
    return after(c, `${slugOf(org)}/members`, r.status === 200 ? { ok: 'role' } : { err: problem(r) })
  })

  app.post('/:ref/members/:userId/remove', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    const r = await call(c, 'DELETE', `/orgs/${encodeURIComponent(org.id)}/members/${encodeURIComponent(c.req.param('userId'))}`)
    return after(c, `${slugOf(org)}/members`, r.status === 200 ? { ok: 'removed' } : { err: problem(r) })
  })

  // ── invitations, the organization's side ──────────────────────────────────
  app.get('/:ref/invitations', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    if (!manages(org)) return respond(c, problemPage(page(c), 'forbidden'), 403)
    const r = await call<{ invitations: Invitation[] }>(c, 'GET', `/orgs/${encodeURIComponent(org.id)}/invitations`)
    return respond(c, invitationsPage(page(c), org, r.data.invitations ?? []))
  })

  app.post('/:ref/invitations', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    const email = await field(c, 'email')
    const role = await field(c, 'role')
    if (email.length < 3 || !email.includes('@') || !(ROLES as readonly string[]).includes(role)) {
      return after(c, `${slugOf(org)}/invitations`, { err: 'email' })
    }
    const r = await call(c, 'POST', `/orgs/${encodeURIComponent(org.id)}/invitations`, { email, role })
    return after(c, `${slugOf(org)}/invitations`, r.status === 201 ? { ok: 'invited' } : { err: problem(r) })
  })

  app.post('/:ref/invitations/:id/revoke', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    const r = await call(c, 'DELETE', `/orgs/${encodeURIComponent(org.id)}/invitations/${encodeURIComponent(c.req.param('id'))}`)
    return after(c, `${slugOf(org)}/invitations`, r.status === 200 ? { ok: 'revoked' } : { err: problem(r) })
  })

  // ── settings ──────────────────────────────────────────────────────────────
  app.get('/:ref/settings', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    if (!manages(org)) return respond(c, problemPage(page(c), 'forbidden'), 403)
    return respond(c, settingsPage(page(c), org))
  })

  app.post('/:ref/settings', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    const name = await field(c, 'name')
    if (!name) return after(c, `${slugOf(org)}/settings`, { err: 'name' })
    const r = await call(c, 'PATCH', `/orgs/${encodeURIComponent(org.id)}`, { name })
    return after(c, `${slugOf(org)}/settings`, r.status === 200 ? { ok: 'saved' } : { err: problem(r) })
  })

  app.post('/:ref/delete', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    // Typed by hand, so a stray click on a red button deletes nothing.
    if ((await field(c, 'confirm')) !== org.slug) return after(c, `${slugOf(org)}/settings`, { err: 'confirm' })
    const r = await call(c, 'DELETE', `/orgs/${encodeURIComponent(org.id)}`)
    return r.status === 200 ? after(c, '/choose', {}) : after(c, `${slugOf(org)}/settings`, { err: problem(r) })
  })

  // `/<ref>` alone is the members page.
  app.get('/:ref', async (c) => {
    const org = await orgOr(c)
    if (org instanceof Response) return org
    return after(c, `${slugOf(org)}/members`, {})
  })

  return app
}
