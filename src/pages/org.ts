import { escapeHtml as e, layout, type Brand, type Lang, type Theme } from '@baseworks/core/pages'
import type { Invitation, Membership, Organization, Role } from '@baseworks/org'
import { ROLES } from '@baseworks/org/events'
import type { PublicUrls } from '../lib/urls.js'
import { flash, type T } from './strings.js'

/**
 * The organization pages. Each function returns one whole page; all of them
 * are drawn in the realm's frame (`@baseworks/core/pages`), the one
 * auth-service's sign-in page uses, so a person sees one system.
 *
 * A page is a *client of this service's own API*: the router fetches through
 * `/api` with the person's token and hands the answers here. Nothing on these
 * pages decides who may do what — a control that is hidden is hidden for
 * tidiness, and the API refuses the request either way.
 *
 * No script. Every action is a form and a button.
 */

/** What every page needs to know about the request it is drawn for. */
export interface PageContext {
  lang: Lang
  theme: Theme
  brand: Brand
  t: T
  urls: PublicUrls
  /** Where "← Back to <product>" leads, already checked; undefined when the link gave none. */
  returnTo?: string
  /** The signed-in person, as far as the token says: an email, or nothing. */
  who?: string
  userId: string
  /** `?ok=` / `?err=` codes from the redirect after a form. */
  ok?: string
  err?: string
}

type Org = Organization & { role?: Role }

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

/** A link to one of these pages, carrying `returnTo` so the way back survives every hop. */
export function href(p: PageContext, path: string): string {
  const url = p.urls.ui(path)
  if (!p.returnTo) return url
  return `${url}${url.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(p.returnTo)}`
}

/**
 * Where a person goes once they have chosen, created or joined an
 * organization: back to the product with `org=<id>` so it can make that its
 * active organization, or, with nowhere to go back to, on to the members page.
 */
export function leaveTo(p: PageContext, org: { id: string; slug: string }): string {
  if (!p.returnTo) return p.urls.ui(`/${encodeURIComponent(org.slug)}/members`)
  const absolute = /^https?:\/\//.test(p.returnTo)
  const url = new URL(p.returnTo, 'http://relative.invalid')
  url.searchParams.set('org', org.id)
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
}

function frame(p: PageContext, opts: { title: string; body: string; wide?: boolean }): string {
  const home = p.returnTo ?? p.brand.homeUrl
  return layout({
    title: opts.title,
    body: opts.body,
    brand: p.brand,
    lang: p.lang,
    theme: p.theme,
    width: opts.wide ? 'wide' : 'narrow',
    top: {
      back: { href: home },
      who: p.who,
      signOutHref: p.urls.auth(`/logout?returnTo=${encodeURIComponent(p.brand.homeUrl)}`),
    },
  })
}

const hiddenReturn = (p: PageContext) =>
  p.returnTo ? `<input type="hidden" name="returnTo" value="${e(p.returnTo)}">` : ''

function notes(p: PageContext): string {
  const ok = flash(p.t, 'ok', p.ok)
  const err = flash(p.t, 'err', p.err)
  return `${ok ? `<p class="note" role="status">${ok}</p>` : ''}${err ? `<p class="note err" role="alert">${err}</p>` : ''}`
}

const roleName = (p: PageContext, role: Role) => p.t(`role_${role}`)
const badge = (p: PageContext, role: Role) => `<span class="badge${role === 'owner' ? ' owner' : ''}">${roleName(p, role)}</span>`
const canManage = (role: Role | undefined) => role === 'owner' || role === 'admin'

function roleSelect(p: PageContext, current: Role, cls = 'sm'): string {
  return `<select class="${cls}" name="role">${ROLES.map((r) => `<option value="${r}"${r === current ? ' selected' : ''}>${roleName(p, r)}</option>`).join('')}</select>`
}

