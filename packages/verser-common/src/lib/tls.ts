import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import type {
  VerserCertificateIdentity,
  VerserClientTlsOptions,
  VerserHostClientAuthTlsOptions,
  VerserHostTlsOptions,
} from './types';

export function normalizeServerTlsOptions(options?: VerserHostTlsOptions): {
  cert?: string;
  key?: string;
  pfx?: Buffer;
  passphrase?: string;
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
  const hasPfx = options.pfx !== undefined;
  const hasPfxFile = options.pfxFile !== undefined;

  const identityModes =
    Number(hasCert || hasKey) +
    Number(hasCertFile || hasKeyFile) +
    Number(hasPfx) +
    Number(hasPfxFile);

  if (identityModes > 1) {
    throw new Error(
      'Ambiguous TLS config: use one of `tls.cert` + `tls.key`, `tls.certFile` + `tls.keyFile`, `tls.pfx`, or `tls.pfxFile`.',
    );
  }

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

  if (hasPfx) {
    return {
      pfx: options.pfx,
      passphrase: options.passphrase,
    };
  }

  if (hasPfxFile) {
    return {
      pfx: readFileSync(options.pfxFile),
      passphrase: options.passphrase,
    };
  }

  if (hasCert) {
    if (options.cert === undefined || options.key === undefined) {
      throw new Error('Host TLS config must include both `tls.cert` and `tls.key`.');
    }
    return {
      cert: options.cert,
      key: options.key,
      passphrase: options.passphrase,
    };
  }

  if (hasCertFile) {
    if (options.certFile === undefined || options.keyFile === undefined) {
      throw new Error('Host TLS config must include both `tls.certFile` and `tls.keyFile`.');
    }

    if (process.platform !== 'win32') {
      const keyStat = statSync(options.keyFile);
      const keyMode = keyStat.mode & 0o777;
      if (keyMode !== 0o600) {
        throw new Error(
          `Insecure TLS key permissions for ${options.keyFile}: mode 0${keyMode.toString(8).padStart(3, '0')}; expected 0600. Run: chmod 0600 ${options.keyFile}`,
        );
      }
    }

    return {
      cert: readFileSync(options.certFile, 'utf8'),
      key: readFileSync(options.keyFile, 'utf8'),
      passphrase: options.passphrase,
    };
  }

  throw new Error(
    'Host TLS config requires either `tls.cert`/`tls.key` or `tls.certFile`/`tls.keyFile`.',
  );
}

export function normalizeClientTlsOptions(
  options?: VerserClientTlsOptions,
): { ca?: string; cert?: string; key?: string; pfx?: Buffer; passphrase?: string } | undefined {
  if (options === undefined) {
    return undefined;
  }

  const hasCa = options.ca !== undefined;
  const hasCaFile = options.caFile !== undefined;
  const hasCert = options.cert !== undefined;
  const hasKey = options.key !== undefined;
  const hasCertFile = options.certFile !== undefined;
  const hasKeyFile = options.keyFile !== undefined;
  const hasPfx = options.pfx !== undefined;
  const hasPfxFile = options.pfxFile !== undefined;

  const identityModes =
    Number(hasCert || hasKey) +
    Number(hasCertFile || hasKeyFile) +
    Number(hasPfx) +
    Number(hasPfxFile);

  if (identityModes > 1) {
    throw new Error(
      'Ambiguous TLS client identity config: use one of `tls.cert` + `tls.key`, `tls.certFile` + `tls.keyFile`, `tls.pfx`, or `tls.pfxFile`.',
    );
  }

  if (hasCa && hasCaFile) {
    throw new Error('Ambiguous TLS trust config: use either `tls.ca` or `tls.caFile`, not both.');
  }

  if (hasCert !== hasKey) {
    throw new Error('Client TLS identity config must include both `tls.cert` and `tls.key`.');
  }

  if (hasCertFile !== hasKeyFile) {
    throw new Error(
      'Client TLS identity config must include both `tls.certFile` and `tls.keyFile`.',
    );
  }

  const ca = hasCaFile ? readFileSync(options.caFile, 'utf8') : options.ca;
  const normalized = {
    ...(ca === undefined ? {} : { ca }),
    passphrase: options.passphrase,
  };

  if (hasCert) {
    return {
      ...normalized,
      cert: options.cert,
      key: options.key,
    };
  }

  if (hasCertFile) {
    const certFile = options.certFile;
    const keyFile = options.keyFile;
    if (certFile === undefined || keyFile === undefined) {
      throw new Error(
        'Client TLS identity config must include both `tls.certFile` and `tls.keyFile`.',
      );
    }
    enforcePrivateKeyFilePermissions(keyFile);
    return {
      ...normalized,
      cert: readFileSync(certFile, 'utf8'),
      key: readFileSync(keyFile, 'utf8'),
    };
  }

  if (hasPfx) {
    return {
      ...normalized,
      pfx: options.pfx,
    };
  }

  if (hasPfxFile) {
    return {
      ...normalized,
      pfx: readFileSync(options.pfxFile),
    };
  }

  if (hasCa || hasCaFile) {
    return { ca };
  }

  return undefined;
}

