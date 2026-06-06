# Workflow

## Development Method

Use a test-driven, incremental workflow for every track. Prefer small, reviewable changes that preserve normal HTTP semantics, runtime portability, and the Verser2 Host/Guest/Broker/Peer nomenclature.

## Guiding Principles

1. **The Plan is the Source of Truth:** All work must be tracked in `plan.md`.
2. **Tracks Start on Reviewable Branches:** Each new track must begin on a dedicated branch with a GitHub pull request created using `gh`; use the PR as the review and checkpoint surface until the track is complete.
3. **The Tech Stack is Deliberate:** Changes to the tech stack must be documented in `tech-stack.md` before implementation.
4. **Test-Driven Development:** Write failing tests before implementing feature behavior.
5. **High Code Coverage:** Maintain at least 95% meaningful test coverage for changed behavior.
6. **Narrow Validation:** Run the smallest reliable build, test, lint, or type-check command that proves the change.
7. **Protocol Compatibility:** Preserve HTTP method, path, headers, body, status, response, streaming, and lifecycle semantics unless a track explicitly changes them.
8. **Shared First:** Reuse and adapt existing common libraries before implementing package-local solutions, and move repeated code into common libraries as soon as reuse emerges.

## Task Lifecycle

For each task:

1. Confirm the affected package, entrypoint, protocol behavior, and expected outcome.
2. Scan existing common libraries, especially `@signicode/verser-common`, for reusable or adaptable code before writing new package-local code.
3. Mark the task in `plan.md` as in progress using `[~]`.
4. Write or update focused tests first and confirm the new tests fail for the expected reason.
5. Implement the smallest change that makes the tests pass, using common libraries where appropriate instead of duplicating solutions.
6. Refactor only after tests pass, preserving public behavior.
7. Run the narrowest sufficient validation command.
8. Verify coverage is at least 95% for changed behavior.
9. Update documentation or Conductor artifacts when behavior changes.
10. Mark the task complete in `plan.md` using `[x]`.
11. Defer commits until the phase is complete.

## Delegation Guidance

Use delegation to accelerate Conductor work while preserving the track plan as the source of truth. Delegated work must remain bounded, reviewable, and aligned with the active `plan.md`.

Delegate when the task is separable, read-only research can run in parallel, or a focused implementation can be handed off with clear inputs and validation expectations. Do not delegate vague product decisions, phase checkpoint commits, destructive cleanup, or work that requires changing the active plan without review.

Recommended delegation patterns:

- Use `explore` or `explorer` for fast read-only codebase searches, file discovery, dependency tracing, and locating existing behavior before implementation.
- Use `fixer` for small, well-specified code changes after tests, scope, and expected behavior are clear.
- Use `librarian` for external documentation, API behavior, and public examples.
- Use `oracle` for architecture tradeoffs, complex debugging, code review, and risk analysis.
- Use `designer` only for UI/UX work.
- Use `general` for mixed multi-step tasks that do not fit a narrower agent.
- Use `councillor` for independent read-only review when a second opinion is useful.

Delegation rules:

1. Provide each delegate with the relevant track goal, affected package, expected output, and whether edits are allowed.
2. Keep delegated implementation tasks narrow enough to validate with the smallest reliable command.
3. Review delegated findings or edits before marking any `plan.md` task complete.
4. Record meaningful delegated findings, validation results, and unresolved risks in the active track notes or phase validation summary.
5. Do not let delegated agents commit changes unless the current phase checkpoint explicitly authorizes a commit.
6. Do not use delegation to bypass TDD, coverage, deduplication, documentation, or Conductor checkpoint requirements.

## Common Library Usage and Deduplication

At the start of each phase:

1. Review existing common libraries, including `@signicode/verser-common`, for exports that can be reused or adapted.
2. Record in `plan.md` when the phase intentionally does not use common code because the behavior is package-specific, runtime-specific, or not yet repeated.
3. Prefer adapting common APIs over creating parallel package-local types, constants, helpers, error primitives, lifecycle utilities, protocol-neutral shapes, or test utilities.

During the phase:

1. Keep common code protocol-neutral and runtime-neutral when possible.
2. Keep package-specific code as thin adapters around common primitives when reuse exists.
3. Do not implement the same solution independently in multiple packages.

