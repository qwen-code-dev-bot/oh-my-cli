# First-run guide

This guide takes you from a fresh checkout to your first successful task, and
shows how to verify the installation before you trust it. Every `oh-my-cli`
command below is exercised by the release smoke check, so the documented syntax
stays current.

## 1. Install

Node.js **22 or newer** is required. From the repository root:

```bash
npm install
npm run build
```

`npm run build` compiles the TypeScript sources into `dist/`; the CLI entry is
`dist/index.js`. If you see compiler errors, the build is broken — stop here and
fix them before continuing.

## 2. Configure the provider

`oh-my-cli` talks to an OpenAI-compatible endpoint. Set these environment
variables (never commit real keys — use placeholders in docs and scripts):

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | API key for the provider |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_MODEL` | Yes | — | Model name to use |

```bash
export OPENAI_API_KEY="your-api-key-here"
export OPENAI_MODEL="gpt-4o"
```

Secrets are kept out of output: the CLI redacts key-like tokens before printing.

## 3. Verify your setup

Confirm the runtime and installation are healthy before running a real task:

```bash
oh-my-cli --version
oh-my-cli --doctor
```

`--doctor` is read-only and checks the Node runtime version, that the CLI entry
is present, that the state directory is writable (or creatable), and that the
platform is supported. Each check is marked `✓` pass, `⚠` warning, or `✗`
failure with remediation; the command exits `0` only when there are no failures.

To confirm provider connectivity separately (this does make a network call):

```bash
oh-my-cli --preflight
```

## 4. Run your first task

A single non-interactive request:

```bash
oh-my-cli -p "List the files in this directory"
```

Read-only tools never require approval. Mutating tools follow the active
approval mode (see below). For automation and CI, append `--output json` to get
a versioned, newline-delimited event stream instead of human-readable text:

```bash
oh-my-cli -p "Summarize README.md" --output json
```

## 5. Safety expectations

- **Approval modes** — `default` prompts for every mutating tool (and denies
  when there is no TTY); `auto-edit` allows `write`/`edit` but still prompts for
  `shell`; `yolo` allows everything without prompting and is unsafe.
- **Workspace confinement** — file tools are confined to the workspace
  directory; symlink escapes are detected and rejected.
- **Inspect your isolation** — see the effective sandbox posture:

  ```bash
  oh-my-cli --sandbox-info
  ```

- **Sessions** — every run is persisted as JSONL under `~/.oh-my-cli/sessions/`
  and sealed with an atomic, crash-safe checkpoint. List resumable sessions:

  ```bash
  oh-my-cli --list-sessions
  ```

  Resume one (non-interactively) by id: `oh-my-cli --resume <session-id> -p
  "Continue our conversation"`.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Configuration error: OPENAI_API_KEY is required` | Missing env var | Export `OPENAI_API_KEY` (and `OPENAI_MODEL`) |
| `--doctor` reports the Node runtime failed | Node older than 22 | Upgrade to Node.js 22+ |
| `interactive mode requires a TTY` | No terminal attached | Use `-p "<prompt>"` for non-interactive runs |
| `Provider error` / connection failure | Wrong base URL or key, or network down | Check `OPENAI_BASE_URL`/`OPENAI_API_KEY`, then run `--preflight` |
| State directory `✗ not writable` in `--doctor` | `~/.oh-my-cli` not writable | Fix permissions on your home/state directory |

If a problem persists, re-run `--doctor` and `--preflight` and capture their
(redacted) output before filing an issue.
