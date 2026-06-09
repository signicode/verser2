const {
  chmodSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} = require('node:fs');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const generatedPath = path.join(__dirname, '..', 'fixtures', 'generated-tls');
const generatedLockPath = path.join(__dirname, '..', 'fixtures', 'generated-tls.lock');

const trustedCertFilename = 'localhost-trusted-cert.pem';
const trustedKeyFilename = 'localhost-trusted-key.pem';
const untrustedCertFilename = 'localhost-untrusted-cert.pem';
const untrustedKeyFilename = 'localhost-untrusted-key.pem';
const encryptedCertFilename = 'localhost-encrypted-cert.pem';
const encryptedKeyFilename = 'localhost-encrypted-key.pem';
const encryptedPassphrase = 'verser-local-pass';

function runOpenSslCommand(args) {
  try {
    execFileSync('openssl', args, { encoding: 'utf8', stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'openssl is required for TLS fixture generation but was not found. Install openssl and ensure it is on PATH.',
      );
    }
    throw error;
  }
}

function createOpenSslConfig(stagingDirectory, commonName, subjectAltNames) {
  const configPath = path.join(stagingDirectory, 'openssl.cnf');
  const config = `\
[req]
default_bits = 2048
distinguished_name = req_distinguished_name
prompt = no
x509_extensions = v3_req

[req_distinguished_name]
CN = ${commonName}

[v3_req]
subjectAltName = ${subjectAltNames}
`;

  writeFileSync(configPath, config, 'utf8');
  return configPath;
}

function generateCertificatePair(
  certFilename,
  keyFilename,
  commonName,
  subjectAltNames,
  passphrase,
) {
  const stagingDirectory = path.join(
    os.tmpdir(),
    `verser-tls-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(stagingDirectory, { recursive: true });

  const certPath = path.join(stagingDirectory, certFilename);
  const keyPath = path.join(stagingDirectory, keyFilename);
  const configPath = createOpenSslConfig(stagingDirectory, commonName, subjectAltNames);

  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '365',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    `/CN=${commonName}`,
    '-config',
    configPath,
    '-extensions',
    'v3_req',
  ];

  if (passphrase !== undefined) {
    args.splice(args.indexOf('-nodes'), 1);
    args.push('-passout', `pass:${passphrase}`);
    runOpenSslCommand(args);
    chmodSync(keyPath, 0o600);
    return { certPath, keyPath, stagingDirectory };
  }

  runOpenSslCommand(args);
  chmodSync(keyPath, 0o600);

  return { certPath, keyPath, stagingDirectory };
}

function generateEncryptedPair(certFilename, keyFilename, commonName, passphrase) {
  const stagingDirectory = path.join(
    os.tmpdir(),
    `verser-tls-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(stagingDirectory, { recursive: true });

  const certPath = path.join(stagingDirectory, certFilename);
  const keyPath = path.join(stagingDirectory, keyFilename);
  const configPath = createOpenSslConfig(
    stagingDirectory,
    commonName,
    `DNS:${commonName},IP:127.0.0.1`,
  );

  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '365',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    `/CN=${commonName}`,
    '-config',
    configPath,
    '-extensions',
    'v3_req',
    '-passout',
    `pass:${passphrase}`,
  ];

  runOpenSslCommand(args);
  chmodSync(keyPath, 0o600);

  return { certPath, keyPath, stagingDirectory };
}

function copyGeneratedFixture(source, fileName) {
  const destination = path.join(generatedPath, fileName);
  renameSync(source, destination);
}

function generatedFixturePaths() {
  return {
    trustedCertPath: path.join(generatedPath, trustedCertFilename),
    trustedKeyPath: path.join(generatedPath, trustedKeyFilename),
    untrustedCertPath: path.join(generatedPath, untrustedCertFilename),
    untrustedKeyPath: path.join(generatedPath, untrustedKeyFilename),
    encryptedCertPath: path.join(generatedPath, encryptedCertFilename),
    encryptedKeyPath: path.join(generatedPath, encryptedKeyFilename),
  };
}

