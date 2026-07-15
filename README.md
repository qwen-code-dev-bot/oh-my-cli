# oh-my-cli

A small code-agent CLI with file and shell tools. Built with Node.js 22, TypeScript, and ESM.

## Project policies

- [Apache License 2.0](LICENSE)
- [Contribution policy](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Autonomy contract](AUTONOMY.md)

Product improvements enter the autonomous queue from three sources: promoted
user reports, findings from the bounded community-source registry, and
reproducible self-discoveries. Each becomes a normalized Issue authored by the
repository Bot before execution. The autonomy contract, its policy files,
GitHub workflows, and CODEOWNERS form a protected governance plane maintained
by `qqqys`; the Bot may propose governance changes but cannot apply them.

## Install

```bash
npm install
npm run build
```

New here? Follow [docs/FIRST-RUN.md](docs/FIRST-RUN.md) for a verified path from
install through your first successful task, including a setup `--doctor` check
and troubleshooting.

## Configuration

Set these environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | API key for the provider |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_MODEL` | Yes | — | Model name |

## Usage

### Non-interactive

```bash
oh-my-cli -p "List the files in this directory"
```

### Interactive REPL

```bash
oh-my-cli
```

### Resume a session

```bash
oh-my-cli --resume <session-id>
```

Sessions are persisted as JSONL under `~/.oh-my-cli/sessions/`. Each
non-interactive run seals the session with an atomic checkpoint (a temp file
renamed over the canonical one), so an interrupted write leaves either the
previous or the new complete checkpoint — never a half-written file. On
`--resume`, the checkpoint is recovered automatically: a complete one left by an
interrupted write is promoted, a partial one is discarded, and a corrupt one is
quarantined alongside the session (preserved, never deleted) with a warning —
without touching other sessions.

### Options

| Option | Description |
|---|---|
| `-p, --prompt <prompt>` | Run a single non-interactive request |
| `--resume <session-id>` | Resume a persisted session |
| `--approval-mode <mode>` | `default`, `auto-edit`, or `yolo` |
| `--workspace <dir>` | Workspace directory (default: cwd) |
| `--doctor` | Run read-only installation/platform readiness checks and exit |
| `--readiness` | Inspect repository readiness for a blocked task (read-only) and exit |
| `--expected-branch <name>` | Expected branch for the `--readiness` branch check |
| `--remote <name>` | Git remote to probe for `--readiness` (default `origin`) |
| `--output <format>` | `-p` output format: `text` (default) or `json` (headless event stream) |
| `--no-color` | Disable ANSI color output (also honors a non-empty `NO_COLOR` env var) |
| `--summary` | Print a privacy-safe execution summary for the run (unattended use) |
| `--baseline <file>` | Baseline run-summary file to compare in scorecard mode |
| `--candidate <file>` | Candidate run-summary file to compare in scorecard mode |
| `--max-elapsed-ratio <n>` | Scorecard regression threshold: fractional elapsed-time increase tolerated (default `0.25`) |
| `--max-failure-delta <n>` | Scorecard regression threshold: tool-failure increase tolerated (default `0`) |
| `--recover` | Resume an interrupted task from a recovery checkpoint (read-only) and exit |
| `--checkpoint <file>` | Recovery checkpoint file for `--recover` |
| `--task-identity <id>` | Stable task identity (used by `--recover` and worktree leases) |
| `--evidence <file>` | Current evidence file (JSON `stepId -> digest`) for `--recover` |
| `--create-worktree` | Create a leased git worktree for a mutating delegated agent and exit |
| `--clean-worktree` | Clean a leased git worktree after verified completion and exit |
| `--agent-identity <id>` | Stable agent identity for a leased worktree (with `--create-worktree`/`--clean-worktree`) |
| `--worktree-root <dir>` | Directory where leased worktrees live (default `<workspace>/.oh-my-cli/worktrees`) |
| `--command-policy <command>` | Evaluate one shell command against the offline command policy and exit |
| `--provenance <source>` | Command provenance for `--command-policy`: `builtin`, `repository` (default), or `issue` |

Color is enabled by default in the interactive REPL and command palette. Pass
`--no-color` or set a non-empty `NO_COLOR` environment variable (per
[no-color.org](https://no-color.org)) for CI-friendly plain output; an empty
`NO_COLOR` is ignored.

### Approval modes

- **default** — prompt interactively for every mutating tool; deny when no TTY.
- **auto-edit** — allow `write` and `edit`; still prompt for `shell` and deny without TTY.
- **yolo** — allow all tools without prompting (unsafe).

Read operations never require approval.

### Headless JSON protocol

For CI and automation, pass `--output json` with `-p` to emit a versioned,
newline-delimited JSON event stream on stdout. The default human-readable output
is unchanged when the protocol is not selected.

```bash
oh-my-cli -p "Summarize README.md" --output json
```

Each line is a self-describing record that parses independently:

```json
{"protocol":"oh-my-cli.headless","v":1,"seq":0,"ts":"…","type":"start","sessionId":"…","model":"…","prompt":"…"}
{"protocol":"oh-my-cli.headless","v":1,"seq":1,"ts":"…","type":"assistant","round":0,"final":true,"text":"…","truncated":false}
{"protocol":"oh-my-cli.headless","v":1,"seq":2,"ts":"…","type":"complete","ok":true,"exitCode":0,"rounds":1,"reason":"completed"}
```

- **Envelope** — every record carries `protocol` (`oh-my-cli.headless`), `v`
  (schema version), a monotonic `seq`, an ISO `ts`, and a `type`.
- **Events** — `start`, `assistant` (one per turn), `tool_start`, `tool_result`
  (`ok` reflects success), `error` (`stage` is `provider` or `internal`), and a
  terminal `complete`.
- **Exit semantics** — the `complete` record's `exitCode` always equals the
  process exit code (`0` success, `1` failure), so wrappers can compare the
  terminal record against `$?`.
- **Safety** — secrets and home paths are redacted and oversized payloads are
  truncated (with a `truncated` flag); the stream stays clean for machine use.

### Run summary

For unattended runs, pass `--summary` to append a privacy-safe execution summary
after the run. It is opt-in: interactive sessions and plain `-p` runs are
unchanged unless you request it. The summary is **metadata only** — outcome,
exit code, classified reason, elapsed time, rounds, bounded tool-call/failure
counts, and token totals — and never carries prompt, tool, or file content.
Secret-shaped strings are redacted and the host home directory is collapsed to
`~`, so the session log path stays private.

In text mode the summary prints a short block after the run:

```bash
oh-my-cli -p "Run the build" --summary
# …
# Run summary (oh-my-cli.summary v1)
# outcome:   success
# exit code: 0
# reason:    completed
# elapsed:   2.0s
# rounds:    1
# tool calls: 1 (shell×1)
# tokens:    prompt 5, completion 5, total 10
# evidence:  session 01J… (~/.oh-my-cli/sessions/01J….jsonl)
```

In `--output json` mode the same data arrives as a versioned `summary` event
emitted just before the terminal `complete`, so CI can retain it as run evidence:

```bash
oh-my-cli -p "Run the build" --output json --summary \
  | tee run.ndjson \
  | grep '"type":"summary"'   # keep the evidence line for the job log
