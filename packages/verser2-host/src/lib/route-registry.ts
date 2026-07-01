import {
  type FederatedRouteRegistration,
  type RoutedDomainRegistration,
  type VerserError,
  type VerserHostId,
  type VerserRouteGeneration,
  createFederatedRouteRegistration,
  createRoutedDomainRegistration,
  createVerserError,
  createVerserHostId,
  createVerserRouteGeneration,
  exceedsFederatedRouteHopLimit,
  isFederatedRouteLoop,
} from '@signicode/verser-common';

interface StoredRouteCandidate {
  readonly ownerId: string;
  readonly route: FederatedRouteRegistration;
}

interface DegradedRouteEntry {
  readonly routes: FederatedRouteRegistration[];
  readonly degradedAt: number;
  readonly generation: VerserRouteGeneration;
}

export interface HostRouteRegistryOptions {
  readonly hostId: VerserHostId;
  readonly maxFederationHopCount: number;
}

export interface ImportedRouteRejection {
  readonly route: FederatedRouteRegistration;
  readonly error: VerserError;
}

export interface ImportedRouteUpdate {
  readonly rejected: ImportedRouteRejection[];
  readonly changed: boolean;
}

export interface RevokeRoutesResult {
  readonly revoked: string[];
  readonly notFound: string[];
}

export interface RemoveExpiredDegradedResult {
  readonly expiredPeers: string[];
  readonly expiredRoutes: number;
  readonly expiredRouteEntries: readonly { peerId: string; domain: string }[];
}

export class HostRouteRegistry {
  private readonly localRoutes = new Map<string, FederatedRouteRegistration[]>();

  private readonly importedRoutes = new Map<string, FederatedRouteRegistration[]>();

  private readonly degradedRoutes = new Map<string, DegradedRouteEntry>();

  private routeGenerationCounter = 0;

  public constructor(private readonly options: HostRouteRegistryOptions) {}

  public setLocalRoutes(peerId: string, routes: readonly RoutedDomainRegistration[]): void {
    this.localRoutes.set(
      peerId,
      routes.map((route) =>
        createFederatedRouteRegistration({
          ...createRoutedDomainRegistration(route),
          originHostId: this.options.hostId,
          nextHopHostId: this.options.hostId,
          hopCount: 0,
          viaHostIds: [this.options.hostId],
          source: 'local',
        }),
      ),
    );
  }

  public removeLocalRoutes(peerId: string): void {
    this.localRoutes.delete(peerId);
  }

  public setImportedRoutes(
    upstreamId: string,
    routes: readonly FederatedRouteRegistration[],
  ): ImportedRouteUpdate {
    const accepted: FederatedRouteRegistration[] = [];
    const rejected: ImportedRouteRejection[] = [];

    for (const routeInput of routes) {
      const route = createFederatedRouteRegistration({ ...routeInput, source: 'upstream' });
      const routeError = this.getImportedRouteRejection(route);
      if (routeError === undefined) {
        accepted.push(route);
      } else {
        rejected.push({ route, error: routeError });
      }
    }

    const changed =
      routeSetKey(this.importedRoutes.get(upstreamId) ?? []) !== routeSetKey(accepted);
    this.importedRoutes.set(upstreamId, accepted);
    return { rejected, changed };
  }

  public removeImportedRoutes(upstreamId: string): void {
    this.importedRoutes.delete(upstreamId);
  }

  /**
   * Removes a single imported route from the given upstream's set.
   *
   * Returns `true` if the route was found and removed, `false` otherwise.
   * This is used to eagerly remove revoked routes from federated peers
   * without waiting for the next full `federated-routes` snapshot.
   *
   * @param upstreamId - The upstream that imported the route.
   * @param targetId - The Guest peer ID of the route to remove.
   * @param domain - The domain of the route to remove.
   * @returns `true` if the route was removed; `false` if not found.
   */
  public removeImportedRoute(upstreamId: string, targetId: string, domain: string): boolean {
    const routes = this.importedRoutes.get(upstreamId);
    if (routes === undefined || routes.length === 0) {
      return false;
    }

    const remaining = routes.filter(
      (route) => !(route.targetId === targetId && route.domain === domain),
    );

    if (remaining.length === routes.length) {
      return false;
    }

    if (remaining.length > 0) {
      this.importedRoutes.set(upstreamId, remaining);
    } else {
      this.importedRoutes.delete(upstreamId);
    }

    return true;
  }

