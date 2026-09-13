import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootTestFoldBase, makeTestApp, makeToken, USER_ID, type TestFoldBase } from './setup.js'
import { resetCallerEmailCache } from '../lib/caller-email.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App

const json = <T>(res: Response) => res.json() as Promise<T>

const INVITER_EMAIL = 'owner@acme.test'
const INVITEE = 'ada@example.com'
const invitee = (id = 'usr_ada') => makeToken(id, INVITEE)

type Invitation = { id: string; email: string; role: string; org_id: string; org_slug?: string }

beforeAll(async () => {
  fb = await bootTestFoldBase()
}, 30_000)
afterAll(async () => {
  await fb.stop()
})
beforeEach(async () => {
  app = await makeTestApp(fb)
  resetCallerEmailCache()
})

async function acme() {
  await json(await app.post('/orgs', { name: 'Acme', slug: 'acme' }, makeToken(USER_ID, INVITER_EMAIL)))
}

async function invite(email = INVITEE, role = 'member') {
  const res = await app.post('/orgs/acme/invitations', { email, role }, makeToken(USER_ID, INVITER_EMAIL))
  return { res, body: await json<{ invitation: Invitation }>(res.clone()) }
}

describe('creating and listing invitations', () => {
  it('an owner invites an email and sees it pending', async () => {
    await acme()
    const { res, body } = await invite()
    expect(res.status).toBe(201)
    expect(body.invitation).toMatchObject({ email: INVITEE, role: 'member' })

    const { invitations } = await json<{ invitations: Invitation[] }>(
      await app.get('/orgs/acme/invitations', makeToken(USER_ID, INVITER_EMAIL)),
    )
    expect(invitations.map((i) => i.email)).toEqual([INVITEE])
  })

  it('normalises the email, so one person is not invited twice', async () => {
    await acme()
    await invite('  Ada@Example.COM  ')
    const { invitations } = await json<{ invitations: Invitation[] }>(
      await app.get('/orgs/acme/invitations', makeToken(USER_ID, INVITER_EMAIL)),
    )
    expect(invitations).toHaveLength(1)
    expect(invitations[0]!.email).toBe(INVITEE)
  })

  it('is idempotent: inviting the same email again leaves one pending row', async () => {
    await acme()
    const first = await invite()
    const second = await invite()
    expect(second.body.invitation.id).toBe(first.body.invitation.id)

    const { invitations } = await json<{ invitations: Invitation[] }>(
      await app.get('/orgs/acme/invitations', makeToken(USER_ID, INVITER_EMAIL)),
    )
    expect(invitations).toHaveLength(1)
  })

  it('re-issues when the role changes, still leaving one pending row', async () => {
    await acme()
    await invite(INVITEE, 'member')
    await invite(INVITEE, 'admin')

    const { invitations } = await json<{ invitations: Invitation[] }>(
      await app.get('/orgs/acme/invitations', makeToken(USER_ID, INVITER_EMAIL)),
    )
    expect(invitations).toHaveLength(1)
    expect(invitations[0]!.role).toBe('admin')
  })

  it('refuses a member who is not an owner or admin', async () => {
    await acme()
    const outsider = makeToken('usr_outsider', 'out@x.test')
    expect((await app.post('/orgs/acme/invitations', { email: INVITEE, role: 'member' }, outsider)).status).toBe(403)
    expect((await app.get('/orgs/acme/invitations', outsider)).status).toBe(403)
  })

  it('rejects something that is not an email', async () => {
    await acme()
    expect((await app.post('/orgs/acme/invitations', { email: 'nope', role: 'member' }, makeToken(USER_ID, INVITER_EMAIL))).status).toBe(400)
  })
})

describe('the invitee side', () => {
  it('sees the invitation with the org it is for', async () => {
    await acme()
    await invite()

    const { invitations } = await json<{ invitations: Invitation[] }>(await app.get('/invitations', invitee()))
    expect(invitations).toHaveLength(1)
    // Enriched so a console can say which org without a second lookup.
    expect(invitations[0]).toMatchObject({ email: INVITEE, org_slug: 'acme' })
  })

  it('accepts it and becomes a member, and the invitation stops being pending', async () => {
    await acme()
    await invite()

    const res = await app.post('/invitations/' + (await pendingId()) + '/accept', {}, invitee())
    expect(res.status).toBe(201)
    expect((await json<{ member: { user_id: string; role: string } }>(res)).member)
      .toMatchObject({ user_id: 'usr_ada', role: 'member' })

    const { members } = await json<{ members: Array<{ user_id: string }> }>(
      await app.get('/orgs/acme/members', makeToken(USER_ID, INVITER_EMAIL)),
    )
    expect(members.map((m) => m.user_id)).toContain('usr_ada')

    const { invitations } = await json<{ invitations: Invitation[] }>(await app.get('/invitations', invitee()))
    expect(invitations).toHaveLength(0)
  })

  it('cannot accept an invitation addressed to someone else', async () => {
    await acme()
    await invite()
    const id = await pendingId()

    // A different signed-in user who knows the id — from a log, a screenshot,
    // a forwarded email. 404 and not 403: 403 would confirm the id is real.
    const res = await app.post(`/invitations/${id}/accept`, {}, makeToken('usr_mallory', 'mallory@evil.test'))
    expect(res.status).toBe(404)

    const { members } = await json<{ members: Array<{ user_id: string }> }>(
      await app.get('/orgs/acme/members', makeToken(USER_ID, INVITER_EMAIL)),
    )
    expect(members.map((m) => m.user_id)).not.toContain('usr_mallory')
  })

  it('cannot accept a revoked invitation', async () => {
    await acme()
    await invite()
    const id = await pendingId()

    expect((await app.del(`/orgs/acme/invitations/${id}`, makeToken(USER_ID, INVITER_EMAIL))).status).toBe(200)
    expect((await app.post(`/invitations/${id}/accept`, {}, invitee())).status).toBe(404)
  })

  it('says why rather than showing an empty list when the email cannot be determined', async () => {
    await acme()
    await invite()

    // A token with no email claim, and no iam-service configured.
    const res = await app.get('/invitations', makeToken('usr_ada'))
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('email_unavailable')
  })
})

describe('revoking', () => {
  it('cannot be done across organisations with just an id', async () => {
    await acme()
    await invite()
    const id = await pendingId()

    // A second org whose admin knows the id.
    const other = makeToken('usr_other', 'other@b.test')
    await json(await app.post('/orgs', { name: 'Beta', slug: 'beta' }, other))

    expect((await app.del(`/orgs/beta/invitations/${id}`, other)).status).toBe(404)
    const { invitations } = await json<{ invitations: Invitation[] }>(
      await app.get('/orgs/acme/invitations', makeToken(USER_ID, INVITER_EMAIL)),
    )
    expect(invitations).toHaveLength(1)
  })
})

async function pendingId(): Promise<string> {
  const { invitations } = await json<{ invitations: Invitation[] }>(
    await app.get('/orgs/acme/invitations', makeToken(USER_ID, INVITER_EMAIL)),
  )
  return invitations[0]!.id
}