export function normalizeHostClientAuthTlsOptions(options?: VerserHostClientAuthTlsOptions):
  | {
      ca: string;
      requestCert: true;
      rejectUnauthorized: true;
      knownExtensionOids: readonly string[];
    }
  | undefined {
  if (options === undefined) {
    return undefined;
  }

  const hasCa = options.ca !== undefined;
  const hasCaFile = options.caFile !== undefined;

  if (hasCa && hasCaFile) {
    throw new Error(
      'Ambiguous Host client-auth trust config: use either `tls.clientAuth.ca` or `tls.clientAuth.caFile`, not both.',
    );
  }

  if (!hasCa && !hasCaFile) {
    return undefined;
  }

  return {
    ca: hasCaFile ? readFileSync(options.caFile, 'utf8') : (options.ca ?? ''),
    requestCert: true,
    rejectUnauthorized: true,
    knownExtensionOids: options.knownExtensionOids ?? [],
  };
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

interface PeerCertificateLike {
  readonly subject?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly issuer?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly subjectaltname?: string;
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly fingerprint256?: string;
  readonly raw?: Buffer;
  readonly customExtensions?: Readonly<Record<string, string | undefined>>;
}

export function extractCertificateIdentity(
  certificate: PeerCertificateLike | undefined,
  knownExtensionOids: readonly string[] = [],
): VerserCertificateIdentity | undefined {
  if (certificate === undefined || certificate.subject === undefined) {
    return undefined;
  }

  const raw = certificate.raw;
  const fingerprint256 = certificate.fingerprint256
    ? `sha256:${certificate.fingerprint256.replace(/:/g, '').toLowerCase()}`
    : raw === undefined
      ? ''
      : `sha256:${createHash('sha256').update(raw).digest('hex')}`;

  return {
    commonName: firstCertificateNameValue(certificate.subject.CN),
    dnsNames: parseSubjectAlternativeNames(certificate.subjectaltname, 'DNS'),
    uriNames: parseSubjectAlternativeNames(certificate.subjectaltname, 'URI'),
    fingerprint256,
    subject: summarizeCertificateName(certificate.subject),
    issuer: summarizeCertificateName(certificate.issuer),
    validFrom: certificate.valid_from ?? '',
    validTo: certificate.valid_to ?? '',
    raw: raw?.toString('base64'),
    customExtensions: selectKnownExtensions(certificate.customExtensions, knownExtensionOids),
  };
}

function enforcePrivateKeyFilePermissions(keyFile: string): void {
  if (process.platform === 'win32') {
    return;
  }

  const keyStat = statSync(keyFile);
  const keyMode = keyStat.mode & 0o777;
  if (keyMode !== 0o600) {
    throw new Error(
      `Insecure TLS key permissions for ${keyFile}: mode 0${keyMode.toString(8).padStart(3, '0')}; expected 0600. Run: chmod 0600 ${keyFile}`,
    );
  }
}

function parseSubjectAlternativeNames(value: string | undefined, prefix: 'DNS' | 'URI'): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(/,\s*/)
    .filter((entry) => entry.startsWith(`${prefix}:`))
    .map((entry) => entry.slice(prefix.length + 1));
}

function summarizeCertificateName(
  value: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
): string {
  if (value === undefined) {
    return '';
  }

  return Object.entries(value)
    .filter((entry): entry is [string, string | readonly string[]] => entry[1] !== undefined)
    .map(([key, entryValue]) => `${key}=${formatCertificateNameValue(entryValue)}`)
    .join(', ');
}

function firstCertificateNameValue(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (typeof value === 'string' || value === undefined) {
    return value;
  }

  return value[0];
}

function formatCertificateNameValue(value: string | readonly string[]): string {
  if (typeof value === 'string') {
    return value;
  }

  return value.join(',');
}

function selectKnownExtensions(
  extensions: Readonly<Record<string, string | undefined>> | undefined,
  knownExtensionOids: readonly string[],
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};

  if (extensions === undefined) {
    return selected;
  }

  for (const oid of knownExtensionOids) {
    const value = extensions[oid];
    if (value !== undefined) {
      selected[oid] = value;
    }
  }

  return selected;
}
