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
| `--output <format>` | `-p` output format: `text` (default) or `json` (headless event stream) |

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

## Built-in tools

| Tool | Category | Description |
|---|---|---|
| `read` | read | Read a workspace-relative file with optional line offset/limit |
| `write` | mutate-file | Create or replace a workspace-relative UTF-8 file |
| `edit` | mutate-file | Replace exactly one occurrence of text in a file |
| `shell` | mutate-shell | Execute a command via `/bin/bash` (30s default timeout, 120s max, 1 MiB output cap) |

File operations are confined to the workspace directory. Symlink escapes are detected and rejected.

## Development

```bash
npm run build            # Compile TypeScript
npm run typecheck        # Type-check without emitting
npm test                 # Unit tests
npm run test:integration # Integration tests (fake provider, no network)
npm run smoke            # Smoke tests against built binary
```

## Architecture

- `src/config.ts` — environment variable validation (zod)
- `src/provider.ts` — OpenAI-compatible streaming client with text + tool-call aggregation
- `src/agent.ts` — agent loop with 30-round hard cap
- `src/tools.ts` — tool definitions (read, write, edit, shell)
- `src/workspace.ts` — path confinement with symlink escape detection
- `src/approval.ts` — approval mode logic
- `src/session.ts` — JSONL session persistence
- `src/headless-protocol.ts` — versioned NDJSON event stream (`--output json`)
- `src/index.ts` — CLI entry point (commander)
- `tests/fake-provider.ts` — fake OpenAI-compatible HTTP server for tests
