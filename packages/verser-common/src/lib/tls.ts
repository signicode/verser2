import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { VerserClientTlsOptions, VerserHostTlsOptions } from './types';

function readTextFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

export function normalizeServerTlsOptions(options?: VerserHostTlsOptions): {
  cert: string;
  key: string;
} {
  if (options === undefined) {
    throw new Error(
      'Host TLS options are required under `tls` with `cert`/`key` or `certFile`/`keyFile`.',
    );
  }

  const hasCert = options.cert !== undefined;
  const hasKey = options.key !== undefined;
  const hasCertFile = options.certFile !== undefined;
  const hasKeyFile = options.keyFile !== undefined;

  if ((hasCert || hasKey) && (hasCertFile || hasKeyFile)) {
    throw new Error(
      'Ambiguous TLS config: use either `tls.cert` + `tls.key` or `tls.certFile` + `tls.keyFile`, not both.',
    );
  }

  if (hasCert !== hasKey) {
    throw new Error('Host TLS config must include both `tls.cert` and `tls.key`.');
  }

  if (hasCertFile !== hasKeyFile) {
    throw new Error('Host TLS config must include both `tls.certFile` and `tls.keyFile`.');
  }

  if (hasCert) {
    if (options.cert === undefined || options.key === undefined) {
      throw new Error('Host TLS config must include both `tls.cert` and `tls.key`.');
    }
    return { cert: options.cert, key: options.key };
  }

  if (hasCertFile) {
    if (options.certFile === undefined || options.keyFile === undefined) {
      throw new Error('Host TLS config must include both `tls.certFile` and `tls.keyFile`.');
    }

    return {
      cert: readTextFile(options.certFile),
      key: readTextFile(options.keyFile),
    };
  }

  throw new Error(
    'Host TLS config requires either `tls.cert`/`tls.key` or `tls.certFile`/`tls.keyFile`.',
  );
}

export function normalizeClientTlsOptions(
  options?: VerserClientTlsOptions,
): { ca: string } | undefined {
  if (options === undefined) {
    return undefined;
  }

  const hasCa = options.ca !== undefined;
  const hasCaFile = options.caFile !== undefined;

  if (hasCa && hasCaFile) {
    throw new Error('Ambiguous TLS trust config: use either `tls.ca` or `tls.caFile`, not both.');
  }

  if (hasCaFile) {
    return { ca: readTextFile(options.caFile) };
  }

  if (hasCa) {
    return { ca: options.ca };
  }

  return undefined;
}

export function getCertificateFingerprint(certificate: string): string {
  const normalizedCertificate = certificate.replace(
    /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g,
    '',
  );
  const certificateBytes = Buffer.from(normalizedCertificate, 'base64');
  return `sha256:${createHash('sha256').update(certificateBytes).digest('hex')}`;
}

export function verifyPinnedCertificate(
  certificate: string,
  expectedFingerprint: string,
): { valid: true } | { valid: false; reason: string } {
  if (getCertificateFingerprint(certificate) !== expectedFingerprint) {
    return { valid: false, reason: 'certificate fingerprint mismatch' };
  }

  return { valid: true };
}
