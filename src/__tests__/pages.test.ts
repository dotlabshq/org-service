/**
 * The organization pages (`/ui`, published at `/org`).
 *
 * The rule under test: a page is a client of this service's own API, carrying
 * the person's token from auth-service's cookie. So what a page lets someone
 * do is exactly what the API lets them do, and these tests check the pages
 * the way a browser would use them — a cookie, a link, a form.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestFoldBase, makeTestApp, makeToken, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>

let fb: TestFoldBase
let app: App
let orgId: string

const OWNER = makeToken('user-owner', 'owner@example.test')
const MEMBER = makeToken('user-member', 'member@example.test')
const OUTSIDER = makeToken('user-outsider', 'outsider@example.test')
const INVITEE = makeToken('user-invitee', 'invitee@example.test')

const saved = { ...process.env }
beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })

beforeEach(async () => {
  process.env = { ...saved }
  app = await makeTestApp(fb)
  const created = await (await app.post('/api/orgs', { name: 'Acme', slug: 'acme' }, OWNER)).json() as { org: { id: string } }
  orgId = created.org.id
  await app.post('/api/orgs/acme/members', { user_id: 'user-member', role: 'member' }, OWNER)
})

/** A browser: the session is the cookie auth-service set, nothing else. */
function browser(token?: string, extraCookies = '') {
  const cookie = [token ? `oidc_token=${token}` : '', extraCookies].filter(Boolean).join('; ')
  const send = (method: string, path: string, form?: Record<string, string>, headers: Record<string, string> = {}) =>
    app.app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    }))
  return {
    get: (path: string, headers?: Record<string, string>) => send('GET', path, undefined, headers),
    post: (path: string, form: Record<string, string> = {}) => send('POST', path, form),
  }
}
const location = (res: Response) => res.headers.get('location') ?? ''
const members = async () =>
  ((await (await app.get('/api/orgs/acme/members', OWNER)).json()) as { members: Array<{ user_id: string; role: string }> }).members

describe('the session is auth-service\'s', () => {
  it('sends someone who is not signed in to the sign-in page, and back to where they were going', async () => {
    const res = await browser().get('/ui/acme/members?returnTo=%2Fdesk')
    expect(res.status).toBe(302)
    expect(location(res)).toBe(`/auth/login?returnTo=${encodeURIComponent('/org/acme/members?returnTo=%2Fdesk')}`)
  })

  it('does not act on a form that arrives without the cookie', async () => {
    const res = await browser().post('/ui/acme/members/user-member/remove')
    expect(res.status).toBe(302)
    expect(location(res)).toContain('/auth/login')
    expect((await members()).some((m) => m.user_id === 'user-member')).toBe(true)
  })

  it('a token the API does not accept is not a session either', async () => {
    const res = await browser('not.a.token').get('/ui/choose')
    expect(res.status).toBe(302)
    expect(location(res)).toContain('/auth/login')
  })
})

describe('choosing an organization', () => {
  it('lists the person\'s own organizations and nobody else\'s', async () => {
    const html = await (await browser(MEMBER).get('/ui/choose')).text()
    expect(html).toContain('Acme')
    expect(html).toContain('member@example.test')
    expect(await (await browser(OUTSIDER).get('/ui/choose')).text()).not.toContain('Acme')
  })

  it('goes back to the product with the organization\'s id, when the product asked', async () => {
    const html = await (await browser(MEMBER).get('/ui/choose?returnTo=%2Fdesk%3Ftab%3Ddeals')).text()
    expect(html).toContain(`href="/desk?tab=deals&amp;org=${orgId}"`)
    expect(html).toContain('href="/desk?tab=deals"')        // ← Back
  })

  it('goes on to the members page when there is nowhere to go back to', async () => {
    const html = await (await browser(MEMBER).get('/ui/choose')).text()
    expect(html).toContain('href="/org/acme/members"')
  })

  it('refuses a return address the realm does not publish', async () => {
    const html = await (await browser(MEMBER).get(`/ui/choose?returnTo=${encodeURIComponent('https://evil.example/x')}`)).text()
    expect(html).not.toContain('evil.example')
  })
})

