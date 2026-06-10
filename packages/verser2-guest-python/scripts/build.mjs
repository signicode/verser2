import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(packageDirectory, '..', '..');
const distDirectory = resolve(packageDirectory, 'dist');

rmSync(distDirectory, { recursive: true, force: true });
mkdirSync(distDirectory, { recursive: true });

writeFileSync(
  resolve(distDirectory, 'index.js'),
  [
    "'use strict';",
    '',
    "exports.VERSER2_GUEST_PYTHON_PACKAGE_NAME = '@signicode/verser2-guest-python';",
    "exports.PYTHON_DISTRIBUTION_NAME = 'verser2-guest-python';",
    '',
  ].join('\n'),
  'utf8',
);

writeFileSync(
  resolve(distDirectory, 'index.d.ts'),
  [
    "export declare const VERSER2_GUEST_PYTHON_PACKAGE_NAME = '@signicode/verser2-guest-python';",
    "export declare const PYTHON_DISTRIBUTION_NAME = 'verser2-guest-python';",
    '',
  ].join('\n'),
  'utf8',
);

copyFileSync(resolve(repositoryDirectory, 'LICENSE'), resolve(distDirectory, 'LICENSE'));
