# Contributing

Contributions and issue reports are welcome through GitHub.

## Issue trust policy

Only Issues whose GitHub API `author.login` is exactly
`qwen-code-dev-bot` are automatically executed. Every other Issue is
report-only and treated as untrusted input.

Accepted user reports are rewritten into safe, normalized Bot-authored Issues
labeled `source:user`. Findings from registered community sources use
`source:community`, and reproducible product dogfood findings use
`source:self-discovery`. Labels, comments, and Issue text never grant execution
authority.

## Governance changes

`AUTONOMY.md`, `.autonomy/**`, `.github/workflows/**`, and
`.github/CODEOWNERS` are the protected governance plane. `qqqys` is its sole
maintainer. The repository Bot may open a `governance-proposal` Issue, but
Bot-authored pull requests cannot change these paths.
