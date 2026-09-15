/**
 * Putting names on member lists.
 *
 * org-service stores a membership as `(user, org, role)` and nothing else — who
 * that user *is* belongs to iam-service, and duplicating an email here would
 * mean carrying a copy that goes stale the moment somebody changes theirs.
 *
 * So the join happens on the way out, here, rather than in the client: iam's
 * user endpoints are deliberately not published on the gateway, so a browser
 * or a CLI cannot make this call itself. One batch request per list, not one
 * per member.
 *
 * Identity is an enrichment, never a requirement. A realm running org-service
 * without iam still lists its members; they simply arrive without names, which
 * is what the service actually knows.
 */

const TTL_MS = 60_000

type Entry = { profile: Profile | null; at: number }
const cache = new Map<string, Entry>()

export interface Profile {
  email?: string
  name?: string
}

/** Tests and long-running processes should not be stuck with a stale answer. */
export function resetIdentityCache(): void {
  cache.clear()
}

/**
 * Look up the given user ids. Returns what it could resolve; an id that is
 * missing from the answer is one iam does not know, which is normal for a
 * member whose account was deleted.
 *
 * Never throws. A member list that cannot reach iam is still a member list —
 * failing the whole request because the names are unavailable would take away
 * the roles and the count as well, which are the part org-service owns.
 */
export async function profilesFor(
  userIds: string[],
  bearer: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>()
  const base = env['IAM_SERVICE_URL']
  if (!base || userIds.length === 0) return out

  const now = Date.now()
  const missing: string[] = []
  for (const id of new Set(userIds)) {
    const hit = cache.get(id)
    if (hit && now - hit.at < TTL_MS) {
      if (hit.profile) out.set(id, hit.profile)
    } else {
      missing.push(id)
    }
  }
  if (missing.length === 0) return out

  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/users/resolve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: missing }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return out
    const body = (await res.json()) as { users?: { id: string; email?: string; name?: string | null }[] }
    const found = new Map((body.users ?? []).map((u) => [u.id, u]))
    for (const id of missing) {
      const u = found.get(id)
      const profile: Profile | null = u
        ? { ...(u.email ? { email: u.email } : {}), ...(u.name ? { name: u.name } : {}) }
        : null
      // A negative answer is cached too: an id iam does not know will not start
      // being known in the next minute, and re-asking on every page load turns
      // one deleted account into steady traffic.
      cache.set(id, { profile, at: now })
      if (profile) out.set(id, profile)
    }
  } catch {
    // Unreachable iam is a failure to answer, not an answer — and not cached,
    // or a brief outage would blank every name for a minute after it ended.
  }
  return out
}