```

```json
{"protocol":"oh-my-cli.headless","v":1,"seq":3,"ts":"…","type":"summary","summary":{"schema":"oh-my-cli.summary","v":1,"outcome":"success","exitCode":0,"reason":"completed","elapsedMs":2000,"rounds":1,"toolCalls":{"total":1,"byName":{"shell":1}},"toolFailures":{"total":0,"byName":{}},"tokens":{"prompt":5,"completion":5,"total":10},"evidence":{"sessionId":"01J…","sessionPath":"~/.oh-my-cli/sessions/01J….jsonl"}}}
```

The `outcome` is `success` or `failure`; on failure the `reason` classifies the
terminal state (`provider_error`, `max_rounds`, or `error`) and the `exitCode`
preserves the process exit code, so a wrapper can compare the summary against
`$?`. Distinct tool names are capped (overflow rolls into `__other__`) to keep
the summary bounded regardless of how many tools a run touched.

### Run scorecard

To compare two unattended runs, save each run's summary and diff them with
`--baseline` / `--candidate`. The scorecard is **deterministic and evidence-based**:
it reports the stable deltas (outcome, elapsed time, retry/failure counts, and
completed work) between a baseline and a candidate, and never invents a universal
quality score. Like the summary, it is metadata only — no prompts, secrets, host
paths, session ids, or tool payloads appear in the output.

```bash
# Save a run's summary as evidence (text block or the JSON `summary` event both work)
oh-my-cli -p "Run the build" --output json --summary | tee baseline.ndjson
# … later, after a change …
oh-my-cli -p "Run the build" --output json --summary | tee candidate.ndjson

