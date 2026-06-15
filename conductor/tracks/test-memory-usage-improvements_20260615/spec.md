# Specification: Test and Memory Usage Improvements

## Overview

Improve the repository development and validation workflow for `verser2` by adding first-class support for bounded-resource test execution, shortening selected long-running tests through low-risk changes, documenting full and targeted validation commands, and adding guard coverage for flow control, backpressure, and memory/resource leak behavior.

This is a test infrastructure and quality track. It must preserve the existing Host/Guest/Broker behavior and HTTP semantics while making validation safer and easier to run during development and CI across Node, Bun, and Python-backed test paths.

## Track Type

Chore / test infrastructure.

## Functional Requirements

1. Bounded test execution
   - Add a first-class npm-accessible way to run the repository test suite with Node heap limits.
   - The bounded full-test target must use a 512 MiB Node old-space heap as the default target.
   - The bounded path should preserve the existing full validation flow: build packages, stage packages, then run the Node test suite.
   - Prefer a reusable script if it improves maintainability, diagnostics, focused-file support, timeout behavior, or cross-platform command handling.
   - Avoid applying unsafe low virtual-memory `ulimit` values to Node/npm wrappers.

2. Runtime-specific resource limits
   - Account for subprocesses spawned by repository tests, including Bun and Python/`uv` integration tests.
   - Provide clear timeout/resource-limit handling for Bun-backed test subprocesses where practical.
   - Provide clear timeout/resource-limit handling for Python/`uv` test subprocesses where practical, without applying unsafe Node/npm virtual-memory caps.
   - Ensure runtime-specific limits are documented with their constraints and do not make ordinary development validation brittle.

3. Low-risk long-test reductions
   - Identify and improve long-running tests using low-risk changes only.
   - Preserve existing coverage and assertions.
   - Good candidates include sequential package-consumer/package-pack loops, fixed waits that can be safely reduced, and timeout-heavy negative cases.
   - Do not perform a major test architecture rewrite in this track.

4. Flow-control, backpressure, and memory guard tests
   - Add focused tests that guard against unbounded buffering, memory growth, resource leaks, or blocked-stream regressions.
   - Cover at least one realistic slow-consumer/backpressure scenario.
   - Cover cleanup/resource behavior after an abort, stream failure, or backpressure cycle where practical.
   - Prefer deterministic assertions over fragile timing-only assertions.
   - Keep stress sizes bounded so the tests remain suitable for ordinary developer machines and CI.

5. Development documentation
   - Update repository development guidance to clearly explain:
     - full build and test commands,
     - focused/targeted test-file commands,
     - bounded-memory/resource test commands,
     - Node, Bun, and Python runtime limit behavior,
     - package validation commands,
     - when to use full vs focused validation.
   - Keep documentation precise about implemented runtimes and existing package boundaries.

6. CI and workflow compatibility
   - Ensure the new bounded test path is compatible with the npm workspace workflow.
   - Do not weaken existing GitHub Actions validation.
   - If CI changes are made, they must remain compatible with Node 20, Bun integration tests, and the existing `uv` Python setup.

## Non-Functional Requirements

- Preserve existing runtime behavior and public APIs unless a change is strictly test/dev-tooling related.
- Maintain or improve test reliability.
- Avoid introducing flaky timing-sensitive tests.
- Keep validation commands npm-based, matching repository workflow guidance.
- Follow Conductor TDD workflow for behavior-changing test infrastructure.
- Preserve at least 95% meaningful coverage for changed behavior, or record why coverage is not applicable for documentation-only changes.

## Acceptance Criteria

- A documented npm command exists for bounded-resource test execution with a 512 MiB Node old-space default.
- The bounded full test path builds, stages, and runs the Node test suite successfully.
- Bun and Python/`uv` subprocess limit behavior is implemented or explicitly documented with practical constraints.
- Full `npm test` continues to pass.
- Long-running test improvements are limited to low-risk changes and maintain equivalent coverage.
- At least one new or updated guard test covers slow-consumer/backpressure and memory/resource safety.
- Development docs explain full, targeted, bounded, build, lint, runtime-specific limits, and package-validation workflows.
- Relevant focused validation and final full validation results are recorded in the track plan.

## Out of Scope

- Major redesign of the package-consumer validation system.
- New public Host, Guest, Broker, or package runtime APIs.
- HTTP/3, browser, Rust, Go, Java, or Python Host behavior.
- Replacing Node's built-in `node:test` runner.
- Changing package publishing policy beyond test/validation command integration.
- Treating `verser2` as a full public gateway or adding authentication/authorization policy behavior.
