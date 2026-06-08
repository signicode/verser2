import type { VerserRoute } from './types';

export function resolveRouteForHostname(
  routes: readonly VerserRoute[],
  hostname: string,
): VerserRoute | undefined {
  return routes.find((route) => route.domain === hostname);
}
