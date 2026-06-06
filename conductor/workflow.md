# Workflow

## Development Method

Use a test-driven, incremental workflow for every track. Prefer small, reviewable changes that preserve normal HTTP semantics, runtime portability, and the Verser2 Host/Guest/Broker/Peer nomenclature.

## Guiding Principles

1. **The Plan is the Source of Truth:** All work must be tracked in `plan.md`.
2. **The Tech Stack is Deliberate:** Changes to the tech stack must be documented in `tech-stack.md` before implementation.
3. **Test-Driven Development:** Write failing tests before implementing feature behavior.
4. **High Code Coverage:** Maintain at least 95% meaningful test coverage for changed behavior.
5. **Narrow Validation:** Run the smallest reliable build, test, lint, or type-check command that proves the change.
6. **Protocol Compatibility:** Preserve HTTP method, path, headers, body, status, response, streaming, and lifecycle semantics unless a track explicitly changes them.

## Task Lifecycle

For each task:

1. Confirm the affected package, entrypoint, protocol behavior, and expected outcome.
2. Mark the task in `plan.md` as in progress using `[~]`.
3. Write or update focused tests first and confirm the new tests fail for the expected reason.
4. Implement the smallest change that makes the tests pass.
5. Refactor only after tests pass, preserving public behavior.
6. Run the narrowest sufficient validation command.
7. Verify coverage is at least 95% for changed behavior.
8. Update documentation or Conductor artifacts when behavior changes.
9. Mark the task complete in `plan.md` using `[x]`.
10. Defer commits until the phase is complete.

## Commit Policy

- Commit after each completed phase, not after each task.
- Keep phase commits scoped to the phase.
- Do not commit unrelated working tree changes.
- Include a concise phase summary in the commit message body.
- Do not use Git notes for routine task or phase summaries.

## Testing Requirements

- Maintain at least 95% meaningful test coverage for changed behavior.
- Prefer package-level unit tests for focused implementation work.
- Add integration tests for Host/Guest request routing, streaming, lifecycle, and error behavior.
- Test both success and failure cases.
- Confirm concurrent request behavior when multiplexing behavior changes.
- Avoid HTTP/3-specific tests unless the track explicitly targets HTTP/3 support.

## Validation Commands

Use npm for agent-run commands in this repository.

Choose the narrowest sufficient validation available:

- Install dependencies: `npm ci` for clean installs, `npm install` when updating the lockfile.
- Build: `npm run build`.
- Tests: `npm run test`.
- Lint: `npm run lint`.

Prefer `CI=true` for commands that may otherwise enter watch mode.

## Validation and Tool Failure Continuation Protocol

Validate every tool call result and every command result. When a validation, test, or tool command fails, classify the failure before deciding whether to continue:

1. Identify the failing command or tool invocation.
2. Identify the specific error, symptom, or failing assertion.
3. Identify the likely root cause before taking corrective action.
4. Classify the failure as one of:
   - session-introduced,
   - preexisting but in scope,
   - preexisting and out of scope,
   - environment/tooling/transient,
   - or known in the current session.

Continue without additional user confirmation when fixing session-introduced failures, fixing preexisting in-scope failures, or carrying forward failures already marked known in the current session, provided the fix is safe, local, non-destructive, and within the active track scope.

Pause for user guidance when the failure appears preexisting and unrelated to the active track/session scope, the root cause cannot be classified after reasonable investigation, or the fix would require scope expansion, architecture changes, destructive cleanup, or edits to user-controlled unrelated files.

Distinguish command failures from tool misuse. Command and test failures with meaningful output follow the classification rules above. Malformed tool invocations, missing permissions, or unavailable tooling should be corrected if the fix is obvious; otherwise pause for guidance. Read-only diagnostic retries are allowed when the original tool choice or arguments were wrong.

When continuing past a non-blocking failure, record it in the track notes, validation summary, or handoff with the failed command, root cause, classification, and whether it was fixed, ignored as known, or deferred.

## Phase Completion Verification and Checkpointing Protocol

At the end of each phase:

1. Review all completed tasks in the phase against the phase goal.
2. Run the validation command or commands appropriate for the phase scope.
3. Confirm docs, tests, and code are aligned.
4. Confirm 95% coverage for changed behavior or record why coverage could not be measured.
5. Record any skipped validation and the reason.
6. Ask the user to manually verify the phase before moving to the next phase when the plan includes a Conductor manual verification task.
7. Create one scoped phase commit with a concise message and a summary in the commit body.
8. Update `plan.md` with the phase checkpoint commit SHA.

## Quality Gates

Before marking any task or phase complete, verify:

- [ ] All relevant tests pass.
- [ ] Coverage for changed behavior is at least 95%.
- [ ] Code follows the project code style guides in `code_styleguides/`.
- [ ] Public APIs and behavior are documented when needed.
- [ ] Type safety is enforced.
- [ ] No linting or static analysis errors are introduced.
- [ ] Runtime protocol behavior remains compatible unless the track explicitly changes it.
- [ ] No security vulnerabilities or hardcoded secrets are introduced.

## Code Review Process

Before requesting review or completing a phase:

1. Confirm the implementation matches the track specification.
2. Check edge cases, error paths, lifecycle behavior, and streaming behavior where relevant.
3. Confirm tests cover both success and failure cases.
4. Confirm the implementation follows TypeScript and Node.js package conventions.
5. Confirm docs and examples remain consistent with the product guidelines.

## Commit Guidelines

Use conventional commit-style messages:

```text
<type>(<scope>): <description>

<phase summary body when useful>
```

Common types:

- `feat`: New feature.
- `fix`: Bug fix.
- `docs`: Documentation only.
- `refactor`: Code change that neither fixes a bug nor adds a feature.
- `test`: Adding or updating tests.
- `chore`: Maintenance tasks.
- `conductor`: Conductor planning or workflow artifacts.

## Definition of Done

A phase is complete when:

1. All phase tasks are implemented to specification.
2. Tests are written and passing.
3. Coverage meets the 95% requirement for changed behavior.
4. Documentation is complete when behavior changed.
5. Linting and static analysis pass for the changed area.
6. Manual verification has been requested and confirmed when required by the plan.
7. Changes are committed once for the phase with a useful commit message body.