  public clear(): void {
    this.localRoutes.clear();
    this.importedRoutes.clear();
    this.degradedRoutes.clear();
    this.routeGenerationCounter = 0;
  }

  /**
   * Revokes a subset of routes owned by a peer.
   *
   * Only domains that are currently registered for the peer are revoked.
   * Returns the list of successfully revoked domains and any domains that
   * were requested but not found in the peer's route table.
   *
   * @param peerId - The peer whose routes to revoke.
   * @param domains - The domains to revoke.
   * @returns Object with `revoked` (domains that were removed) and `notFound` (domains not found).
   */
  public revokeRoutes(peerId: string, domains: readonly string[]): RevokeRoutesResult {
    const revoked: string[] = [];
    const notFound: string[] = [];
    const domainSet = new Set(domains);

    const peerRoutes = this.localRoutes.get(peerId);
    if (peerRoutes === undefined) {
      return { revoked: [], notFound: [...domains] };
    }

    const remaining: FederatedRouteRegistration[] = [];
    for (const route of peerRoutes) {
      if (domainSet.has(route.domain)) {
        revoked.push(route.domain);
      } else {
        remaining.push(route);
      }
    }

    for (const domain of domains) {
      if (!revoked.includes(domain)) {
        notFound.push(domain);
      }
    }

    if (remaining.length > 0) {
      this.localRoutes.set(peerId, remaining);
    } else {
      this.localRoutes.delete(peerId);
    }

    return { revoked, notFound };
  }

  /**
   * Moves all routes for a peer into the degraded state.
   *
   * Routes are removed from active candidate lists but preserved for
   * potential restoration. Each degraded entry receives a new generation
   * marker.
   *
   * @param peerId - The peer whose routes to degrade.
   */
  public setDegraded(peerId: string): void {
    const peerRoutes = this.localRoutes.get(peerId);
    if (peerRoutes === undefined) {
      return;
    }

    if (this.degradedRoutes.has(peerId)) {
      return;
    }

    this.routeGenerationCounter += 1;
    this.degradedRoutes.set(peerId, {
      routes: peerRoutes,
      degradedAt: Date.now(),
      generation: createVerserRouteGeneration({
        generationId: `gen-${this.routeGenerationCounter}`,
        sessionId: peerId,
      }),
    });

    this.localRoutes.delete(peerId);
  }

  /**
   * Restores degraded routes for a peer back to active state.
   *
   * The restored routes receive a new generation marker so downstream
   * consumers can distinguish the restored route from stale visibility.
   *
   * @param peerId - The peer whose routes to restore.
   * @returns `true` if routes were restored; `false` if no degraded routes existed.
   */
  public restoreRoutes(peerId: string): boolean {
    const degraded = this.degradedRoutes.get(peerId);
    if (degraded === undefined) {
      return false;
    }

    this.routeGenerationCounter += 1;
    this.localRoutes.set(
      peerId,
      degraded.routes.map((route) => createFederatedRouteRegistration({ ...route })),
    );

    this.degradedRoutes.delete(peerId);
    return true;
  }

  /**
   * Returns the generation metadata for a route, or `undefined` if the route
   * does not exist or is not degraded.
   *
   * @param peerId - The peer ID to check.
   * @param domain - The domain to look up.
   */
  public getRouteGeneration(peerId: string, domain: string): VerserRouteGeneration | undefined {
    const degraded = this.degradedRoutes.get(peerId);
    if (degraded !== undefined) {
      const match = degraded.routes.find((r) => r.domain === domain);
      if (match !== undefined) {
        return degraded.generation;
      }
    }

    return undefined;
  }

  /**
   * Returns the current degraded generation counter value.
   */
  public get currentGeneration(): number {
    return this.routeGenerationCounter;
  }

