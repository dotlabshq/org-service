import type { EffectiveRole } from '@baseworks/org'
import type { Store } from '../store.js'

/**
 * A short memory for "what role does this person hold at this scope".
 *
 * Every request to every product service asks that question (`/authz/role`),
 * and each answer costs several reads of the event store's projections. The
 * answer changes rarely, so it is kept in this process for a few seconds.
 *
 * What that costs, said plainly: a role can be stale for up to the TTL. Two
 * things keep that small. Any membership write that goes through this process
 * forgets everything at once, so on a single instance a change is visible on
 * the next request. With several instances, a change made on one is seen by
 * the others when their entries run out — a removed member keeps their old
 * answer for at most `ORG_ROLE_CACHE_SECONDS` there. That is the same kind of
 * trade ADR-042 refused for tokens (which live for hours); here it is seconds,
 * and it can be turned off.
 *
 *   ORG_ROLE_CACHE_SECONDS   default 10; `0` turns the cache off
 *
 * Only answers are remembered. A scope that does not exist is asked again
 * every time, so a typo is not turned into a remembered 404.
 */
export interface RoleCache {
  get(userId: string, scopeId: string): EffectiveRole | undefined
  set(userId: string, scopeId: string, value: EffectiveRole): void
  clear(): void
}

/** More entries than this and the cache starts over: a bound, not an eviction policy. */
const MAX_ENTRIES = 20_000

export function createRoleCache(env: Record<string, string | undefined> = process.env, now: () => number = Date.now): RoleCache {
  const raw = Number(env['ORG_ROLE_CACHE_SECONDS'] ?? 10)
  const ttlMs = Number.isFinite(raw) && raw > 0 ? raw * 1000 : 0
  const entries = new Map<string, { value: EffectiveRole; until: number }>()
  const key = (userId: string, scopeId: string) => `${userId}\u0000${scopeId}`

  return {
    get(userId, scopeId) {
      if (!ttlMs) return undefined
      const hit = entries.get(key(userId, scopeId))
      if (!hit) return undefined
      if (hit.until <= now()) {
        entries.delete(key(userId, scopeId))
        return undefined
      }
      return hit.value
    },
    set(userId, scopeId, value) {
      if (!ttlMs) return
      if (entries.size >= MAX_ENTRIES) entries.clear()
      entries.set(key(userId, scopeId), { value, until: now() + ttlMs })
    },
    clear() {
      entries.clear()
    },
  }
}

/** The store writes after which a remembered role may be wrong. */
const WRITES = [
  'createOrg', 'archiveOrg', 'addMember', 'changeMemberRole', 'removeMember', 'acceptInvitation',
  'createScope', 'archiveScope',
] as const satisfies ReadonlyArray<keyof Store>

/**
 * The same store, remembering roles: `effectiveRole` answers from memory when
 * it can, and every write that can change an answer forgets all of them. Done
 * here, around the store, so no route has to remember to invalidate.
 */
export function withRoleCache(store: Store, cache: RoleCache): Store {
  const wrapped: Store = {
    ...store,
    async effectiveRole(userId: string, scopeId: string) {
      const hit = cache.get(userId, scopeId)
      if (hit) return hit
      const value = await store.effectiveRole(userId, scopeId)
      cache.set(userId, scopeId, value)
      return value
    },
  }
  for (const name of WRITES) {
    const write = store[name] as (...args: unknown[]) => Promise<unknown>
    ;(wrapped as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      try {
        return await write(...args)
      } finally {
        // Also after a failure: a write that threw may still have landed.
        cache.clear()
      }
    }
  }
  return wrapped
}
