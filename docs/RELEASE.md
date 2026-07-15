# Release checklist

A release is a tagged version of `oh-my-cli` published from `main`. Use this
checklist to confirm supported platforms, verify artifacts, and preserve
rollback evidence before publishing. The commands here are operator procedures
run by a maintainer; the automated first-run command verification lives in the
release smoke check (`npm run smoke`) and covers [`docs/FIRST-RUN.md`](FIRST-RUN.md).

## Supported platforms

Recorded so a release is only cut where it was actually exercised.

- **Node.js:** `>= 22` (see `engines.node` in `package.json`).
- **Operating systems:** Linux, macOS, and Windows — the same set `--doctor`
  reports as supported. CI runs on Linux; macOS/Windows are validated via the
  cross-platform `--doctor` fixtures.

## Pre-release verification

Run the standard release subset and confirm every step is green:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:integration
npm run smoke
```

`npm run smoke` includes the first-run documentation check, which fails if any
command documented in `docs/FIRST-RUN.md` uses stale syntax.

## Artifact verification

- The build produces the bin entry `dist/index.js`. Confirm it resolves:

  ```bash
  node dist/index.js --version
  ```

- Review exactly what a publish would ship (there is no `files` allowlist in
  `package.json`, so inspect the list and confirm no secrets, `.env`, or local
  state are included):

  ```bash
  npm pack --dry-run
  ```

- Confirm the version in `package.json` matches the intended release tag.

## Rollback evidence

Releases are merge commits on `main`, so a release can be rolled back without
losing history. Keep a record of each release so a rollback is unambiguous.

- **Revert the release merge** (preserves history):

  ```bash
  git revert -m 1 <merge-commit-sha>
  ```

- **Republish the previous known-good version** if a published artifact is bad,
  and re-tag only after the revert is verified.

Record the following for every release (and for any rollback):

| Field | Value |
|---|---|
| Version | |
| Release merge SHA | |
| Previous known-good version | |
| `node dist/index.js --version` output | |
| Verification run (all green?) | |
| Rolled back? (SHA + reason) | |