  /**
   * Returns whether a peer has degraded routes.
   *
   * @param peerId - The peer to check.
   */
  public hasDegradedRoutes(peerId: string): boolean {
    return this.degradedRoutes.has(peerId);
  }

  /**
   * Returns whether any degraded routes exist.
   */
  public hasAnyDegradedRoutes(): boolean {
    return this.degradedRoutes.size > 0;
  }

  /**
   * Returns all currently degraded route entries.
   */
  public getDegradedEntries(): ReadonlyMap<string, DegradedRouteEntry> {
    return this.degradedRoutes;
  }

  /**
   * Gets the current degraded routes as broker-visible route records.
   *
   * Degraded routes are still visible in the broker snapshot so Brokers
   * know about their existence, but requests will fail fast.
   */
  public getDegradedBrokerRoutes(): RoutedDomainRegistration[] {
    const result: RoutedDomainRegistration[] = [];
    for (const [, entry] of this.degradedRoutes) {
      for (const route of entry.routes) {
        result.push({ targetId: route.targetId, domain: route.domain });
      }
    }
    return result;
  }

  /**
   * Gets the degraded broker-visible route domains for a specific peer.
   *
   * @param peerId - The peer whose degraded routes to retrieve.
   * @returns Array of route records (targetId, domain) for the peer's degraded routes.
   */
  public getDegradedBrokerRoutesForPeer(peerId: string): RoutedDomainRegistration[] {
    const entry = this.degradedRoutes.get(peerId);
    if (entry === undefined) {
      return [];
    }
    return entry.routes.map((route) => ({
      targetId: route.targetId,
      domain: route.domain,
    }));
  }

  /**
   * Removes degraded routes that have exceeded the specified timeout.
   *
   * @param now - The current time in milliseconds (e.g. `Date.now()`).
   * @param timeoutMs - The timeout in milliseconds.
   * @returns Summary of expired peer routes removed.
   */
  public removeExpiredDegradedRoutes(now: number, timeoutMs: number): RemoveExpiredDegradedResult {
    const expiredPeers: string[] = [];
    let expiredRoutes = 0;
    const expiredRouteEntries: { peerId: string; domain: string }[] = [];

    for (const [peerId, entry] of this.degradedRoutes) {
      if (now - entry.degradedAt >= timeoutMs) {
        expiredPeers.push(peerId);
        expiredRoutes += entry.routes.length;
        for (const route of entry.routes) {
          expiredRouteEntries.push({ peerId, domain: route.domain });
        }
      }
    }

    for (const peerId of expiredPeers) {
      this.degradedRoutes.delete(peerId);
    }

    return { expiredPeers, expiredRoutes, expiredRouteEntries };
  }

