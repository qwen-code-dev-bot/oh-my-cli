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

Alternatively, persist the non-secret model configuration in the user-owned file
`~/.oh-my-cli/settings.json` so you do not have to export variables in every
shell. Store only the model name, compatible base URL, and the *name* of the
environment variable that holds the credential — never the key itself:

```json
{
  "model": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "name": "qwen-latest-series-invite-beta-v77",
    "apiKeyEnv": "DASHSCOPE_API_KEY"
  }
}
```

Environment variables always take precedence over the settings file, and a
settings file is only read from the user-owned default or an explicit
`--settings <path>` — never auto-discovered inside a project. See
[../README.md](../README.md#configuration) for the full precedence table.

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
  "Continue our conversation"`. Or browse and pick one interactively with
  `oh-my-cli --browse-sessions` (search, arrow through, and resume a session
  without copying its id; it resumes the exact session and restores its
  workspace, and fails closed if that session is missing, corrupt, or its
  workspace is gone).

  To hand off or review a session, export it locally with
  `oh-my-cli --export-session <session-id> --out <dir>`: it writes a readable
  Markdown transcript plus a deterministic JSON manifest, with secrets, auth
  tokens, sensitive environment values, and your home path redacted before any
  bytes are written. The export is local-only (no upload), atomic, and never
  overwrites an existing file without `--force`.

  Made a wrong turn? Each non-interactive turn records a content-based
  checkpoint of exactly the files it changed, so you can reverse just that turn
  without a `git reset` wiping out unrelated work. Preview first with
  `oh-my-cli --undo-turn <session-id> --dry-run`, then apply it with
  `oh-my-cli --undo-turn <session-id>` (and re-apply with
  `oh-my-cli --redo-turn <session-id>`). Undo restores each file the turn owned
  to its prior content (or deletes one it created) and trims its transcript
  entries, leaving your pre-existing changes untouched. It never uses force,
  hard reset, or stash, and it fails closed without changing anything if a
  turn-owned file has since diverged or is conflicted.

  Need a quick clarification without disturbing the task in progress? Ask a
  *side question*. In the interactive shell, type `/ask <question>` to open a
  distinct overlay: it answers from a bounded, read-only snapshot of the active
  session with tools and workspace changes disabled, and the answer is never
  appended to your main transcript, goal, or workflow. From a settled answer,
  **Enter** promotes it into the composer, **c** copies it, and **Esc** dismisses
  (or cancels while it streams). Headless, use
  `oh-my-cli --side-question "<question>" --session <session-id>` (add
  `--output json` for a versioned result); the source session is read only and
  left byte-identical.

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