oh-my-cli --baseline baseline.ndjson --candidate candidate.ndjson
```

```text
Run scorecard (oh-my-cli.scorecard v1)
  outcome:        success -> failure  [REGRESSION]
  reason:         completed -> error
  elapsed ms:     2000 -> 5200 (+3200, up)  [REGRESSION]
  rounds:         1 -> 4 (+3, up)
  tool calls:     1 -> 6 (+5, up)
  tool failures:  0 -> 2 (+2, up)  [REGRESSION]
  completed work: 1 -> 4 (+3, up)
  tokens total:   10 -> 40 (+30, up)
  thresholds:     elapsed ratio <= 0.25, failure delta <= 0
Result: REGRESSION (exit 1)
  - outcome regressed (success -> failure)
  - tool failures rose more than 0 above baseline
  - elapsed time rose more than 25% above baseline
```

Inputs may be a bare summary object or a headless NDJSON stream (the `summary`
event is extracted automatically). Add `--output json` for a machine-readable
scorecard. The exit code is a documented contract for CI:

- `0` — no documented regression threshold was crossed.
- `1` — a regression was flagged: the outcome regressed (`success` → `failure`),
  tool failures rose above `--max-failure-delta` (default `0`), or elapsed time
  rose above `--max-elapsed-ratio` (default `0.25`, i.e. +25%).
- `2` — a usage or input error (missing/only one file, malformed or
  version-incompatible summaries, or an invalid threshold).

### Run recovery

An interrupted unattended run can otherwise require a full restart, repeating
work that already finished. `--recover` implements one bounded recovery path: it
resumes from a durable checkpoint and reports which steps are **proven complete
and safe to skip**, so a completed step is never executed twice.

A checkpoint records only **identities and content digests** — never raw
evidence, prompts, secrets, or host paths. Completion is proven by matching the
durable evidence digest of each completed step, **never by parsing log text**.
The check fails closed: a stale (repository head moved), ambiguous (different
task identity), or tampered (a completed step's evidence changed) checkpoint is
refused without any mutation.

```bash
# A checkpoint written after step "build" completed, before the run was interrupted
oh-my-cli --recover \
  --checkpoint checkpoint.json \
  --task-identity deploy-task \
  --evidence evidence.json \
  --workspace path/to/repo
```

```text
Run recovery (oh-my-cli.recovery v1)
────────────────────────────────────────
decision:  resume
reason:    all completed-step evidence verified; safe to skip the proven steps
task:      deploy-task
repo head: 3a61045b781f27e95b496ede6dfd23d0b63a6b4b
completed: 1 step(s) safe to skip:
  - build
```

The checkpoint stores the task identity, the repository head, and each completed
step's id and evidence digest; the evidence file is a flat JSON object of
`stepId -> digest` for the artifacts present now. Add `--output json` for a
versioned plan (`schema` `oh-my-cli.recovery`) whose `completed` array lists the
steps to skip. The exit code is a documented contract:

- `0` — `resume`: task identity and repository head match and every completed
  step's evidence still verifies; the listed steps are safe to skip.
- `1` — `refuse`: the checkpoint is stale, ambiguous, or tampered; do not resume.
- `2` — a usage or input error (missing `--checkpoint`/`--task-identity`, or a
  malformed/incompatible checkpoint or evidence file).

### Leased worktrees

Two mutating agents in one workspace can silently overwrite or corrupt each
other's work. `--create-worktree` carves out one **leased git worktree** per
mutating agent so they run in isolation, and `--clean-worktree` removes a lease
again only after its work is verified complete. The lease identity (branch +
worktree path) is derived deterministically from the repository, the
`--task-identity`, and the `--agent-identity`, so the same task+agent always maps
to the same lease (idempotent across interruption) while distinct agents never
collide.

```bash
# Give each mutating agent its own isolated worktree for one task
oh-my-cli --create-worktree --workspace path/to/repo \
  --task-identity deploy-task --agent-identity worker-1
oh-my-cli --create-worktree --workspace path/to/repo \
  --task-identity deploy-task --agent-identity worker-2

# After the agent's branch is merged, clean its lease
oh-my-cli --clean-worktree --workspace path/to/repo \
  --task-identity deploy-task --agent-identity worker-1
