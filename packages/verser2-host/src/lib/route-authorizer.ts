/**
 * Host-internal federated route authorizer.
 *
 * Owns the hop-local authorization lifecycle for one Host: cache lookup,
 * pending-decision (single-flight) sharing, allow and deny insertion with
 * independently configured class TTLs and per-decision `cacheTtlMs`
 * overrides, explicit pair revocation, generation-safe invalidation, and the
 * normalized pair key derived from `{ previousAdvertisedDomain,
 * nextSelectedDomain }`.
 *
 * The callback may return the legacy `'allow'`/`'deny'` strings or an object
 * `{ decision, cacheTtlMs? }`. Output is normalized once to a private
 * `{ decision, ttlMs }` shape: an omitted/undefined `cacheTtlMs` uses the
 * Host's finite class TTL, `0` disables caching for that single result, a
 * positive safe integer whose computed absolute `Date.now() + ttl` expiry is
 * itself a safe integer overrides the class TTL (the expiry is computed and
 * retained at normalization time, never recomputed at insertion), and only
 * `Number.POSITIVE_INFINITY` caches until explicit revoke or lifecycle
 * invalidation. Malformed or missing decisions and invalid TTLs (including a
 * sum beyond the safe-integer range such as `Number.MAX_SAFE_INTEGER`) fail
 * deterministically (rejected, never cached), as do callback errors. Entries
 * expire lazily (no timers): an expired entry is a miss and is dropped on
 * lookup.
 *
 * Generation safety: a pending outcome may cache and take effect only while
 * the generation token captured before the callback is still current and the
 * pair was not explicitly revoked while pending. A stale pending allow
 * therefore cannot authorize forwarding and a stale pending deny cannot
 * deny/cache, so an explicit revoke or a route loss cannot be undone by an
 * earlier in-flight decision. Revoke clears a cached allow or deny for the
 * pair — finite or infinite — and abandons its pending decision; invalidation
 * clears both cache classes (including infinite entries) and stales all
 * pending decisions. A `0`-TTL result still resolves its shared in-flight
 * callers.
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
  type VerserFederatedRouteAuthorizationOutcome,
  type VerserFederatedRouteAuthorizationPair,
  createVerserError,
  normalizeVerserRouteDomain,
} from '@signicode/verser-common';

/** Positive/negative authorization-cache TTLs in milliseconds. `0` disables. */
export interface FederatedRouteAuthorizerOptions {
  readonly allowTtlMs: number;
  readonly denyTtlMs: number;
}

/**
 * The single private shape every callback result is normalized to once: a
 * validated decision plus the absolute cache expiry computed and retained at
 * normalization time (`undefined` disables caching for the result;
 * `Number.POSITIVE_INFINITY` caches until revoke/invalidation). Insertion
 * stores this retained expiry; it is never recomputed.
 */
interface NormalizedAuthorizationResult {
  readonly decision: 'allow' | 'deny';
  readonly expiresAt: number | undefined;
}

/**
 * Normalizes a legacy string or object callback result once.
 *
 * A finite `cacheTtlMs` override is validated by computing its absolute
 * `Date.now() + ttl` expiry once and requiring `Number.isSafeInteger`, so a
 * sum beyond the safe-integer range (e.g. `Number.MAX_SAFE_INTEGER`) is
 * rejected without caching. Throws a `protocol-error` for malformed/missing
 * decisions and invalid TTL overrides; callers treat that like a callback
 * error (deterministic rejection, nothing cached).
 */
