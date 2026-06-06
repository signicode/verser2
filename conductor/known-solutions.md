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
