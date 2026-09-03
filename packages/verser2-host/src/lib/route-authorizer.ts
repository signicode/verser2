/**
 * Host-internal federated route authorizer.
 *
 * Owns the hop-local authorization lifecycle for one Host: cache lookup,
 * pending-decision (single-flight) sharing, explicit-allow and explicit-deny
 * insertion with independently configured TTLs, explicit pair revocation,
 * generation-safe invalidation, and the normalized pair key derived from
 * `{ previousAdvertisedDomain, nextSelectedDomain }`.
 *
 * Only explicit callback outcomes are cached: `'allow'` results populate the
 * positive cache and `'deny'` results the negative cache. Callback errors are
 * never cached. Entries expire lazily (no timers): an expired entry is a miss
 * and is dropped on lookup. A TTL of `0` disables that cache class entirely,
 * asking the callback on every decision while still honoring the current
 * result.
 *
 * Generation safety: a pending outcome may cache and take effect only while
 * the generation token captured before the callback is still current and the
 * pair was not explicitly revoked while pending. A stale pending allow
 * therefore cannot authorize forwarding and a stale pending deny cannot
 * repopulate either cache, so an explicit revoke or a route loss cannot be
 * undone by an earlier in-flight decision. Revoke clears a cached allow or
 * deny for the pair and abandons its pending decision; invalidation clears
 * both cache classes and stales all pending decisions.
 *
 * The Host wires this authorizer into route/import/link lifecycle points for
 * invalidation and invokes {@link FederatedRouteAuthorizer.authorizeHop} from
 * the federation forwarding paths. Route-bound logical streams and accepted
 * federated VWS connections keep their already-granted decision for their
 * lifetime; these caches only gate new forwarding/open decisions.
 *
 * @internal
 * This module is private to the Host implementation. It must not import
 * {@link NodeHttp2VerserHost} (no circular dependencies).
 */

import {
  type VerserFederatedRouteAuthorizationCallback,
  type VerserFederatedRouteAuthorizationPair,
  normalizeVerserRouteDomain,
} from '@signicode/verser-common';

/** Positive/negative authorization-cache TTLs in milliseconds. `0` disables. */
export interface FederatedRouteAuthorizerOptions {
  readonly allowTtlMs: number;
  readonly denyTtlMs: number;
}

/** Builds the canonical cache key for a normalized hop-local domain pair. */
export function federatedRouteAuthorizationPairKey(
  pair: VerserFederatedRouteAuthorizationPair,
): string {
  return `${normalizeVerserRouteDomain(pair.previousAdvertisedDomain)}\u0000${normalizeVerserRouteDomain(
    pair.nextSelectedDomain,
  )}`;
}

interface PendingDecision {
  readonly generation: number;
  revoked: boolean;
  readonly promise: Promise<boolean>;
}

/**
 * Cached, revocable first-use hop-local federation route authorization with
 * independently configured positive and negative TTLs.
 *
 * @internal
 */
export class FederatedRouteAuthorizer {
  /** Cached allow results: key → expiry timestamp (ms). */
  private readonly allowedPairs = new Map<string, number>();

  /** Cached deny results: key → expiry timestamp (ms). */
  private readonly deniedPairs = new Map<string, number>();

  private readonly pendingDecisions = new Map<string, PendingDecision>();

  private generation = 0;

  public constructor(
    private readonly authorize: VerserFederatedRouteAuthorizationCallback,
    private readonly options: FederatedRouteAuthorizerOptions,
  ) {}

