import { createHash } from 'node:crypto';

import { DEVELOPMENT_CERTIFICATE, DEVELOPMENT_PRIVATE_KEY } from '../development-certificate';
import type { DevelopmentTlsCertificate } from './types';

export function createDevelopmentTlsCertificate(): DevelopmentTlsCertificate {
  return {
    cert: DEVELOPMENT_CERTIFICATE,
    key: DEVELOPMENT_PRIVATE_KEY,
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
