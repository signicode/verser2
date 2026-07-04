/**
 * Host-internal degraded-route cleanup management.
 *
 * Manages the timer start/stop and periodic expired degraded-route checks.
 * All Host-side coordination (route registry mutation, route advertisements,
 * lifecycle emission) is passed by reference via callbacks.
 *
 * @internal
 * This module is private to the Host implementation. It must not import
 * {@link NodeHttp2VerserHost} (no circular dependencies).
 */

import {
  type RoutedDomainRegistration,
  type VerserRouteGeneration,
  type VerserRouteLifecycleEvent,
  createRouteLifecycleEvent,
} from '@signicode/verser-common';

import type { RemoveExpiredDegradedResult } from './route-registry';

/**
 * Callbacks required by {@link DegradedRouteCleanup}.
 *
 * Passed by reference so the Host retains coordination of route registry
 * mutations, route advertisements, and lifecycle emission.
 */
export interface DegradedRouteCleanupCallbacks {
  /** Removes degraded routes whose timeout has expired. */
  removeExpiredDegradedRoutes(now: number, timeoutMs: number): RemoveExpiredDegradedResult;

  /** Returns true if any degraded routes still exist. */
  hasAnyDegradedRoutes(): boolean;

  /** Returns the peer IDs of all currently degraded routes. */
  getDegradedPeerIds(): string[];

  /** Returns the degraded broker-visible route records for a peer. */
  getDegradedBrokerRoutesForPeer(peerId: string): readonly RoutedDomainRegistration[];

  /** Returns the route generation for a peer + domain pair. */
  getRouteGeneration(peerId: string, domain: string): VerserRouteGeneration | undefined;

  /** Advertises route lifecycle events to all connected Brokers. */
  advertiseRouteLifecycleEvents(events: VerserRouteLifecycleEvent[]): void;

  /** Re-advertises the full route set to all Brokers. */
  advertiseRoutes(): void;

  /** Re-advertises federated routes to all connected Hosts. */
  advertiseFederatedRoutes(): void;
}

/**
 * Manages the degraded-route cleanup timer for the Host.
 *
 * Periodically checks for expired degraded routes and notifies the Host
 * via callbacks so it can remove routes, emit lifecycle events, and
 * re-advertise route state.
 *
 * @internal
 */
export class DegradedRouteCleanup {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly degradedRouteTimeoutMs: number;
  private readonly callbacks: DegradedRouteCleanupCallbacks;

  /**
   * @param degradedRouteTimeoutMs - Timeout in ms before a degraded route expires.
   * @param callbacks - Host-owned callbacks for registry mutation and emission.
   */
  constructor(degradedRouteTimeoutMs: number, callbacks: DegradedRouteCleanupCallbacks) {
    this.degradedRouteTimeoutMs = degradedRouteTimeoutMs;
    this.callbacks = callbacks;
  }

  /**
   * Starts the degraded route cleanup timer if not already running.
   * The check interval is derived from the configured timeout.
   */
  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    const checkInterval = Math.max(100, Math.floor(this.degradedRouteTimeoutMs / 10));
    this.timer = setInterval(() => {
      void this.check();
    }, checkInterval);
  }

  /**
   * Stops the degraded route cleanup timer if running.
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Checks for expired degraded routes and triggers removal, lifecycle
   * events, and route re-advertisement through Host callbacks.
   */
  private async check(): Promise<void> {
    const timeoutMs = this.degradedRouteTimeoutMs;
    const { callbacks } = this;

    // Capture generation metadata before removal so lifecycle events
    // carry the generation at the time of expiration.
    const genCache = new Map<string, Map<string, VerserRouteGeneration>>();
    for (const peerId of callbacks.getDegradedPeerIds()) {
      const domainMap = new Map<string, VerserRouteGeneration>();
      const routes = callbacks.getDegradedBrokerRoutesForPeer(peerId);
      for (const r of routes) {
        const gen = callbacks.getRouteGeneration(peerId, r.domain);
        if (gen !== undefined) {
          domainMap.set(r.domain, gen);
        }
      }
      if (domainMap.size > 0) {
        genCache.set(peerId, domainMap);
      }
    }

    const result = callbacks.removeExpiredDegradedRoutes(Date.now(), timeoutMs);
    if (result.expiredPeers.length === 0) {
      // No expired routes — stop timer if no degraded routes remain
      if (!callbacks.hasAnyDegradedRoutes()) {
        this.stop();
      }
      return;
    }

    // Emit lifecycle events for expired degraded routes with generation
    const events: VerserRouteLifecycleEvent[] = result.expiredRouteEntries.map((entry) => {
      const peerGen = genCache.get(entry.peerId);
      const domainGen = peerGen?.get(entry.domain);
      return createRouteLifecycleEvent({
        type: 'removed',
        targetId: entry.peerId,
        domain: entry.domain,
        reason: 'timeout',
        generation: domainGen,
      });
    });

    if (events.length > 0) {
      callbacks.advertiseRouteLifecycleEvents(events);
    }

    callbacks.advertiseRoutes();
    callbacks.advertiseFederatedRoutes();

    if (!callbacks.hasAnyDegradedRoutes()) {
      this.stop();
    }
  }
}