```

```text
Worktree lease (oh-my-cli.worktree-lease v1)
────────────────────────────────────────
action:   create
result:   ok
status:   created
lease:    d0a3e7bc65723c0e
branch:   lease/wt-d0a3e7bc65723c0e
worktree: ~/code/repo/.oh-my-cli/worktrees/d0a3e7bc65723c0e
base:     3a61045b781f
task:     deploy-task
agent:    worker-1
```

Creation is fail-closed and refuses **before any mutation** when the target is
not a repository, the parent worktree is dirty, the identity is ambiguous
(missing `--task-identity`/`--agent-identity`, or a repository with no commit to
base from), or the lease already exists in a partial/conflicting state. Cleanup
**never deletes work**: it refuses a worktree with uncommitted changes or a
branch with unmerged commits, uses only non-forcing git commands, and never
touches the parent worktree. There is no automatic merge and no forced removal.
Both operations are idempotent — re-creating an existing lease returns it, and
cleaning an absent lease is a no-op. Leased worktrees live under
`<workspace>/.oh-my-cli/worktrees` (git-ignored) by default; pass
`--worktree-root` to keep them elsewhere. Add `--output json` for a versioned
record (`schema` `oh-my-cli.worktree-lease`); host home paths and secrets stay
redacted. The exit code is a documented contract:

- `0` — success: the lease was created or cleaned, or the request was an
  idempotent no-op.
- `1` — a safety refusal: non-repository, dirty parent, ambiguous target,
  already-leased, uncommitted changes, or unmerged commits.
- `2` — a usage error (missing identities, both `--create-worktree` and
  `--clean-worktree`, invalid `--output`) or an unexpected git failure.

### Command policy

The shell tool runs an arbitrary `/bin/bash -c <command>`. Before any shell
command executes, a deterministic, offline **command policy** classifies what it
will do and denies a small set of known-dangerous shapes — naming the violated
rule — without running it. The same gate protects interactive runs and is
applied **before** approval, so a denial cannot be bypassed by `--approval-mode
yolo`; commands that pass keep the existing approval/yolo behavior unchanged.

The policy distinguishes trusted **builtin** commands from **repository**/**issue**
-provided ones (provenance). Only untrusted provenance is denied. It always
classifies network use, writes, credential access, destructive Git, and path
escape, and it denies:

- `destructive_git` — force push / `--delete` / `--mirror` / `+`/`:` refspecs,
  `reset --hard`, `clean -f/-d`, `branch -D`, `checkout` discard, `filter-branch`.
- `credential_access` — reading `~/.ssh`, `id_rsa`, `.env`, `*.pem`, `*.key`,
  `~/.aws/credentials`, `/etc/shadow`, …, or printing secret env vars.
- `path_escape` — writes (or `>`/`>>` redirects) that resolve outside the workspace.
- `destructive_removal` — `rm -r/-R` aimed at `/`, `~`, `$HOME`, `.`, or `..`.
- `device_overwrite` — `dd of=/dev/…`, `mkfs`/`fdisk`/`parted`, redirects onto a device.

It is a bounded quote/substitution-aware tokenizer over the compiled command
string (not a general shell parser): it descends into `$(...)`, backticks, and
subshells, sees through `sudo`/`env`/`VAR=val` wrappers, and ignores
dangerous-looking text inside quotes (`echo "rm -rf /"` is allowed). Evaluate any
command offline with `--command-policy`:

```bash
oh-my-cli --command-policy "git push --force"
oh-my-cli --command-policy "cat ~/.ssh/id_rsa" --output json
```

```text
Command policy (oh-my-cli.command-policy v1)
  decision:     deny
  provenance:   repository
  command:      git push --force
  classify:     network=no write=no credential=no destructive-git=yes path-escape=no
  violations:
    - destructive_git: git push --force / --delete / refspec rewrites remote history
