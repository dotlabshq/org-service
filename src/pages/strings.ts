import { translator, type Dictionary, type Lang } from '@baseworks/core/pages'

/**
 * Every sentence the organization pages show, in each language the frame
 * knows. A `{name}` is filled in escaped; the strings are trusted markup.
 */
const STRINGS = {
  en: {
    // roles
    role_owner: 'Owner', role_admin: 'Admin', role_member: 'Member', role_viewer: 'Viewer',
    // tabs and shared
    tabMembers: 'Members', tabInvitations: 'Invitations', tabSettings: 'Settings',
    switchOrg: 'Switch organization', you: '(you)', save: 'Save',
    // choose
    chooseTitle: 'Choose an organization',
    signedInAs: 'You are signed in as {who}.',
    noOrgs: 'You are not in any organization yet.',
    invitations: 'Invitations', waiting: '{n} waiting',
    invitedAs: 'invited you as {role}',
    accept: 'Accept', decline: 'Decline',
    createNew: 'Create a new organization',
    // new
    newTitle: 'Create an organization',
    newHint: 'You will be its owner. You can invite people next.',
    name: 'Name',
    address: 'Address',
    addressHint: 'Used in links. Lowercase letters, digits and dashes. It cannot be changed later. Leave empty to have one made from the name.',
    create: 'Create organization',
    chooseExisting: 'Choose an existing organization',
    // members
    people: '{n} people', invite: 'Invite',
    changeRole: 'Change role', remove: 'Remove',
    lastOwnerNote: 'An organization always has at least one owner: the last owner cannot be removed or changed to another role.',
    // invitations
    inviteTitle: 'Invite a member', email: 'Email', role: 'Role', send: 'Send invitation',
    inviteHint: 'They accept after signing in with this address. Inviting the same address again replaces the earlier invitation.',
    pending: 'Pending', notAccepted: '{n} not yet accepted',
    invitedBy: 'invited as {role} by {who}', invitedAsPlain: 'invited as {role}',
    revoke: 'Revoke', nonePending: 'No invitations are waiting.',
    // accept
    joinTitle: 'Join {org}',
    joinText: 'You were invited to <strong>{org}</strong> as <strong>{role}</strong>.',
    joinTextBy: '{who} invited you to <strong>{org}</strong> as <strong>{role}</strong>.',
    acceptInvitation: 'Accept invitation',
    joinHint: 'Accepting adds you to the organization.',
    inviteGone: 'This invitation is not valid for the account you are signed in with. It may have been sent to another address, withdrawn, or already used.',
    inviteNoEmail: 'Your account has no email address this realm can read, so an invitation cannot be matched to you.',
    otherAccount: 'Sign in with a different account',
    // settings
    general: 'General',
    addressFixed: 'Links and hostnames are built from it, so it is fixed once the organization exists.',
    orgId: 'Organization ID', orgIdHint: 'For support and for API calls.',
    deleteTitle: 'Delete this organization',
    deleteHint: 'Everyone loses access at once. This cannot be undone. Owners only.',
    deleteConfirm: 'Type the address <strong>{slug}</strong> to confirm',
    deleteButton: 'Delete organization',
    // problems
    notFoundTitle: 'Organization not found',
    notFound: 'There is no such organization, or you are not a member of it.',
    forbiddenTitle: 'Not available to you',
    forbidden: 'Only an owner or an admin of this organization can open this page.',
    // flash
    ok_role: 'The role was changed.', ok_removed: 'The member was removed.',
    ok_invited: 'The invitation was sent.', ok_revoked: 'The invitation was withdrawn.',
    ok_saved: 'Saved.', ok_declined: 'The invitation was declined.',
    err_slug_taken: 'That address is taken. Try another.',
    err_slug: 'An address is lowercase letters, digits and dashes.',
    err_name: 'Enter a name.',
    err_email: 'Enter an email address.',
    err_last_owner: 'An organization needs at least one owner.',
    err_forbidden: 'You are not allowed to do that in this organization.',
    err_not_found: 'That no longer exists.',
    err_confirm: 'The address you typed does not match.',
    err_unknown: 'That did not work. Please try again.',
  },
  tr: {
    role_owner: 'Sahip', role_admin: 'Yönetici', role_member: 'Üye', role_viewer: 'İzleyici',
    tabMembers: 'Üyeler', tabInvitations: 'Davetler', tabSettings: 'Ayarlar',
    switchOrg: 'Organizasyon değiştir', you: '(siz)', save: 'Kaydet',
    chooseTitle: 'Bir organizasyon seçin',
    signedInAs: '{who} olarak giriş yaptınız.',
    noOrgs: 'Henüz bir organizasyonda değilsiniz.',
    invitations: 'Davetler', waiting: '{n} bekliyor',
    invitedAs: 'sizi {role} olarak davet etti',
    accept: 'Kabul et', decline: 'Reddet',
    createNew: 'Yeni organizasyon oluştur',
    newTitle: 'Organizasyon oluştur',
    newHint: 'Sahibi siz olacaksınız. Ardından başkalarını davet edebilirsiniz.',
    name: 'Ad',
    address: 'Adres',
    addressHint: 'Bağlantılarda kullanılır. Küçük harf, rakam ve tire. Sonradan değiştirilemez. Boş bırakırsanız addan üretilir.',
    create: 'Organizasyonu oluştur',
    chooseExisting: 'Var olan bir organizasyonu seç',
    people: '{n} kişi', invite: 'Davet et',
    changeRole: 'Rolü değiştir', remove: 'Çıkar',
    lastOwnerNote: 'Bir organizasyonun her zaman en az bir sahibi olur: son sahip çıkarılamaz ve rolü değiştirilemez.',
    inviteTitle: 'Üye davet et', email: 'E-posta', role: 'Rol', send: 'Davet gönder',
    inviteHint: 'Davetli bu adresle giriş yaptıktan sonra kabul eder. Aynı adresi yeniden davet etmek önceki davetin yerine geçer.',
    pending: 'Bekleyenler', notAccepted: '{n} davet henüz kabul edilmedi',
    invitedBy: '{who} tarafından {role} olarak davet edildi', invitedAsPlain: '{role} olarak davet edildi',
    revoke: 'Geri çek', nonePending: 'Bekleyen davet yok.',
    joinTitle: '{org} organizasyonuna katıl',
    joinText: '<strong>{org}</strong> organizasyonuna <strong>{role}</strong> olarak davet edildiniz.',
    joinTextBy: '{who} sizi <strong>{org}</strong> organizasyonuna <strong>{role}</strong> olarak davet etti.',
    acceptInvitation: 'Daveti kabul et',
    joinHint: 'Kabul ettiğinizde organizasyona eklenirsiniz.',
    inviteGone: 'Bu davet, giriş yaptığınız hesap için geçerli değil. Başka bir adrese gönderilmiş, geri çekilmiş ya da kullanılmış olabilir.',
    inviteNoEmail: 'Hesabınızın bu ortamın okuyabildiği bir e-posta adresi yok; bu yüzden davet sizinle eşleştirilemiyor.',
    otherAccount: 'Başka bir hesapla giriş yap',
    general: 'Genel',
    addressFixed: 'Bağlantılar ve alan adları bundan üretilir; organizasyon oluşturulduktan sonra sabittir.',
    orgId: 'Organizasyon kimliği', orgIdHint: 'Destek ve API çağrıları için.',
    deleteTitle: 'Bu organizasyonu sil',
    deleteHint: 'Herkes erişimini anında kaybeder. Geri alınamaz. Yalnızca sahipler yapabilir.',
    deleteConfirm: 'Onaylamak için <strong>{slug}</strong> adresini yazın',
    deleteButton: 'Organizasyonu sil',
    notFoundTitle: 'Organizasyon bulunamadı',
    notFound: 'Böyle bir organizasyon yok ya da üyesi değilsiniz.',
    forbiddenTitle: 'Bu sayfa size açık değil',
    forbidden: 'Bu sayfayı yalnızca organizasyonun sahibi ya da yöneticisi açabilir.',
    ok_role: 'Rol değiştirildi.', ok_removed: 'Üye çıkarıldı.',
    ok_invited: 'Davet gönderildi.', ok_revoked: 'Davet geri çekildi.',
    ok_saved: 'Kaydedildi.', ok_declined: 'Davet reddedildi.',
    err_slug_taken: 'Bu adres alınmış. Başka bir adres deneyin.',
    err_slug: 'Adres küçük harf, rakam ve tireden oluşur.',
    err_name: 'Bir ad girin.',
    err_email: 'Bir e-posta adresi girin.',
    err_last_owner: 'Bir organizasyonun en az bir sahibi olmalı.',
    err_forbidden: 'Bu organizasyonda bunu yapma yetkiniz yok.',
    err_not_found: 'Bu artık yok.',
    err_confirm: 'Yazdığınız adres eşleşmiyor.',
    err_unknown: 'İşlem yapılamadı. Lütfen yeniden deneyin.',
  },
} satisfies Dictionary<string>

export type StringKey = keyof typeof STRINGS.en
export type T = ReturnType<typeof strings>

export function strings(lang: Lang) {
  return translator(STRINGS as Dictionary<StringKey>, lang)
}

/** The sentence for a `?ok=` or `?err=` code, or nothing. A code is never echoed. */
export function flash(t: T, kind: 'ok' | 'err', code: string | undefined): string {
  if (!code) return ''
  const key = `${kind}_${code}` as StringKey
  if (key in STRINGS.en) return t(key)
  return kind === 'err' ? t('err_unknown') : ''
}