/** The header every page inside one organization shares: who it is, your role, the tabs. */
function orgHead(p: PageContext, org: Org, tab: 'members' | 'invitations' | 'settings'): string {
  const slug = encodeURIComponent(org.slug)
  const tabs: Array<['members' | 'invitations' | 'settings', string]> = [['members', p.t('tabMembers')]]
  if (canManage(org.role)) tabs.push(['invitations', p.t('tabInvitations')], ['settings', p.t('tabSettings')])
  return `    <div class="orghead">
      <span class="av">${e(initials(org.name))}</span>
      <div><h1>${e(org.name)}</h1><span class="slug">${e(org.slug)}</span></div>
      ${org.role ? badge(p, org.role) : ''}
      <a class="switch" href="${e(href(p, '/choose'))}">${p.t('switchOrg')}</a>
    </div>
    <nav class="tabs">${tabs.map(([key, label]) => `<a${key === tab ? ' class="on"' : ''} href="${e(href(p, `/${slug}/${key}`))}">${label}</a>`).join('')}</nav>
    ${notes(p)}`
}

// ── /choose ──────────────────────────────────────────────────────────────────

export function choosePage(p: PageContext, data: { orgs: Org[]; invitations: Invitation[] }): string {
  const { t } = p
  const orgs = data.orgs.map((org) => `      <a class="row" href="${e(leaveTo(p, org))}">
        <span class="av">${e(initials(org.name))}</span>
        <span class="main"><span class="name">${e(org.name)}</span><div class="sub">${e(org.slug)}</div></span>
        ${org.role ? badge(p, org.role) : ''}
      </a>`).join('\n')

  const invitations = data.invitations.map((inv) => `      <div class="row">
        <span class="av">${e(initials(inv.org_name ?? inv.org_slug ?? '?'))}</span>
        <span class="main"><span class="name">${e(inv.org_name ?? inv.org_slug ?? '')}</span><div class="sub">${t('invitedAs', { role: roleName(p, inv.role) })}</div></span>
        <span class="actions">
          <form method="POST" action="${e(p.urls.ui(`/invitations/${encodeURIComponent(inv.id)}/decline`))}">${hiddenReturn(p)}<button class="btn sm" type="submit">${t('decline')}</button></form>
          <form method="POST" action="${e(p.urls.ui(`/invitations/${encodeURIComponent(inv.id)}/accept`))}">${hiddenReturn(p)}<button class="btn sm primary" type="submit">${t('accept')}</button></form>
        </span>
      </div>`).join('\n')

  return frame(p, {
    title: t('chooseTitle'),
    body: `    <div class="stack" style="margin-bottom:18px">
      <h1>${t('chooseTitle')}</h1>
      ${p.who ? `<p>${t('signedInAs', { who: p.who })}</p>` : ''}
    </div>
    ${notes(p)}
    <div class="card">
${orgs || `      <div class="empty">${t('noOrgs')}</div>`}
    </div>
    ${invitations ? `<div class="card">
      <header><h2>${t('invitations')}</h2><span class="hint">${t('waiting', { n: data.invitations.length })}</span></header>
${invitations}
    </div>` : ''}
    <a class="btn wide" href="${e(href(p, '/new'))}">${t('createNew')}</a>`,
  })
}

// ── /new ─────────────────────────────────────────────────────────────────────

export function newPage(p: PageContext, form: { name?: string; slug?: string } = {}): string {
  const { t } = p
  return frame(p, {
    title: t('newTitle'),
    body: `    <div class="card"><div class="body">
      <h1>${t('newTitle')}</h1>
      <p>${t('newHint')}</p>
      ${notes(p)}
      <form class="stack" method="POST" action="${e(p.urls.ui('/new'))}">
        ${hiddenReturn(p)}
        <label>${t('name')} <input type="text" name="name" value="${e(form.name ?? '')}" required autofocus></label>
        <label>${t('address')} <span>${t('addressHint')}</span>
          <input type="text" name="slug" value="${e(form.slug ?? '')}" pattern="[a-z0-9-]*" autocapitalize="none" spellcheck="false"></label>
        <button class="btn primary wide" type="submit">${t('create')}</button>
      </form>
      <p class="quiet center"><a href="${e(href(p, '/choose'))}">${t('chooseExisting')}</a></p>
    </div></div>`,
  })
}