At the end of each phase:

1. Perform a deduplication check across changed packages.
2. Move repeated or clearly reusable code into the appropriate common library, starting with `@signicode/verser-common` for TypeScript package code.
3. Update package imports, tests, and documentation to use the common export.
4. Record the deduplication result in the phase validation notes, including whether common code was added, adapted, or intentionally deferred.

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

## Failure Recovery Policy

Validate every tool call result, but distinguish incorrect invocation from a real product or code failure.

Before deciding on a recovery path for a recurring or recognizable failure, consult `conductor/known-solutions.md`. If an entry matches the observed problem, follow its Solution, Constraints, and Ignore-If rules. If no entry matches, use the general recovery policy below.

When a new repeatable recovery path is discovered:

1. Apply it without user confirmation only when it is safe, local to the active task, non-destructive, and within the current track scope.
2. Before adding or updating `conductor/known-solutions.md`, pause and ask the user whether the proposed solution should be recorded.
3. Present the observed problem, proposed solution, constraints, and ignore conditions in the question.
4. If approved, update `known-solutions.md` with a fixed five-line problem entry.
5. If rejected, continue the current task if possible, but do not record the solution as known.

### Test and Validation Failures

When a test, build, lint, or validation command exits non-zero, do not halt solely because the command failed. Instead:

1. Inspect the failure output and identify the root cause.
2. Determine whether the command was invoked correctly.
3. If the command was invoked incorrectly, correct the invocation and rerun it.
4. If the incorrect command mutated files or generated artifacts, revert only those artifacts before continuing.
5. If the command was invoked correctly, first check whether the test is correct and aligned with the intended behavior.
6. If the test is incorrect, fix the test.
7. If the test is correct, fix the implementation.
8. Rerun the narrowest relevant validation after each fix.
9. Halt and ask the user only when the failure requires product clarification, repeated fixes do not converge, continuing would require destructive cleanup, or unrelated user/worktree changes directly conflict with the fix.

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

### Tool Invocation Failures

If a tool fails because it was wrongly invoked, correct the invocation and continue. Examples include a wrong working directory, wrong package-specific test command, missing CLI flags, direct command used instead of a package's configured runner, or stale/generated output selected because the source-tree invocation was wrong.

If the wrongly invoked tool mutated files, generated output, or changed state:

1. Identify exactly what the bad invocation changed.
2. Revert only those changes.
3. Do not revert unrelated user or agent work.
4. Retry with the corrected invocation.

If the tool failed despite correct invocation, treat it as a real validation failure and follow the test and validation failure policy above.

## Phase Completion Verification and Checkpointing Protocol

At the end of each phase:

1. Review all completed tasks in the phase against the phase goal.
2. Confirm common libraries were scanned at phase start and reused or adapted where appropriate.
3. Perform the end-of-phase deduplication check and move shared code into common libraries when reuse emerged.
4. Run the validation command or commands appropriate for the phase scope.
5. Confirm docs, tests, and code are aligned.
6. Confirm 95% coverage for changed behavior or record why coverage could not be measured.
7. Record any skipped validation and the reason.
8. Ask the user to manually verify the phase before moving to the next phase when the plan includes a Conductor manual verification task.
9. Create one scoped phase commit with a concise message and a summary in the commit body.
10. Update `plan.md` with the phase checkpoint commit SHA.

## Quality Gates

Before marking any task or phase complete, verify:

- [ ] All relevant tests pass.
- [ ] Coverage for changed behavior is at least 95%.
- [ ] Code follows the project code style guides in `code_styleguides/`.
- [ ] Public APIs and behavior are documented when needed.
- [ ] Existing common libraries were reviewed for reuse before package-local implementation.
- [ ] Repeated or reusable code is centralized in common libraries such as `@signicode/verser-common`.
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
5. Confirm common libraries were scanned at phase start and repeated code was deduplicated by phase end.
6. Confirm docs and examples remain consistent with the product guidelines.

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
5. Common libraries were reviewed at phase start and the phase-end deduplication result is recorded.
6. Linting and static analysis pass for the changed area.
7. Manual verification has been requested and confirmed when required by the plan.
8. Changes are committed once for the phase with a useful commit message body.