  /**
   * Returns whether the normalized hop-local pair is authorized to forward.
   *
   * A live cached allow resolves `true` and a live cached deny resolves
   * `false` without invoking the callback. Concurrent requests for the same
   * pair share one in-flight callback decision (single-flight), including
   * after an entry expires. An explicit outcome is cached — with its class
   * TTL when that TTL is non-zero — and takes effect only while the
   * generation token captured before the callback is still current and the
   * pair was not explicitly revoked while pending. Callback rejections are
   * never cached and propagate to all single-flight sharers.
   */
  public authorizeHop(pair: VerserFederatedRouteAuthorizationPair): Promise<boolean> {
    const key = federatedRouteAuthorizationPairKey(pair);
    const now = Date.now();
    if (this.isLive(this.allowedPairs, key, now)) {
      return Promise.resolve(true);
    }
    if (this.isLive(this.deniedPairs, key, now)) {
      return Promise.resolve(false);
    }

    const pending = this.pendingDecisions.get(key);
    if (pending !== undefined) {
      return pending.promise;
    }

    const generation = this.generation;
    // The Promise executor runs synchronously, so these placeholders are
    // always replaced before the decision body can settle.
    let resolveDecision: (value: boolean) => void = () => {};
    let rejectDecision: (reason: unknown) => void = () => {};
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    const entry: PendingDecision = { generation, revoked: false, promise };
    this.pendingDecisions.set(key, entry);

    (async (): Promise<void> => {
      try {
        const decision = await this.authorize({
          previousAdvertisedDomain: normalizeVerserRouteDomain(pair.previousAdvertisedDomain),
          nextSelectedDomain: normalizeVerserRouteDomain(pair.nextSelectedDomain),
        });
        // Generation-safe insertion: an invalidation or explicit revoke that
        // happened while the callback was pending must not be undone, and a
        // stale outcome may neither take effect nor repopulate either cache.
        if (entry.revoked || generation !== this.generation) {
          resolveDecision(false);
          return;
        }
        if (decision === 'allow') {
          this.insert(this.allowedPairs, key, this.options.allowTtlMs);
          resolveDecision(true);
          return;
        }
        if (decision === 'deny') {
          this.insert(this.deniedPairs, key, this.options.denyTtlMs);
        }
        resolveDecision(false);
      } catch (error) {
        // Callback errors are never cached; rejections propagate to all
        // single-flight sharers without caching.
        rejectDecision(error);
      } finally {
        if (this.pendingDecisions.get(key) === entry) {
          this.pendingDecisions.delete(key);
        }
      }
    })();

    return promise;
  }

  /**
   * Explicitly revokes one hop-local pair.
   *
   * Removes any cached allow or deny result and abandons any in-flight
   * decision for the pair, so a pending outcome cannot be cached or take
   * effect after this call.
   *
   * @returns `true` when a cached allow/deny or pending decision was revoked.
   */
  public revokePair(pair: VerserFederatedRouteAuthorizationPair): boolean {
    const key = federatedRouteAuthorizationPairKey(pair);
    const pending = this.pendingDecisions.get(key);
    if (pending !== undefined) {
      pending.revoked = true;
      this.pendingDecisions.delete(key);
    }
    const removedAllow = this.allowedPairs.delete(key);
    const removedDeny = this.deniedPairs.delete(key);
    return removedAllow || removedDeny || pending !== undefined;
  }

  /**
   * Invalidates every cached allow and deny and aborts the relevance of all
   * pending decisions by advancing the generation token.
   *
   * Called for local and imported route changes, imported snapshot
   * replacement, direct lifecycle removal, federation-link removal, and Host
   * shutdown. Pending outcomes observe the stale token when their callback
   * returns: they neither take effect nor repopulate either cache.
   */
  public invalidate(): void {
    this.generation += 1;
    this.allowedPairs.clear();
    this.deniedPairs.clear();
  }

  /** Number of live cached allow pairs. @internal Test/diagnostic seam. */
  public get cachedAllowCount(): number {
    return this.liveCount(this.allowedPairs, Date.now());
  }

  /** Number of live cached deny pairs. @internal Test/diagnostic seam. */
  public get cachedDenyCount(): number {
    return this.liveCount(this.deniedPairs, Date.now());
  }

  /** Number of in-flight pending decisions. @internal Test/diagnostic seam. */
  public get pendingDecisionCount(): number {
    return this.pendingDecisions.size;
  }

  /** Reads a cache entry, lazily dropping it once expired (no timers). */
  private isLive(cache: Map<string, number>, key: string, now: number): boolean {
    const expiresAt = cache.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= now) {
      cache.delete(key);
      return false;
    }
    return true;
  }

  /** Inserts a result with its class TTL; a TTL of 0 disables caching. */
  private insert(cache: Map<string, number>, key: string, ttlMs: number): void {
    if (ttlMs <= 0) {
      return;
    }
    cache.set(key, Date.now() + ttlMs);
  }

  private liveCount(cache: Map<string, number>, now: number): number {
    let count = 0;
    for (const expiresAt of cache.values()) {
      if (expiresAt > now) {
        count += 1;
      }
    }
    return count;
  }
}