```

The exit code is a documented contract:

- `0` — allowed.
- `1` — denied (one or more violations).
- `2` — a usage error (invalid `--provenance` or `--output`).

### Readiness doctor

After installing, run a read-only health check to catch runtime, resolution,
state-directory, and platform problems before a real task does:

```bash
oh-my-cli --doctor
```

It verifies the Node runtime version, that the CLI entry is present, that the
state directory is writable (or creatable), and that the platform is supported.
Each check is categorized `✓` pass, `⚠` warning, or `✗` failure with actionable
remediation. The command never installs, creates, or edits anything, redacts
host paths and secrets, and exits `0` when there are no failures (`1` otherwise).

### Repository readiness

When an autonomous task is blocked on a repository prerequisite, run a read-only
inspection to explain the single blocker with bounded, structured evidence:

```bash
oh-my-cli --readiness
# or point it at another checkout / expected branch / remote
oh-my-cli --readiness --workspace path/to/repo --expected-branch main --remote origin
```

It checks the working tree (clean vs. uncommitted changes), the branch (on a
branch, detached, or not the `--expected-branch`), the test command (a `test`
script in `package.json`), required tools (on `PATH`; `git` by default), and the
remote (configured and reachable). Each check reports `✓`/`✗` with a redacted
detail and, when failing, a **safe next action** — a recommendation that is
never executed. The command inspects repository-local and Git metadata only; it
never installs, creates, edits, fetches into, or otherwise mutates anything, and
secrets and host paths stay redacted.

```text
Repository readiness (oh-my-cli.readiness v1)
────────────────────────────────────────
✓ Worktree        clean
✓ Branch          on "main"
✓ Test command    vitest run
✓ Required tools  git available
✓ Remote          remote "origin" reachable

Ready: no blocker detected.
```

Add `--output json` for a versioned report (`schema` `oh-my-cli.readiness`) whose
`blocker` names the first failing check (or `null` when ready). The exit code is a
documented contract for CI: `0` when ready (no blocker), `1` when blocked.

## Built-in tools

| Tool | Category | Description |
|---|---|---|
| `read` | read | Read a workspace-relative file with optional line offset/limit |
| `write` | mutate-file | Create or replace a workspace-relative UTF-8 file |
| `edit` | mutate-file | Replace exactly one occurrence of text in a file |
| `shell` | mutate-shell | Execute a command via `/bin/bash` (30s default timeout, 120s max, 1 MiB output cap) |

File operations are confined to the workspace directory. Symlink escapes are detected and rejected.

A long-running or silent shell command (a build, install, or test that emits no
output) need not look stuck: after ~5s the CLI prints a periodic
`… still running (Ns elapsed)` heartbeat to the terminal in interactive mode,
and reports the elapsed wall-clock time in the headless `tool_result` event
(`--output json`) so non-interactive consumers see progress too. The heartbeat
carries only elapsed seconds — never command output, secrets, or host paths —
and the existing timeout and 1 MiB output cap are unchanged.

## Development

```bash
npm run build            # Compile TypeScript
npm run typecheck        # Type-check without emitting
npm test                 # Unit tests
npm run test:integration # Integration tests (fake provider, no network)
npm run smoke            # Smoke tests against built binary
```

`npm run smoke` also runs the first-run documentation check, which executes
every `oh-my-cli` command documented in [docs/FIRST-RUN.md](docs/FIRST-RUN.md)
and fails if the documented syntax goes stale.

## Releasing

Before cutting a release, follow [docs/RELEASE.md](docs/RELEASE.md): it records
supported platforms, artifact verification, and rollback evidence.

## Architecture

- `src/config.ts` — environment variable validation (zod)
- `src/provider.ts` — OpenAI-compatible streaming client with text + tool-call aggregation
- `src/agent.ts` — agent loop with 30-round hard cap
- `src/tools.ts` — tool definitions (read, write, edit, shell)
- `src/workspace.ts` — path confinement with symlink escape detection
- `src/approval.ts` — approval mode logic
- `src/command-policy.ts` — deterministic, offline shell-command classification and denial (`--command-policy`)
- `src/permission-impact.ts` — redacted permission-impact preview for the approval prompt
- `src/color.ts` — ANSI color toggle (`--no-color` / `NO_COLOR`) and palette factory
- `src/session.ts` — JSONL session persistence
- `src/headless-protocol.ts` — versioned NDJSON event stream (`--output json`)
- `src/run-summary.ts` — privacy-safe execution summary builder/formatter (`--summary`)
- `src/run-scorecard.ts` — deterministic, privacy-safe comparison of two summaries (`--baseline`/`--candidate`)
- `src/run-recovery.ts` — bounded run recovery from a durable checkpoint (`--recover`)
- `src/repo-readiness.ts` — read-only repository-readiness inspection (`--readiness`)
- `src/worktree-lease.ts` — collision-safe leased git worktrees per mutating agent (`--create-worktree`/`--clean-worktree`)
- `src/index.ts` — CLI entry point (commander)
- `tests/fake-provider.ts` — fake OpenAI-compatible HTTP server for tests
