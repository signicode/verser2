import {
  type FederatedRouteRegistration,
  type RoutedDomainRegistration,
  type VerserError,
  type VerserHostId,
  createFederatedRouteRegistration,
  createRoutedDomainRegistration,
  createVerserError,
  createVerserHostId,
  exceedsFederatedRouteHopLimit,
  isFederatedRouteLoop,
} from '@signicode/verser-common';

interface StoredRouteCandidate {
  readonly ownerId: string;
  readonly route: FederatedRouteRegistration;
}

export interface HostRouteRegistryOptions {
  readonly hostId: VerserHostId;
  readonly maxFederationHopCount: number;
}

export interface ImportedRouteRejection {
  readonly route: FederatedRouteRegistration;
  readonly error: VerserError;
}

export class HostRouteRegistry {
  private readonly localRoutes = new Map<string, FederatedRouteRegistration[]>();

  private readonly importedRoutes = new Map<string, FederatedRouteRegistration[]>();

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
  ): ImportedRouteRejection[] {
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

    this.importedRoutes.set(upstreamId, accepted);
    return rejected;
  }

  public removeImportedRoutes(upstreamId: string): void {
    this.importedRoutes.delete(upstreamId);
  }

  public clear(): void {
    this.localRoutes.clear();
    this.importedRoutes.clear();
  }

  public getBrokerRoutes(): RoutedDomainRegistration[] {
    return this.getSelectedLocalCandidates().map((candidate) => ({
      targetId: candidate.route.targetId,
      domain: candidate.route.domain,
    }));
  }

  public getCandidates(targetId?: string, domain?: string): FederatedRouteRegistration[] {
    return this.getAllCandidates()
      .filter(
        (candidate) =>
          (targetId === undefined || candidate.route.targetId === targetId) &&
          (domain === undefined || candidate.route.domain === domain),
      )
      .sort(compareCandidates)
      .map((candidate) => candidate.route);
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

  private getSelectedLocalCandidates(): StoredRouteCandidate[] {
    const selected = new Map<string, StoredRouteCandidate>();

    for (const candidate of this.getLocalCandidates().sort(compareCandidates)) {
      const key = routeIdentity(candidate.route);
      if (!selected.has(key)) {
        selected.set(key, candidate);
      }
    }

    return [...selected.values()].sort(compareCandidates);
  }

  private getLocalCandidates(): StoredRouteCandidate[] {
    const candidates: StoredRouteCandidate[] = [];
    for (const [ownerId, routes] of this.localRoutes) {
      candidates.push(...routes.map((route) => ({ ownerId, route })));
    }

    return candidates;
  }

  private getAllCandidates(): StoredRouteCandidate[] {
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

function routeIdentity(route: RoutedDomainRegistration): string {
  return `${route.targetId}\u0000${route.domain}`;
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