// ── /<ref>/members ───────────────────────────────────────────────────────────

export function membersPage(p: PageContext, org: Org, members: Membership[]): string {
  const { t } = p
  const manage = canManage(org.role)
  const base = `/${encodeURIComponent(org.slug)}/members`
  const rows = members.map((m) => {
    const self = m.user_id === p.userId
    const label = m.name || m.email || m.user_id
    const controls = manage && !self
      ? `<span class="actions">
          <form method="POST" action="${e(p.urls.ui(`${base}/${encodeURIComponent(m.user_id)}/role`))}">${hiddenReturn(p)}${roleSelect(p, m.role)}<button class="btn sm" type="submit">${t('changeRole')}</button></form>
          <form method="POST" action="${e(p.urls.ui(`${base}/${encodeURIComponent(m.user_id)}/remove`))}">${hiddenReturn(p)}<button class="btn sm danger" type="submit">${t('remove')}</button></form>
        </span>`
      : badge(p, m.role)
    return `      <div class="row">
        <span class="av">${e(initials(label))}</span>
        <span class="main"><span class="name">${e(label)}${self ? ` <span class="quiet">${t('you')}</span>` : ''}</span>${m.email && m.email !== label ? `<div class="sub">${e(m.email)}</div>` : ''}</span>
        ${controls}
      </div>`
  }).join('\n')

  return frame(p, {
    title: `${t('tabMembers')} · ${org.name}`,
    wide: true,
    body: `${orgHead(p, org, 'members')}
    <div class="card">
      <header><h2>${t('tabMembers')}</h2><span class="hint">${t('people', { n: members.length })}</span>${manage ? ` <a class="btn sm primary" href="${e(href(p, `/${encodeURIComponent(org.slug)}/invitations`))}">${t('invite')}</a>` : ''}</header>
${rows}
    </div>
    ${manage ? `<p class="quiet">${t('lastOwnerNote')}</p>` : ''}`,
  })
}

// ── /<ref>/invitations ───────────────────────────────────────────────────────

export function invitationsPage(p: PageContext, org: Org, invitations: Invitation[], form: { email?: string } = {}): string {
  const { t } = p
  const base = `/${encodeURIComponent(org.slug)}/invitations`
  const rows = invitations.map((inv) => {
    const by = inv.invited_by_name || inv.invited_by_email
    const sub = by ? t('invitedBy', { role: roleName(p, inv.role), who: by }) : t('invitedAsPlain', { role: roleName(p, inv.role) })
    return `      <div class="row">
        <span class="av">@</span>
        <span class="main"><span class="name">${e(inv.email)}</span><div class="sub">${sub}</div></span>
        <span class="actions"><form method="POST" action="${e(p.urls.ui(`${base}/${encodeURIComponent(inv.id)}/revoke`))}">${hiddenReturn(p)}<button class="btn sm danger" type="submit">${t('revoke')}</button></form></span>
      </div>`
  }).join('\n')

  return frame(p, {
    title: `${t('tabInvitations')} · ${org.name}`,
    wide: true,
    body: `${orgHead(p, org, 'invitations')}
    <div class="card">
      <header><h2>${t('inviteTitle')}</h2></header>
      <div class="body">
        <form class="inline" method="POST" action="${e(p.urls.ui(base))}">
          ${hiddenReturn(p)}
          <label class="grow">${t('email')} <input type="email" name="email" value="${e(form.email ?? '')}" placeholder="name@example.com" required></label>
          <label class="fit">${t('role')} ${roleSelect(p, 'member', '')}</label>
          <button class="btn primary" type="submit">${t('send')}</button>
        </form>
        <p class="quiet">${t('inviteHint')}</p>
      </div>
    </div>
    <div class="card">
      <header><h2>${t('pending')}</h2>${invitations.length ? `<span class="hint">${t('notAccepted', { n: invitations.length })}</span>` : ''}</header>
${rows || `      <div class="empty">${t('nonePending')}</div>`}
    </div>`,
  })
}

// ── /invitations/<id> ────────────────────────────────────────────────────────

