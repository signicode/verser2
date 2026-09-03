/**
 * The package name for {@link https://www.npmjs.com/package/@signicode/verser2-host | `@signicode/verser2-host`}.
 *
 * @public
 */
export const VERSER2_HOST_PACKAGE_NAME = '@signicode/verser2-host';

/**
 * Default positive (allow) TTL in milliseconds for the hop-local federated
 * route authorization cache. `0` disables the allow cache.
 *
 * @public
 */
export const DEFAULT_ROUTE_AUTHORIZATION_CACHE_TTL_MS = 60_000;

/**
 * Computes the default negative (deny) authorization-cache TTL: one tenth of
 * the configured positive TTL, floored. A positive TTL of `0` therefore also
 * defaults the deny cache to `0` (disabled).
 *
 * @public
 */
export function defaultRouteAuthorizationNegativeCacheTtlMs(allowTtlMs: number): number {
  return Math.floor(allowTtlMs / 10);
}
