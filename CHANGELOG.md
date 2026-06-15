# Changelog

## v0.3.1 - Release workflow reliability

- Preserves staged-package dependency resolution in publish-job validation when validated build artifacts are reused.
- Shortens slow Bun and Python TLS integration paths to keep release validation faster.
- Carries forward native Python wheel and source distribution artifact publishing from the 0.3 release line.

## v0.3.0 - Python distribution artifacts

- Builds the Python Guest package as native Python wheel and source distribution artifacts.
- Publishes Python distribution artifacts through GitHub Actions and attaches tag builds to GitHub Releases.
- Reuses validated package build output in the publish workflow to avoid a second full build/stage cycle.

## v0.2.1 - Broker internal redirects

- Adds default-on internal `307`/`308` redirect following for Node Broker-driven request paths when the `Location` hostname exactly matches an advertised Verser2 route.
- Preserves redirected request method, headers, path/query, and replayable body bytes with configurable `maxInternalRedirects` and `internalRedirectReplayBufferBytes` limits.
- Keeps oversized or non-internal redirect responses client-visible and documents the `createFetch()` manual redirect default.

## v0.2.0 - Initial stable candidate

- Marks the first stable candidate release for Verser2 packages.
- Establishes the initial supported baseline for Host, Guest, and Broker APIs.
