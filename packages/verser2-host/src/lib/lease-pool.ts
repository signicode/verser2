/**
 * Host-internal lease pool for Guest lease stream management.
 *
 * Manages idle leases, active leases, queued acquisitions, acquisition timeout
 * handling, lease removal, close cleanup, and queued-acquisition failure.
 *
 * @internal
 * This module is private to the Host implementation. It must not import
 * {@link NodeHttp2VerserHost} (no circular dependencies).
 */

import * as http2 from 'node:http2';

import { type VerserError, type VerserPeerId, createVerserError } from '@signicode/verser-common';

/**
 * A lease stream provided by a Guest for request/response exchange.
 */
export interface GuestLeaseStream {
  readonly guestId: VerserPeerId;
  readonly leaseId: string;
  readonly stream: http2.ServerHttp2Stream;
  active: boolean;
}

/**
 * A queued lease acquisition waiting for an idle lease to become available.
 */
interface QueuedLeaseAcquisition {
  readonly guestId: VerserPeerId;
  readonly requestId: string;
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (lease: GuestLeaseStream) => void;
  readonly reject: (error: VerserError) => void;
}

/**
 * Manages the pool of Guest lease streams: idle leases, active leases, and
 * queued acquisitions. All pool operations are Host-internal and do not
 * reference the Host class.
 */
export class LeasePool {
  private readonly idleLeases = new Map<VerserPeerId, GuestLeaseStream[]>();
  private readonly activeLeases = new Map<string, GuestLeaseStream>();
  private readonly queuedLeaseAcquisitions = new Map<VerserPeerId, QueuedLeaseAcquisition[]>();

  /**
   * Adds an idle lease to the pool. If a queued acquisition is waiting for
   * this guest's lease, the lease is assigned immediately (resolving the
   * queued promise) instead of being added to the idle pool.
   */
  addIdleLease(lease: GuestLeaseStream): void {
    const queued = this.queuedLeaseAcquisitions.get(lease.guestId)?.shift();
    if (queued !== undefined) {
      clearTimeout(queued.timeout);
      lease.active = true;
      this.activeLeases.set(`${lease.guestId}:${lease.leaseId}`, lease);
      queued.resolve(lease);
      return;
    }

    const idleLeases = this.idleLeases.get(lease.guestId) ?? [];
    idleLeases.push(lease);
    this.idleLeases.set(lease.guestId, idleLeases);
  }

  /**
   * Acquires a lease for the given guest. Returns idle lease immediately if
   * one is available. Otherwise queues the acquisition and returns a promise
   * that resolves when a lease becomes available or rejects on timeout.
   */
  acquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream> {
    const idleLeases = this.idleLeases.get(guestId) ?? [];
    const lease = idleLeases.shift();
    if (lease !== undefined) {
      lease.active = true;
      this.activeLeases.set(`${lease.guestId}:${lease.leaseId}`, lease);
      return Promise.resolve(lease);
    }

    return new Promise<GuestLeaseStream>((resolve, reject) => {
      const acquisition: QueuedLeaseAcquisition = {
        guestId,
        requestId,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.removeQueuedLeaseAcquisition(acquisition);
          reject(
            createVerserError('timeout', 'Timed out waiting for a Guest lease stream', {
              targetId: guestId,
              requestId,
              timeoutMs,
            }),
          );
        }, timeoutMs),
      };
      const queued = this.queuedLeaseAcquisitions.get(guestId) ?? [];
      queued.push(acquisition);
      this.queuedLeaseAcquisitions.set(guestId, queued);
    });
  }

  /**
   * Tries to acquire a lease for the given guest without queuing.
   * Returns a lease immediately if one is idle, or `undefined` if no
   * idle lease is available.
   */
  async tryAcquireLease(
    guestId: VerserPeerId,
    requestId: string,
    timeoutMs: number,
  ): Promise<GuestLeaseStream | undefined> {
    const idleLeases = this.idleLeases.get(guestId) ?? [];
    if (idleLeases.length === 0) {
      return undefined;
    }
    return this.acquireLease(guestId, requestId, timeoutMs);
  }

  /**
   * Removes a lease from both idle and active maps. Does not close the
   * stream. Called when a lease stream's `close` or `error` event fires.
   */
  removeLease(lease: GuestLeaseStream): void {
    const idleLeases = this.idleLeases.get(lease.guestId) ?? [];
    this.idleLeases.set(
      lease.guestId,
      idleLeases.filter((candidate) => candidate !== lease),
    );
    this.activeLeases.delete(`${lease.guestId}:${lease.leaseId}`);
  }

  /**
   * Closes all idle and active lease streams for a specific guest and removes
   * them from the pool.
   */
  closeGuestLeases(guestId: VerserPeerId): void {
    for (const lease of this.idleLeases.get(guestId) ?? []) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    this.idleLeases.delete(guestId);

    for (const [key, lease] of this.activeLeases) {
      if (lease.guestId === guestId) {
        lease.stream.close(http2.constants.NGHTTP2_CANCEL);
        this.activeLeases.delete(key);
      }
    }
  }

  /**
   * Closes all idle and active lease streams across all guests and clears the
   * pool.
   */
  closeAllLeases(): void {
    for (const leases of this.idleLeases.values()) {
      for (const lease of leases) {
        lease.stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    }
    for (const lease of this.activeLeases.values()) {
      lease.stream.close(http2.constants.NGHTTP2_CANCEL);
    }
    this.idleLeases.clear();
    this.activeLeases.clear();
  }

  /**
   * Fails all queued lease acquisitions for a specific guest with the given
   * reason. Clears the acquisition queue for that guest.
   */
  failQueuedLeaseAcquisitions(guestId: VerserPeerId, reason: string): void {
    const queued = this.queuedLeaseAcquisitions.get(guestId) ?? [];
    this.queuedLeaseAcquisitions.delete(guestId);
    for (const acquisition of queued) {
      clearTimeout(acquisition.timeout);
      acquisition.reject(
        createVerserError('disconnected-target', 'Guest disconnected while waiting for a lease', {
          targetId: guestId,
          requestId: acquisition.requestId,
          reason,
        }),
      );
    }
  }

  /**
   * Fails all queued lease acquisitions across all guests with the given
   * reason. Clears all acquisition queues.
   */
  failAllQueuedLeaseAcquisitions(reason: string): void {
    for (const guestId of this.queuedLeaseAcquisitions.keys()) {
      this.failQueuedLeaseAcquisitions(guestId, reason);
    }
  }

  /**
   * Removes a single queued acquisition from its guest's queue. Used when
   * an acquisition times out.
   */
  private removeQueuedLeaseAcquisition(acquisition: QueuedLeaseAcquisition): void {
    const queued = this.queuedLeaseAcquisitions.get(acquisition.guestId) ?? [];
    this.queuedLeaseAcquisitions.set(
      acquisition.guestId,
      queued.filter((candidate) => candidate !== acquisition),
    );
  }
}
