/**
 * Host-internal federated route authorizer.
 *
 * Owns the hop-local authorization lifecycle for one Host: cache lookup,
 * pending-decision (single-flight) sharing, successful-allow insertion,
 * explicit pair revocation, generation-safe invalidation, and the normalized
 * pair key derived from `{ previousAdvertisedDomain, nextSelectedDomain }`.
 *
 * Only allowed decisions are cached. Denied decisions, callback errors, and
 * allows whose generation token is no longer current when the callback
 * returns are never cached and never authorize forwarding, so an explicit
 * revoke or a route loss cannot be undone by an earlier in-flight decision.
 *
 * The Host wires this authorizer into route/import/link lifecycle points for
 * invalidation and invokes {@link FederatedRouteAuthorizer.authorizeHop} from
 * the federation forwarding paths.
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
 * Cached, revocable first-use hop-local federation route authorization.
 *
 * @internal
 */
export class FederatedRouteAuthorizer {
  private readonly allowedPairs = new Set<string>();

  private readonly pendingDecisions = new Map<string, PendingDecision>();

  private generation = 0;

  public constructor(private readonly authorize: VerserFederatedRouteAuthorizationCallback) {}

  /**
   * Returns whether the normalized hop-local pair is authorized to forward.
   *
   * A cached allow resolves immediately. Concurrent requests for the same
   * pair share one in-flight callback decision (single-flight). An allowed
   * decision is cached — and resolves `true` — only while the generation
   * token captured before the callback is still current and the pair was not
   * explicitly revoked while the callback was pending. Denied decisions and
   * callback rejections are not cached.
   */
  public authorizeHop(pair: VerserFederatedRouteAuthorizationPair): Promise<boolean> {
    const key = federatedRouteAuthorizationPairKey(pair);
    if (this.allowedPairs.has(key)) {
      return Promise.resolve(true);
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
        if (decision !== 'allow') {
          resolveDecision(false);
          return;
        }
        // Generation-safe insertion: an invalidation or explicit revoke that
        // happened while the callback was pending must not be undone.
        if (entry.revoked || generation !== this.generation) {
          resolveDecision(false);
          return;
        }
        this.allowedPairs.add(key);
        resolveDecision(true);
      } catch (error) {
        // Denied results are never cached; rejections propagate to all
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
   * Removes any cached allow and abandons any in-flight decision for the
   * pair, so a pending allow cannot be cached or forwarded after this call.
   *
   * @returns `true` when a cached allow or pending decision was revoked.
   */
  public revokePair(pair: VerserFederatedRouteAuthorizationPair): boolean {
    const key = federatedRouteAuthorizationPairKey(pair);
    const pending = this.pendingDecisions.get(key);
    if (pending !== undefined) {
      pending.revoked = true;
      this.pendingDecisions.delete(key);
    }
    const removed = this.allowedPairs.delete(key);
    return removed || pending !== undefined;
  }

  /**
   * Invalidates every cached allow and aborts the relevance of all pending
   * decisions by advancing the generation token.
   *
   * Called for local and imported route changes, imported snapshot
   * replacement, direct lifecycle removal, federation-link removal, and Host
   * shutdown. Pending allows observe the stale token when their callback
   * returns and are neither cached nor forwarded.
   */
  public invalidate(): void {
    this.generation += 1;
    this.allowedPairs.clear();
  }

  /** Number of currently cached allowed pairs. @internal Test/diagnostic seam. */
  public get cachedAllowCount(): number {
    return this.allowedPairs.size;
  }

  /** Number of in-flight pending decisions. @internal Test/diagnostic seam. */
  public get pendingDecisionCount(): number {
    return this.pendingDecisions.size;
  }
}
