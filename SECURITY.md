# Security Policy

## Supported versions

Until the first public stable release, security fixes target the current `main` branch and the most recent tagged prerelease or release line when practical.

After public release, maintainers will document supported release lines here when support policy changes.

## Reporting a vulnerability

Please do not report suspected vulnerabilities in public issues or pull requests.

Use GitHub private vulnerability reporting when it is enabled for the repository. If that is not available, contact the maintainers through the repository owner’s published security contact channel and include:

- affected package and version or commit SHA;
- reproduction steps or proof of concept;
- expected impact;
- whether credentials, certificates, or private infrastructure are involved.

Maintainers will acknowledge reports as soon as practical, investigate privately, and coordinate disclosure timing with the reporter when a vulnerability is confirmed.

## Scope

In scope:

- vulnerabilities in Verser2 Host, Guest, Broker, package, release, or documentation behavior;
- accidental credential exposure in repository files or release workflows;
- package publishing or supply-chain weaknesses that could affect consumers.

Out of scope:

- vulnerabilities caused solely by downstream application authorization or routing policy;
- unsupported roadmap runtimes or transports that are not implemented;
- public gateway policy gaps in applications that embed Verser2.

## Test fixtures

TLS materials generated under `test/fixtures/generated-tls/` are local test fixtures. They are not production credentials and should not be reused outside the test suite.