function allFixturesExist(paths) {
  return (
    existsSync(paths.trustedCertPath) &&
    existsSync(paths.trustedKeyPath) &&
    existsSync(paths.untrustedCertPath) &&
    existsSync(paths.untrustedKeyPath) &&
    existsSync(paths.encryptedCertPath) &&
    existsSync(paths.encryptedKeyPath)
  );
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForConcurrentGenerator(paths) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (allFixturesExist(paths)) {
      return;
    }
    sleepSync(50);
  }

  throw new Error('Timed out waiting for TLS fixture generation lock.');
}

function ensureFixtures() {
  const paths = generatedFixturePaths();

  if (allFixturesExist(paths)) {
    return {
      ...paths,
      encryptedPassphrase,
    };
  }

  mkdirSync(path.dirname(generatedLockPath), { recursive: true });

  try {
    mkdirSync(generatedLockPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      waitForConcurrentGenerator(paths);
      return {
        ...paths,
        encryptedPassphrase,
      };
    }
    throw error;
  }

  try {
    if (!existsSync(generatedPath)) {
      mkdirSync(generatedPath, { recursive: true });
    }

    const generated = [];

    const trusted = generateCertificatePair(
      trustedCertFilename,
      trustedKeyFilename,
      'localhost',
      'DNS:localhost,IP:127.0.0.1',
    );
    const untrusted = generateCertificatePair(
      untrustedCertFilename,
      untrustedKeyFilename,
      'wrong.local',
      'DNS:wrong.local,IP:192.168.0.1',
    );
    const encrypted = generateEncryptedPair(
      encryptedCertFilename,
      encryptedKeyFilename,
      'localhost',
      encryptedPassphrase,
    );

    generated.push(
      [trusted.certPath, trustedCertFilename],
      [trusted.keyPath, trustedKeyFilename],
      trusted,
    );
    generated.push(
      [untrusted.certPath, untrustedCertFilename],
      [untrusted.keyPath, untrustedKeyFilename],
      untrusted,
    );
    generated.push(
      [encrypted.certPath, encryptedCertFilename],
      [encrypted.keyPath, encryptedKeyFilename],
      encrypted,
    );

    const stagingDirectories = new Set();
    for (const entry of generated) {
      if (entry.length === 2) {
        copyGeneratedFixture(entry[0], path.basename(entry[1]));
      } else {
        stagingDirectories.add(entry.stagingDirectory);
      }
    }

    for (const stagingDirectory of stagingDirectories) {
      rmSync(stagingDirectory, { force: true, recursive: true });
    }
  } finally {
    rmSync(generatedLockPath, { force: true, recursive: true });
  }

  return {
    ...paths,
    encryptedPassphrase,
  };
}

const fixtures = ensureFixtures();

module.exports = {
  trusted: {
    certificate: readFileSync(fixtures.trustedCertPath, 'utf8'),
    key: readFileSync(fixtures.trustedKeyPath, 'utf8'),
    certificatePath: fixtures.trustedCertPath,
    keyPath: fixtures.trustedKeyPath,
  },
  untrusted: {
    certificate: readFileSync(fixtures.untrustedCertPath, 'utf8'),
    key: readFileSync(fixtures.untrustedKeyPath, 'utf8'),
    certificatePath: fixtures.untrustedCertPath,
    keyPath: fixtures.untrustedKeyPath,
  },
  mismatched: {
    certificatePath: fixtures.untrustedCertPath,
    keyPath: fixtures.trustedKeyPath,
  },
  encrypted: {
    certificate: readFileSync(fixtures.encryptedCertPath, 'utf8'),
    key: readFileSync(fixtures.encryptedKeyPath, 'utf8'),
    certificatePath: fixtures.encryptedCertPath,
    keyPath: fixtures.encryptedKeyPath,
    passphrase: fixtures.encryptedPassphrase,
  },
};
