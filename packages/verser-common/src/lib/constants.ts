export const VERSER_COMMON_PACKAGE_NAME = '@signicode/verser-common';

export const VERSER_LIFECYCLE_EVENTS = {
  connected: 'connected',
  disconnected: 'disconnected',
  registered: 'registered',
  routeAdvertised: 'route-advertised',
  requestStarted: 'request-started',
  requestCompleted: 'request-completed',
  error: 'error',
  closed: 'closed',
} as const;

export const VERSER_ENVELOPE_VERSION = 1;

export const VERSER_ENVELOPE_PREFIX_BYTES = 6;

export const DEFAULT_MAX_ENVELOPE_METADATA_BYTES = 64 * 1024;

export const VERSER_ENVELOPE_TYPES = {
  request: 1,
  response: 2,
  error: 3,
} as const;
