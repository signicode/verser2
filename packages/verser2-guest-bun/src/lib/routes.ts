import type {
  VerserBunRouteMethod,
  VerserBunRouteValue,
  VerserBunRoutes,
  VerserBunRoutesPerMethod,
} from './types';

const VERSER_BUN_METHODS: readonly VerserBunRouteMethod[] = [
  'ACL',
  'BIND',
  'CHECKOUT',
  'CONNECT',
  'COPY',
  'DELETE',
  'GET',
  'HEAD',
  'LINK',
  'LOCK',
  'M-SEARCH',
  'MERGE',
  'MKACTIVITY',
  'MKCOL',
  'MKREDIRECTREF',
  'MKWORKSPACE',
  'MOVE',
  'OPTIONS',
  'PATCH',
  'POST',
  'PROPFIND',
  'PROPPATCH',
  'PURGE',
  'PUT',
  'REBIND',
  'REPORT',
  'SEARCH',
  'TRACE',
  'UNBIND',
  'UNLINK',
  'UNLOCK',
];

interface VerserBunMatchedRoute {
  readonly value?: VerserBunRouteValue;
  readonly params: Record<string, string>;
  readonly allow?: string;
}

const splitRoutePath = (path: string): readonly string[] => {
  if (path === '/') {
    return [];
  }

  return path.split('/').filter((segment) => segment.length > 0);
};

const isPotentialRouteMethodObject = (value: unknown): value is VerserBunRoutesPerMethod => {
  if (value === null || typeof value !== 'object' || value instanceof Response) {
    return false;
  }

  const routeMethodObject = value as Record<string, unknown>;
  const keys = Object.keys(routeMethodObject);

  return (
    keys.length > 0 &&
    keys.every((methodName) => VERSER_BUN_METHODS.includes(methodName as VerserBunRouteMethod))
  );
};

const isWildcardRoutePath = (routePath: string): boolean => {
  return routePath === '*' || routePath === '/*' || routePath.endsWith('/*');
};

const tryMatchExactRoute = (
  routePath: string,
  requestPath: string,
): { params: Record<string, string> } | undefined => {
  if (routePath === requestPath) {
    return { params: {} };
  }

  return undefined;
};

const tryMatchParamRoute = (
  routePath: string,
  requestPath: string,
): { params: Record<string, string> } | undefined => {
  const routeParts = splitRoutePath(routePath);
  const requestParts = splitRoutePath(requestPath);

  if (routeParts.length !== requestParts.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

  for (let index = 0; index < routeParts.length; index++) {
    const routePart = routeParts[index];
    const requestPart = requestParts[index] ?? '';

    if (routePart.startsWith(':')) {
      const paramName = routePart.slice(1);
      try {
        params[paramName] = decodeURIComponent(requestPart);
      } catch {
        params[paramName] = requestPart;
      }
      continue;
    }

    if (routePart !== requestPart) {
      return undefined;
    }
  }

  return { params };
};

const tryMatchWildcardRoute = (
  routePath: string,
  requestPath: string,
): { params: Record<string, string> } | undefined => {
  if (routePath === '*') {
    return { params: { '*': requestPath === '/' ? '' : requestPath.slice(1) } };
  }

  const routeParts = splitRoutePath(routePath);
  if (routeParts.length === 0 || routeParts[routeParts.length - 1] !== '*') {
    return undefined;
  }

  const prefixParts = routeParts.slice(0, routeParts.length - 1);
  const requestParts = splitRoutePath(requestPath);

  if (prefixParts.length > requestParts.length) {
    return undefined;
  }

  for (let index = 0; index < prefixParts.length; index++) {
    if (prefixParts[index] !== requestParts[index]) {
      return undefined;
    }
  }

  const wildcardParts = requestParts.slice(prefixParts.length);
  const wildcardValue = wildcardParts.join('/');

  return { params: { '*': wildcardValue } };
};

const resolveRouteMethodValues = (route: VerserBunRoutesPerMethod): string[] => {
  const allow: string[] = [];

  for (const method of VERSER_BUN_METHODS) {
    if (route[method] !== undefined) {
      allow.push(method);
    }
  }

  return allow;
};

export const resolveRoute = (
  routes: VerserBunRoutes,
  requestPath: string,
  requestMethod: string,
): VerserBunMatchedRoute | undefined => {
  const method = requestMethod.toUpperCase();

  const exactEntries: Array<[string, VerserBunRouteValue | VerserBunRoutesPerMethod]> = [];
  const paramEntries: Array<[string, VerserBunRouteValue | VerserBunRoutesPerMethod]> = [];
  const wildcardEntries: Array<[string, VerserBunRouteValue | VerserBunRoutesPerMethod]> = [];

  for (const entry of Object.entries(routes) as Array<
    [string, VerserBunRouteValue | VerserBunRoutesPerMethod]
  >) {
    const [routePath] = entry;
    if (routePath.includes(':') || routePath.includes('*')) {
      if (isWildcardRoutePath(routePath)) {
        wildcardEntries.push(entry);
        continue;
      }

      paramEntries.push(entry);
      continue;
    }

    exactEntries.push(entry);
  }

  const resolveMethodRoute = (
    routeValue: VerserBunRoutesPerMethod,
    params: Record<string, string>,
  ): VerserBunMatchedRoute | undefined => {
    const routeMethod = routeValue[method as VerserBunRouteMethod];
    if (routeMethod !== undefined) {
      return {
        value: routeMethod,
        params,
      };
    }

    const allow = resolveRouteMethodValues(routeValue);
    if (allow.length === 0) {
      return undefined;
    }

    return {
      params,
      allow: allow.join(', '),
    };
  };

  for (const [routePath, routeValue] of exactEntries) {
    const match = tryMatchExactRoute(routePath, requestPath);
    if (match === undefined) {
      continue;
    }

    if (isPotentialRouteMethodObject(routeValue)) {
      const resolved = resolveMethodRoute(routeValue, match.params);
      if (resolved !== undefined) {
        return resolved;
      }
      continue;
    }

    return {
      value: routeValue,
      params: match.params,
    };
  }

  for (const [routePath, routeValue] of paramEntries) {
    const match = tryMatchParamRoute(routePath, requestPath);
    if (match === undefined) {
      continue;
    }

    if (isPotentialRouteMethodObject(routeValue)) {
      const resolved = resolveMethodRoute(routeValue, match.params);
      if (resolved !== undefined) {
        return resolved;
      }
      continue;
    }

    return {
      value: routeValue,
      params: match.params,
    };
  }

  for (const [routePath, routeValue] of wildcardEntries) {
    const match = tryMatchWildcardRoute(routePath, requestPath);
    if (match === undefined) {
      continue;
    }

    if (isPotentialRouteMethodObject(routeValue)) {
      const resolved = resolveMethodRoute(routeValue, match.params);
      if (resolved !== undefined) {
        return resolved;
      }
      continue;
    }

    return {
      value: routeValue,
      params: match.params,
    };
  }

  return undefined;
};
