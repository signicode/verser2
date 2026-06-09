#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const packageDirectory = path.resolve(process.argv[2] ?? process.cwd());
const licensePath = path.join(packageDirectory, 'LICENSE');
const distDirectory = path.join(packageDirectory, 'dist');
const distLicensePath = path.join(distDirectory, 'LICENSE');

if (!fs.existsSync(licensePath)) {
  throw new Error(`Package license is missing: ${licensePath}`);
}

fs.mkdirSync(distDirectory, { recursive: true });
fs.copyFileSync(licensePath, distLicensePath);
