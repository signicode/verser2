# Known Solutions

Record recurring, approved recovery paths here. Consult this file before deciding how to handle recognizable validation, tooling, or implementation failures.

Use this fixed five-line format for each entry:

```text
Problem: <observable failure or symptom>
Cause: <known root cause>
Solution: <approved recovery steps>
Constraints: <when this solution is safe to apply>
Ignore-If: <conditions where this entry must not be used>
```

Problem: `gh pr view <number> --json comments,reviews,reviewThreads` fails with `Unknown JSON field: "reviewThreads"`.
Cause: The installed GitHub CLI version supports `comments` and `reviews` for `gh pr view --json`, but not structured `reviewThreads`.
Solution: Use `gh pr view <number> --comments` for human-readable output; use `gh pr view <number> --json comments,reviews --jq '{comments, reviews}'` for top-level comments/review bodies; use `gh api repos/{owner}/{repo}/pulls/<number>/comments --paginate` for flattened inline review comments; use `gh api graphql` with `pullRequest { reviewThreads { nodes { ... } } }` for thread metadata.
Constraints: Safe for read-only PR comment extraction when `gh` is authenticated and the repository/PR are accessible.
Ignore-If: Use this entry only for GitHub PR comment/review extraction failures involving unsupported `gh pr view --json` fields; do not use it for GitHub API authentication, permissions, rate-limit, or network failures.

Problem: Node tests hang while exercising a custom `http.Agent` or fake socket.
Cause: A `ClientRequest` was not given a socket, destroyed with an error, or ended, so the request promise and cleanup never settle.
Solution: Reproduce with `--test-name-pattern` and `--test-timeout`; wrap each `http.request` helper in a timeout that calls `request.destroy(error)`; dump active handles on timeout; unit-test the Agent with a stub Broker before running Host/Broker/Guest integration tests.
Constraints: Safe for Node `http.Agent`/custom `Duplex` socket debugging where non-matching routes must fail explicitly instead of falling back to DNS.
Ignore-If: Do not use for hangs where all HTTP requests settle and active handles point to unrelated timers, files, child processes, or servers.