export function acceptPage(p: PageContext, inv: Invitation): string {
  const { t } = p
  const org = inv.org_name ?? inv.org_slug ?? ''
  const by = inv.invited_by_name || inv.invited_by_email
  const role = roleName(p, inv.role)
  const id = encodeURIComponent(inv.id)
  return frame(p, {
    title: t('joinTitle', { org }),
    body: `    <div class="card"><div class="body center">
      <span class="av lg">${e(initials(org))}</span>
      <h1>${t('joinTitle', { org })}</h1>
      <p>${by ? t('joinTextBy', { who: by, org, role }) : t('joinText', { org, role })}</p>
      <form class="stack" style="width:100%" method="POST" action="${e(p.urls.ui(`/invitations/${id}/accept`))}">${hiddenReturn(p)}<button class="btn primary wide" type="submit">${t('acceptInvitation')}</button></form>
      <form class="stack" style="width:100%" method="POST" action="${e(p.urls.ui(`/invitations/${id}/decline`))}">${hiddenReturn(p)}<button class="btn wide" type="submit">${t('decline')}</button></form>
      <p class="quiet">${t('joinHint')}</p>
    </div></div>`,
  })
}

/** An invitation this account cannot act on: said plainly, with the way out. */
export function invitationProblemPage(p: PageContext, problem: 'gone' | 'no_email', here: string): string {
  const { t } = p
  return frame(p, {
    title: t('invitations'),
    body: `    <div class="card"><div class="body">
      <h1>${t('invitations')}</h1>
      <p class="note err" role="alert">${t(problem === 'gone' ? 'inviteGone' : 'inviteNoEmail')}</p>
      ${p.who ? `<p>${t('signedInAs', { who: p.who })}</p>` : ''}
      <a class="btn wide" href="${e(p.urls.auth(`/logout?returnTo=${encodeURIComponent(here)}`))}">${t('otherAccount')}</a>
    </div></div>`,
  })
}

// ── /<ref>/settings ──────────────────────────────────────────────────────────

export function settingsPage(p: PageContext, org: Org): string {
  const { t } = p
  const base = `/${encodeURIComponent(org.slug)}`
  return frame(p, {
    title: `${t('tabSettings')} · ${org.name}`,
    wide: true,
    body: `${orgHead(p, org, 'settings')}
    <div class="card">
      <header><h2>${t('general')}</h2></header>
      <div class="body">
        <form class="stack" method="POST" action="${e(p.urls.ui(`${base}/settings`))}">
          ${hiddenReturn(p)}
          <label>${t('name')} <input type="text" name="name" value="${e(org.name)}" required></label>
          <label>${t('address')} <span>${t('addressFixed')}</span><input type="text" value="${e(org.slug)}" readonly></label>
          <label>${t('orgId')} <span>${t('orgIdHint')}</span><input type="text" value="${e(org.id)}" readonly></label>
          <div><button class="btn primary" type="submit">${t('save')}</button></div>
        </form>
      </div>
    </div>
    ${org.role === 'owner' ? `<div class="card danger-zone">
      <header><h2>${t('deleteTitle')}</h2></header>
      <div class="body">
        <p>${t('deleteHint')}</p>
        <form class="stack" method="POST" action="${e(p.urls.ui(`${base}/delete`))}">
          ${hiddenReturn(p)}
          <label>${t('deleteConfirm', { slug: org.slug })} <input type="text" name="confirm" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
          <div><button class="btn danger" type="submit">${t('deleteButton')}</button></div>
        </form>
      </div>
    </div>` : ''}`,
  })
}

// ── problems ─────────────────────────────────────────────────────────────────

export function problemPage(p: PageContext, problem: 'notFound' | 'forbidden'): string {
  const { t } = p
  return frame(p, {
    title: t(`${problem}Title`),
    body: `    <div class="card"><div class="body">
      <h1>${t(`${problem}Title`)}</h1>
      <p>${t(problem)}</p>
      <a class="btn wide" href="${e(href(p, '/choose'))}">${t('chooseTitle')}</a>
    </div></div>`,
  })
}