  public getBrokerRoutes(): RoutedDomainRegistration[] {
    const active = this.getSelectedCandidates().map((candidate) => ({
      targetId: candidate.route.targetId,
      domain: candidate.route.domain,
    }));
    const degraded = this.getDegradedBrokerRoutes();
    // Merge, preferring active routes (non-degraded entries first)
    const seen = new Set<string>();
    const merged: RoutedDomainRegistration[] = [];
    for (const route of [...active, ...degraded]) {
      const key = `${route.targetId}\u0000${route.domain}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(route);
      }
    }
    return merged;
  }

  public getCandidates(targetId?: string, domain?: string): FederatedRouteRegistration[] {
    return this.getActiveCandidates()
      .filter(
        (candidate) =>
          (targetId === undefined || candidate.route.targetId === targetId) &&
          (domain === undefined || candidate.route.domain === domain),
      )
      .sort(compareCandidates)
      .map((candidate) => candidate.route);
  }

  public getFederatedRoutesForExport(peerHostId?: string): FederatedRouteRegistration[] {
    return this.getSelectedCandidates()
      .filter(
        (candidate) =>
          peerHostId === undefined ||
          (candidate.route.originHostId !== peerHostId &&
            !candidate.route.viaHostIds.includes(peerHostId)),
      )
      .filter((candidate) => candidate.route.hopCount + 1 <= this.options.maxFederationHopCount)
      .map((candidate) =>
        createFederatedRouteRegistration({
          ...candidate.route,
          nextHopHostId: this.options.hostId,
          hopCount: candidate.route.hopCount + 1,
          viaHostIds: appendHostId(candidate.route.viaHostIds, this.options.hostId),
          source: candidate.route.source,
        }),
      );
  }

  private getImportedRouteRejection(route: FederatedRouteRegistration): VerserError | undefined {
    if (isFederatedRouteLoop(route, this.options.hostId)) {
      return createVerserError('route-loop', 'Federated route would revisit this Host', {
        targetId: route.targetId,
        domain: route.domain,
        hostId: this.options.hostId,
      });
    }
    if (exceedsFederatedRouteHopLimit(route, this.options.maxFederationHopCount)) {
      return createVerserError('route-loop', 'Federated route exceeds maximum hop count', {
        targetId: route.targetId,
        domain: route.domain,
        hopCount: route.hopCount,
        maxHopCount: this.options.maxFederationHopCount,
      });
    }

    return undefined;
  }

  private getSelectedCandidates(): StoredRouteCandidate[] {
    return selectCandidates(this.getActiveCandidates());
  }

  private getLocalCandidates(): StoredRouteCandidate[] {
    const candidates: StoredRouteCandidate[] = [];
    for (const [ownerId, routes] of this.localRoutes) {
      candidates.push(...routes.map((route) => ({ ownerId, route })));
    }

    return candidates;
  }

  /**
   * Returns all active (non-degraded) candidates from local and imported routes.
   */
  private getActiveCandidates(): StoredRouteCandidate[] {
    const candidates = this.getLocalCandidates();
    for (const [ownerId, routes] of this.importedRoutes) {
      candidates.push(...routes.map((route) => ({ ownerId, route })));
    }

    return candidates;
  }
}

export function createHostRouteRegistry(options: {
  readonly hostId?: string;
  readonly maxFederationHopCount?: number;
}): HostRouteRegistry {
  const hostId = createVerserHostId(options.hostId ?? 'host-local');
  const maxFederationHopCount = options.maxFederationHopCount ?? 8;
  if (!Number.isInteger(maxFederationHopCount) || maxFederationHopCount < 0) {
    throw createVerserError('protocol-error', 'maxFederationHopCount must be non-negative', {
      maxFederationHopCount,
    });
  }

  return new HostRouteRegistry({ hostId, maxFederationHopCount });
}

function selectCandidates(candidates: StoredRouteCandidate[]): StoredRouteCandidate[] {
  const selected = new Map<string, StoredRouteCandidate>();

  for (const candidate of candidates.sort(compareCandidates)) {
    const key = routeIdentity(candidate.route);
    if (!selected.has(key)) {
      selected.set(key, candidate);
    }
  }

  return [...selected.values()].sort(compareCandidates);
}

function appendHostId(hostIds: readonly string[], hostId: string): readonly string[] {
  return hostIds.includes(hostId) ? hostIds : [...hostIds, hostId];
}

function routeIdentity(route: RoutedDomainRegistration): string {
  return `${route.targetId}\u0000${route.domain}`;
}

function routeSetKey(routes: readonly FederatedRouteRegistration[]): string {
  return JSON.stringify(routes.map(routeFingerprint).sort());
}

function routeFingerprint(route: FederatedRouteRegistration): string {
  return [
    route.targetId,
    route.domain,
    route.originHostId,
    route.nextHopHostId,
    String(route.hopCount),
    route.viaHostIds.join(','),
    route.source,
  ].join('\u0000');
}

function compareCandidates(left: StoredRouteCandidate, right: StoredRouteCandidate): number {
  const sourcePriority = sourceRank(left.route.source) - sourceRank(right.route.source);
  if (sourcePriority !== 0) {
    return sourcePriority;
  }

  return (
    left.route.hopCount - right.route.hopCount ||
    left.route.targetId.localeCompare(right.route.targetId) ||
    left.route.domain.localeCompare(right.route.domain) ||
    left.route.nextHopHostId.localeCompare(right.route.nextHopHostId) ||
    left.ownerId.localeCompare(right.ownerId)
  );
}

function sourceRank(source: FederatedRouteRegistration['source']): number {
  return source === 'local' ? 0 : 1;
}
