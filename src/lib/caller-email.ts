/**
 * The signed-in caller's email address.
 *
 * Invitations are addressed to an email, so the invitee-facing endpoints need
 * to know the caller's — and a realm identity token deliberately does not carry
 * one. A token says who you are (`sub`), not what your contact details are;
 * those change, and a token that carried them would go stale.
 *
 * So it is resolved, in this order:
 *
 *   1. An `email` claim, if this realm's tokens happen to include one.
 *   2. iam-service, the identity authority, looked up by subject.
 *
 * Without either, the invitee-facing endpoints cannot work and say so plainly
 * rather than returning an empty list, which would read as "you have no
 * invitations" when the truth is "this service cannot tell".
 */

const TTL_MS = 60_000

type Entry = { email: string | null; at: number }
const cache = new Map<string, Entry>()

/** Tests and long-running processes should not be stuck with a stale answer. */
export function resetCallerEmailCache(): void {
  cache.clear()
}

export class EmailUnavailable extends Error {
  constructor() {
    super(
      'cannot determine the caller email: this realm\'s tokens carry no email claim ' +
        'and IAM_SERVICE_URL is not configured',
    )
  }
}

export async function callerEmail(
  auth: { userId: string; email?: string },
  bearer: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (auth.email) return auth.email.trim().toLowerCase()

  const base = env['IAM_SERVICE_URL']
  if (!base) throw new EmailUnavailable()

  const hit = cache.get(auth.userId)
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (hit.email) return hit.email
    throw new StoreNotFound()
  }

  let email: string | null = null
  try {
    const res = await fetch(
      `${base.replace(/\/+$/, '')}/users/lookup?id=${encodeURIComponent(auth.userId)}`,
      { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(3000) },
    )
    if (res.ok) {
      const body = (await res.json()) as { user?: { email?: string } }
      email = body.user?.email?.trim().toLowerCase() ?? null
    }
  } catch {
    // Unreachable iam is a failure to answer, not an answer. Do not cache it:
    // a brief outage would otherwise look like "no invitations" for a minute.
    throw new EmailUnavailable()
  }

  cache.set(auth.userId, { email, at: Date.now() })
  if (!email) throw new StoreNotFound()
  return email
}

/** The caller exists as a subject but iam has no email for them. */
export class StoreNotFound extends Error {
  constructor() {
    super('no email on record for this user')
  }
}