function normalizeAuthorizationResult(
  outcome: VerserFederatedRouteAuthorizationOutcome,
  options: FederatedRouteAuthorizerOptions,
): NormalizedAuthorizationResult {
  let decision: 'allow' | 'deny';
  let overrideExpiresAt: number | undefined;
  let hasOverride = false;
  if (outcome === 'allow' || outcome === 'deny') {
    decision = outcome;
  } else if (typeof outcome === 'object' && outcome !== null && !Array.isArray(outcome)) {
    const record = outcome as { decision?: unknown; cacheTtlMs?: unknown };
    if (record.decision !== 'allow' && record.decision !== 'deny') {
      throw createVerserError(
        'protocol-error',
        'Route authorizer returned a missing or invalid decision',
        { decision: typeof record.decision === 'string' ? record.decision : undefined },
      );
    }
    decision = record.decision;
    if ('cacheTtlMs' in record && record.cacheTtlMs !== undefined) {
      const raw = record.cacheTtlMs;
      hasOverride = true;
      if (raw === Number.POSITIVE_INFINITY) {
        overrideExpiresAt = Number.POSITIVE_INFINITY;
      } else if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        throw createVerserError(
          'protocol-error',
          'Route authorizer cacheTtlMs must be 0, a positive safe integer, or Number.POSITIVE_INFINITY',
        );
      } else if (raw === 0) {
        overrideExpiresAt = undefined;
      } else {
        // Validate by the computed, retained absolute expiry: a
        // `Date.now() + ttl` sum that is not a safe integer (e.g.
        // Number.MAX_SAFE_INTEGER) is rejected deterministically without
        // caching, and insertion must not recompute it.
        const expiresAt = Date.now() + raw;
        if (!Number.isSafeInteger(expiresAt)) {
          throw createVerserError(
            'protocol-error',
            'Route authorizer cacheTtlMs must produce a safe representable expiry',
          );
        }
        overrideExpiresAt = expiresAt;
      }
    }
  } else {
    throw createVerserError(
      'protocol-error',
      'Route authorizer returned a missing or invalid decision',
    );
  }
  if (hasOverride) {
    return { decision, expiresAt: overrideExpiresAt };
  }
  const classTtlMs = decision === 'allow' ? options.allowTtlMs : options.denyTtlMs;
  return { decision, expiresAt: classTtlMs === 0 ? undefined : Date.now() + classTtlMs };
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
   * after an entry expires. The callback result (legacy string or object with
   * a per-decision `cacheTtlMs` override) is normalized once; a current
   * explicit result is cached under its resolved TTL — `0` skips caching for
   * that result, `Number.POSITIVE_INFINITY` caches until revoke/invalidation
   * — and takes effect only while the generation token captured before the
   * callback is still current and the pair was not explicitly revoked while
   * pending. Stale pending results neither take effect nor cache, and
   * callback rejections and malformed results propagate to all single-flight
   * sharers without caching.
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
        const outcome = await this.authorize({
          previousAdvertisedDomain: normalizeVerserRouteDomain(pair.previousAdvertisedDomain),
          nextSelectedDomain: normalizeVerserRouteDomain(pair.nextSelectedDomain),
        });
        // Normalize once, before any generation check: malformed output
        // fails deterministically and is never cached.
        const result = normalizeAuthorizationResult(outcome, this.options);
        // Generation-safe insertion: an invalidation or explicit revoke that
        // happened while the callback was pending must not be undone, and a
        // stale outcome may neither take effect nor repopulate either cache.
        if (entry.revoked || generation !== this.generation) {
          resolveDecision(false);
          return;
        }
        if (result.decision === 'allow') {
          this.insert(this.allowedPairs, key, result.expiresAt);
          resolveDecision(true);
          return;
        }
        this.insert(this.deniedPairs, key, result.expiresAt);
        resolveDecision(false);
      } catch (error) {
        // Callback errors and malformed results are never cached; rejections
        // propagate to all single-flight sharers without caching.
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
   * Removes any cached allow or deny result — finite or infinite — and
   * abandons any in-flight decision for the pair, so a pending outcome cannot
   * be cached or take effect after this call.
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
   * Invalidates every cached allow and deny — finite and infinite — and
   * aborts the relevance of all pending decisions by advancing the generation
   * token.
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

  /**
   * Stores the expiry computed and retained once during normalization.
   * `undefined` (a `0` TTL) disables caching for this result;
   * `Number.POSITIVE_INFINITY` stores an expiry that lazy lookup never
   * considers stale (cleared only by revoke/invalidation). Never recomputed.
   */
  private insert(cache: Map<string, number>, key: string, expiresAt: number | undefined): void {
    if (expiresAt === undefined) {
      return;
    }
    cache.set(key, expiresAt);
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