describe('creating an organization', () => {
  it('makes the person its owner and returns to the product with its id', async () => {
    const res = await browser(OUTSIDER).post('/ui/new', { name: 'Globex', slug: 'globex', returnTo: '/desk' })
    expect(res.status).toBe(302)
    const { orgs } = await (await app.get('/api/orgs', OUTSIDER)).json() as { orgs: Array<{ id: string; slug: string; role: string }> }
    expect(orgs).toHaveLength(1)
    expect(orgs[0]).toMatchObject({ slug: 'globex', role: 'owner' })
    expect(location(res)).toBe(`/desk?org=${orgs[0]!.id}`)
  })

  it('says so when the address is taken, and keeps what was typed', async () => {
    const res = await browser(OUTSIDER).post('/ui/new', { name: 'Acme Two', slug: 'acme' })
    expect(res.status).toBe(409)
    const html = await res.text()
    expect(html).toContain('That address is taken')
    expect(html).toContain('value="Acme Two"')
  })

  it('refuses an address that is not one, before asking the API', async () => {
    const res = await browser(OUTSIDER).post('/ui/new', { name: 'X', slug: 'Not A Slug' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('lowercase letters')
  })
})

describe('members', () => {
  it('shows a member the list, without the controls', async () => {
    const html = await (await browser(MEMBER).get('/ui/acme/members')).text()
    // No iam in this realm, so a member is known by id; with iam the row
    // carries a name and an email.
    expect(html).toContain('user-owner')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('>Invitations<')
  })

  it('gives an owner the controls, but not over themselves', async () => {
    const html = await (await browser(OWNER).get('/ui/acme/members')).text()
    expect(html).toContain('action="/org/acme/members/user-member/role"')
    expect(html).not.toContain('action="/org/acme/members/user-owner/role"')
    expect(html).toContain('>Invitations<')
  })

  it('changes a role through the API and says so', async () => {
    const res = await browser(OWNER).post('/ui/acme/members/user-member/role', { role: 'admin' })
    expect(location(res)).toBe('/org/acme/members?ok=role')
    expect((await members()).find((m) => m.user_id === 'user-member')?.role).toBe('admin')
    expect(await (await browser(OWNER).get('/ui/acme/members?ok=role')).text()).toContain('The role was changed.')
  })

  it('a member posting the form by hand is refused by the API, not by the page', async () => {
    const res = await browser(MEMBER).post('/ui/acme/members/user-owner/role', { role: 'member' })
    expect(location(res)).toBe('/org/acme/members?err=forbidden')
    expect((await members()).find((m) => m.user_id === 'user-owner')?.role).toBe('owner')
  })

  it('does not say whether an organization exists to someone who is not in it', async () => {
    const res = await browser(OUTSIDER).get('/ui/acme/members')
    expect(res.status).toBe(404)
    const missing = await browser(OUTSIDER).get('/ui/no-such-org/members')
    expect(missing.status).toBe(404)
    expect(await res.text()).toBe(await missing.text())
  })

  it('never echoes a code from the address bar', async () => {
    const html = await (await browser(OWNER).get(`/ui/acme/members?err=${encodeURIComponent('<script>alert(1)</script>')}&ok=nonsense`)).text()
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('That did not work')
  })
})

describe('invitations', () => {
  it('are an owner\'s or an admin\'s page', async () => {
    expect((await browser(MEMBER).get('/ui/acme/invitations')).status).toBe(403)
    expect((await browser(OWNER).get('/ui/acme/invitations')).status).toBe(200)
  })

  it('invite, see it pending, withdraw it', async () => {
    const sent = await browser(OWNER).post('/ui/acme/invitations', { email: 'invitee@example.test', role: 'admin' })
    expect(location(sent)).toBe('/org/acme/invitations?ok=invited')

    const html = await (await browser(OWNER).get('/ui/acme/invitations')).text()
    expect(html).toContain('invitee@example.test')
    const id = /invitations\/([^/"]+)\/revoke/.exec(html)![1]!

    const revoked = await browser(OWNER).post(`/ui/acme/invitations/${id}/revoke`)
    expect(location(revoked)).toBe('/org/acme/invitations?ok=revoked')
    expect(await (await browser(OWNER).get('/ui/acme/invitations')).text()).toContain('No invitations are waiting.')
  })

  it('the invitee accepts on a page of their own and lands in the organization', async () => {
    await browser(OWNER).post('/ui/acme/invitations', { email: 'invitee@example.test', role: 'admin' })
    const choose = await (await browser(INVITEE).get('/ui/choose')).text()
    const id = /invitations\/([^/"]+)\/accept/.exec(choose)![1]!

    const page = await browser(INVITEE).get(`/ui/invitations/${id}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Join Acme')

    const accepted = await browser(INVITEE).post(`/ui/invitations/${id}/accept`, { returnTo: '/desk' })
    expect(location(accepted)).toBe(`/desk?org=${orgId}`)
    expect((await members()).find((m) => m.user_id === 'user-invitee')?.role).toBe('admin')
  })

  it('an invitation id is not enough: it has to have been sent to you', async () => {
    await browser(OWNER).post('/ui/acme/invitations', { email: 'invitee@example.test', role: 'admin' })
    const id = /invitations\/([^/"]+)\/revoke/.exec(await (await browser(OWNER).get('/ui/acme/invitations')).text())![1]!

    const page = await browser(OUTSIDER).get(`/ui/invitations/${id}`)
    expect(page.status).toBe(404)
    expect(await page.text()).toBe(await (await browser(OUTSIDER).get('/ui/invitations/no-such-id')).text().then((t) => t.replace('no-such-id', id)))

    await browser(OUTSIDER).post(`/ui/invitations/${id}/accept`)
    expect((await members()).some((m) => m.user_id === 'user-outsider')).toBe(false)
  })
})

describe('settings', () => {
  it('renames the organization', async () => {
    const res = await browser(OWNER).post('/ui/acme/settings', { name: 'Acme Corp' })
    expect(location(res)).toBe('/org/acme/settings?ok=saved')
    expect(await (await browser(OWNER).get('/ui/acme/settings')).text()).toContain('value="Acme Corp"')
  })

  it('deletes only when the address is typed, and only for an owner', async () => {
    const wrong = await browser(OWNER).post('/ui/acme/delete', { confirm: 'acmee' })
    expect(location(wrong)).toBe('/org/acme/settings?err=confirm')
    expect((await app.get('/api/orgs/acme', OWNER)).status).toBe(200)

    await app.post('/api/orgs/acme/members', { user_id: 'user-admin', role: 'admin' }, OWNER)
    const admin = makeToken('user-admin', 'admin@example.test')
    expect(await (await browser(admin).get('/ui/acme/settings')).text()).not.toContain('Delete organization')
    expect(location(await browser(admin).post('/ui/acme/delete', { confirm: 'acme' }))).toBe('/org/acme/settings?err=forbidden')

    const done = await browser(OWNER).post('/ui/acme/delete', { confirm: 'acme' })
    expect(location(done)).toBe('/org/choose')
    expect(await (await browser(OWNER).get('/ui/choose')).text()).not.toContain('Acme')
  })
})

describe('one system with the sign-in page', () => {
  it('is in Turkish when the product is, and remembers it', async () => {
    const res = await browser(OWNER).get('/ui/acme/members?lang=tr')
    const html = await res.text()
    expect(html).toContain('<html lang="tr"')
    expect(html).toContain('Üyeler')
    expect(res.headers.getSetCookie().some((c) => c.startsWith('bw_lang=tr;'))).toBe(true)
    expect(await (await browser(OWNER, 'bw_lang=tr').get('/ui/choose')).text()).toContain('Bir organizasyon seçin')
  })

  it('leads back to the product by name, and signs out through auth-service', async () => {
    process.env['REALM_UI_NAME'] = 'quillpath'
    const html = await (await browser(OWNER).get('/ui/acme/members?returnTo=%2Fdesk')).text()
    expect(html).toContain('<a class="back" href="/desk">← Back to quillpath</a>')
    expect(html).toContain('href="/auth/logout?returnTo=%2F"')
    // The way back survives a click on a tab.
    expect(html).toContain('href="/org/acme/settings?returnTo=%2Fdesk"')
  })

  it('escapes what people typed, cannot be framed, runs no script', async () => {
    await app.post('/api/orgs', { name: '<script>alert(1)</script>', slug: 'xss' }, OWNER)
    const res = await browser(OWNER).get('/ui/choose')
    const html = await res.text()
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('is not part of the API, and the API is not part of it', async () => {
    expect((await app.get('/api/choose', OWNER)).status).toBe(404)
    // Under /ui, `orgs` is not the API's list: it is the organization called
    // "orgs", which this person is not in.
    const res = await browser(OWNER).get('/ui/orgs')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})
