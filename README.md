# oh-my-cli

A small code-agent CLI with file and shell tools. Built with Node.js 22, TypeScript, and ESM.

## Project policies

- [Apache License 2.0](LICENSE)
- [Contribution policy](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

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

Sessions are persisted as JSONL under `~/.oh-my-cli/sessions/`.

### Options

| Option | Description |
|---|---|
| `-p, --prompt <prompt>` | Run a single non-interactive request |
| `--resume <session-id>` | Resume a persisted session |
| `--approval-mode <mode>` | `default`, `auto-edit`, or `yolo` |
| `--workspace <dir>` | Workspace directory (default: cwd) |

### Approval modes

- **default** — prompt interactively for every mutating tool; deny when no TTY.
- **auto-edit** — allow `write` and `edit`; still prompt for `shell` and deny without TTY.
- **yolo** — allow all tools without prompting (unsafe).

Read operations never require approval.

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
- `src/index.ts` — CLI entry point (commander)
- `tests/fake-provider.ts` — fake OpenAI-compatible HTTP server for tests
