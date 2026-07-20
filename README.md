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

Model configuration is resolved from environment variables and an optional user
settings file. Environment variables always take precedence, so existing
export-based setups work unchanged.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes¹ | — | API key for the provider |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_MODEL` | Yes¹ | — | Model name |

¹ Not required in the environment when supplied through the user settings file
below.

### User settings file

To avoid exporting variables in every shell, store the non-secret model
configuration in the user-owned file `~/.oh-my-cli/settings.json`, or select an
alternative with `--settings <path>`. The credential itself is never stored in
the file — only the *name* of the environment variable that holds it:

```json
{
  "model": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "name": "qwen-latest-series-invite-beta-v77",
    "apiKeyEnv": "DASHSCOPE_API_KEY"
  },
  "mcpServers": {},
  "extensions": {}
}
```

This is the same file that backs the `--health` MCP/extension inventory. Each
field is resolved with the following precedence (highest first):

| Field | 1 (highest) | 2 | 3 (lowest) |
|---|---|---|---|
| Base URL | `OPENAI_BASE_URL` | `model.baseUrl` | built-in default |
| Model name | `OPENAI_MODEL` | `model.name` | *(required)* |
| Credential | `OPENAI_API_KEY` | env var named by `model.apiKeyEnv` | *(required)* |

Security: the settings file is only ever the user-owned default or a path you
pass explicitly — a settings file inside a project is never auto-discovered, so
an untrusted repository cannot redirect your endpoint or credential. Raw
credential fields such as `model.apiKey` are rejected; reference an environment
variable through `apiKeyEnv` instead. `oh-my-cli --preflight` prints a redacted
summary of the resolved model, endpoint host, settings source, and credential
variable name (never the credential value).

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

Prefer to browse instead of copying an id? Run `oh-my-cli --browse-sessions` in
a terminal to search and arrow through your sessions, then resume the selected
one. It resumes the exact session and restores its declared workspace, and it
fails closed with an actionable message rather than resuming something else when
the chosen session is missing, corrupt, or its workspace no longer exists.

Sessions are persisted as JSONL under `~/.oh-my-cli/sessions/`. Each
non-interactive run seals the session with an atomic checkpoint (a temp file
renamed over the canonical one), so an interrupted write leaves either the
previous or the new complete checkpoint — never a half-written file. On
`--resume`, the checkpoint is recovered automatically: a complete one left by an
interrupted write is promoted, a partial one is discarded, and a corrupt one is
quarantined alongside the session (preserved, never deleted) with a warning —
without touching other sessions.

### Session compaction

A long session can be compacted into a bounded, versioned summary so it can
continue past a provider context limit without losing task or execution state.
Compaction never edits the transcript: the full JSONL stays on disk and the
summary is written to a sibling `<session-id>.compact.json` sidecar. On the next
`--resume`, the sidecar is validated against the transcript (schema, version, and
a digest of the summarized messages) and only then applied; a missing, corrupt,
or mismatched sidecar is ignored and the full transcript is used instead (fail
closed). Completed tool actions are kept as bounded, redacted receipts that the
resumed model is told **not to repeat**, so removing detailed turns never re-runs
a completed mutation.

```bash
# Write a compaction sidecar for a session (original transcript untouched) and
# print a redacted report of what will be retained.
oh-my-cli --compact <session-id>

# Resume: the validated summary is applied automatically.
oh-my-cli --resume <session-id>
```

To compact automatically during a run, set a context-pressure threshold in
tokens; when the latest provider prompt reaches it, the in-memory transcript is
compacted before the next call (the on-disk transcript is still untouched, and
the event is observable in `--output json` as a `compaction` record):

```bash
oh-my-cli -p "Long task" --compact-threshold 100000
# or: OMC_COMPACT_THRESHOLD=100000 oh-my-cli -p "Long task"
```

### Session export

Export a single session to a portable, local record for debugging, review, or
handoff — without copying raw terminal output that loses structure or leaks
credentials. The export reads the canonical session record and writes two files
next to each other: a readable Markdown transcript and a machine-readable JSON
manifest. Secrets, auth tokens, sensitive environment values, and the host home
directory are redacted **before any bytes are written**. The manifest records the
session id, redacted workspace and model, timestamps, per-tool call/result
tallies, attachment references (by name/type/size — never embedded), and a sha256
of the source session file as its evidence reference.

```bash
# Write <session-id>.session-export.md and <session-id>.session-export.manifest.json
oh-my-cli --export-session <session-id> --out ./exports

# JSON output prints the manifest and the two stable output paths.
oh-my-cli --export-session <session-id> --out ./exports --output json
```

Exports are deterministic: repeated exports of an unchanged session produce
byte-identical files (no export-time wall clock). Writes are atomic (a temp file
renamed over the canonical one, temps cleaned up on failure), and an existing
output file is never overwritten without `--force`. The export is purely local —
it performs no network or external-state action. A missing session exits non-zero;
a corrupt or partial session still exports the recoverable content with its
integrity flagged.

### Undo and redo a completed turn

An agent turn changes both the conversation and the workspace, so a wrong turn
needs a fast recovery path — but a generic `git reset` would destroy unrelated,
pre-existing work. Every non-interactive (`-p`) turn captures an explicit,
content-based checkpoint around exactly the files its mutating tools touched
(their pre-image is recorded before the tool runs) plus the turn's transcript
entries. Undo reverses only that turn — restoring each owned file to its
pre-image (or deleting a file the turn created) and trimming its messages —
while leaving user-owned and pre-existing changes in place. Redo re-applies the
turn when the undo checkpoint is still valid.

```bash
# Preview what undoing the latest turn would change (no writes).
oh-my-cli --undo-turn <session-id> --dry-run

# Undo the latest turn, then redo it.
oh-my-cli --undo-turn <session-id>
oh-my-cli --redo-turn <session-id>

# JSON output prints the structured plan/receipt.
oh-my-cli --undo-turn <session-id> --dry-run --output json
```

Undo and redo are safe by construction: no force, hard reset, branch rewrite, or
implicit stash is ever used. The operation fails closed (exit 2, nothing changed)
when a turn-owned file has diverged since the checkpoint, is in a conflicted
state, or the turn is already applied — so a failed undo/redo leaves **both** the
workspace and the transcript exactly as they were. Operations are idempotent
(re-undoing an undone turn is a no-op) and record a durable receipt tied to the
exact session and checkpoint digest. Checkpoints live in a `<session-id>.turn.json`
sidecar, so they survive a restart. The mechanism needs no Git repository and
never bypasses approval, lease, or evidence policies.

### Side questions (ask without disturbing the main task)

While a longer task is in flight, sending a quick clarification through the main
conversation can alter task state, trigger context compaction, change tool plans,
or shift the active goal. A *side question* answers that clarification against a
bounded, read-only snapshot of the active session — with tool execution and
workspace mutation disabled — and returns the answer inline **without** appending
to the main transcript, goal, workflow, or retry chain.

In the interactive shell, type `/ask <question>` to open a distinct overlay. The
pane states the context boundary and whether a provider request is active; while
it is open the main task is untouched underneath. From a settled answer you can
**Enter** to promote it into the composer (to edit or send deliberately), **c** to
copy it to the terminal clipboard, or **Esc**/**d** to dismiss. While the answer
streams, **Esc** cancels. The same command works in the plain readline fallback
(streaming the answer inline).

```bash
# Headless: ask against a session's read-only context (nothing is persisted).
oh-my-cli --side-question "which test runner does this project use?" --session <session-id>

# JSON output prints a versioned result and the context scope.
oh-my-cli --side-question "why is the build failing?" --session <session-id> --output json
```

Isolation is structural, not best-effort: the side-question runner is handed only
a provider config, a bounded context snapshot, and the question — never a session
store, goal, approval, or workspace handle — so it cannot mutate any of them. The
provider call carries no tool schemas and any tool-call event is ignored, so a
side turn can never run a tool or touch the workspace. A headless side question
leaves the source session byte-identical (transcript and every sidecar).

### Session activity stats (inspectable, no fabrication)

To see where a session's time, context, model requests, and tool activity went
without reading raw logs, open the read-only *stats view*. It is derived from the
canonical session record (the persisted messages) plus an optional live-runtime
enrichment captured during the current session, and is grouped into session
activity, context usage, model activity, tool outcomes, and elapsed/waiting time.
Every value states its provenance: a measurement is bare, an estimate (the
chars/4 context size, the bundled-price cost) is tagged `(est.)`, and a value the
provider or runtime never reported reads `n/a` — never a fabricated zero. Tool
names and failure summaries are secret-safe before they reach the view.

In the interactive shell, type `/stats` to open the overlay above the composer
(the transcript underneath is untouched); **Esc**/**q**/**d** dismiss it. The same
engine backs the headless form, so a session's numbers read identically in both.

```bash
# Headless: a read-only stats view for a session (no provider call, no mutation).
oh-my-cli --session-stats <session-id>

# Stable JSON for automation (no ANSI); add --output json.
oh-my-cli --session-stats <session-id> --output json
```

Aggregation is deterministic: counts come from the message log, so resuming a
session recomputes the same totals without double-counting restored events. A
headless read (or a freshly resumed session) has no live runtime, so model
activity, tool failures, and timing report `n/a` rather than an invented value.

### Language-server readiness and diagnostics (workspace-bound, read-only)

Hidden language-server startup or stale diagnostics can mislead both users and
agents. The read-only *language-server view* surfaces, for the active **trusted**
workspace, which configured servers are available, which binaries are missing,
and which present languages have no registered server — without ever installing
software. When servers are running it shows their readiness (starting, ready,
indexing, degraded, stopped, error) and their diagnostics, each bound to the
exact workspace, file, document version, and server instance that produced it. A
diagnostic from another workspace, a superseded document version, or a previous
server instance is rejected rather than presented as current. Unsupported
languages and missing binaries are explicit and quiet, and never block normal
CLI use; all server-supplied text is secret-safe and length-bounded.

In the interactive shell, type `/lsp` to open the overlay above the composer (the
transcript underneath is untouched, and no edits are performed); **Esc**/**q**/**d**
dismiss it. The same engine backs the headless form, so the view reads identically
in both.

```bash
# Headless: the read-only language-server view for the current workspace
# (discovery only — no install, no mutation, no edits).
oh-my-cli --lsp-status

# Stable JSON for automation (no ANSI); add --output json.
oh-my-cli --lsp-status --output json
```

Discovery is read-only and trust-gated: an untrusted workspace surfaces no
running servers. The CLI does not itself spawn language servers, so the live
list is empty in normal use; the deterministic runtime engine that produces
live, workspace-bound state (and rejects stale events) is covered by focused
tests and the end-to-end receipt.

### Background-task center (read-only monitor with durable receipts)

Long-running work — verification, evidence collection, recovery — can outlive the
turn that started it. The read-only *task center* monitors that background work
without ever performing it: it shows each task's lifecycle state (`queued`,
`running`, `waiting` on approval, `succeeded`, `failed`, `cancelled`, `orphaned`,
`recovered`) and the durable receipt a terminal task leaves behind (an opaque
digest plus an optional evidence link). Concurrency limits, leases, approval
gates, and workspace ownership stay authoritative — the center reflects them and
never grants a slot, releases a lease, or bypasses an approval. Cancellation is
idempotent and scoped to the one selected task, and a cancelled task keeps its
receipt rather than being rewritten as something else.

On restart the center reconciles recorded state against **real** process state: a
running task whose process is gone with no receipt is marked `orphaned` (never
`succeeded`), and one whose durable receipt has surfaced is marked `recovered`.
Work is never inferred complete from UI state alone. All task text is secret-safe
and length-bounded, and the home path is redacted.

In the interactive shell, type `/tasks` to open the overlay above the composer
(the transcript underneath is untouched, and no edits are performed); **Esc**/**q**/**d**
dismiss it. The same engine backs the headless form, so the view reads identically
in both.

```bash
# Headless: the read-only task-center view for a session
# (monitor only — no start, no cancel, no mutation, no edits).
oh-my-cli --tasks <session-id>

# Stable JSON for automation (no ANSI); add --output json.
oh-my-cli --tasks <session-id> --output json
```

The durable task snapshot lives in a per-session sidecar and is parsed
fail-closed: a malformed, truncated, or incompatible snapshot is rejected rather
than presented as live. The deterministic runtime engine that drives the state
machine, concurrency, cancellation, and restart reconciliation is covered by
focused tests and the end-to-end receipt.

### Options

| Option | Description |
|---|---|
| `-p, --prompt <prompt>` | Run a single non-interactive request |
| `--image <paths...>` | Attach image file(s) by path for vision-capable analysis (PNG, JPEG, GIF, or WebP); also `/attach` in interactive mode |
| `--resume <session-id>` | Resume a persisted session |
| `--browse-sessions` | Interactively browse, search, and resume a previous session (requires a terminal) |
| `--list-sessions` | List resumable sessions with a redacted usage summary and exit |
| `--session-stats <session-id>` | Show a read-only, deterministic activity/efficiency stats view for a session (add `--output json` for automation) and exit; also `/stats` in interactive mode |
| `--lsp-status` | Show the read-only, workspace-bound language-server discovery and readiness view for the current workspace (add `--output json` for automation) and exit; also `/lsp` in interactive mode |
| `--tasks <session-id>` | Show the read-only background-task center for a session — lifecycle states, durable receipts, and restart reconciliation (add `--output json` for automation) and exit; also `/tasks` in interactive mode |
| `--export-session <session-id>` | Export a session locally as redacted Markdown + a deterministic JSON manifest and exit |
| `--out <dir>` | Output directory for `--export-session` (default: current directory) |
| `--force` | Overwrite existing `--export-session` output files |
| `--compact <session-id>` | Compact a session into a bounded summary sidecar (original transcript preserved) and exit |
| `--compact-threshold <tokens>` | Auto-compact the in-memory transcript when the latest prompt size reaches this (also honors `OMC_COMPACT_THRESHOLD`) |
| `--undo-turn <session-id>` | Safely undo the most recent completed agent turn of a session (restores its files + transcript) and exit |
| `--redo-turn <session-id>` | Redo the most recent undone agent turn of a session and exit |
| `--dry-run` | Preview an `--undo-turn`/`--redo-turn` plan without changing the workspace or transcript |
| `--side-question <text>` | Ask a side question against a session's bounded, read-only context (no tools, no mutation, nothing persisted) and exit; also `/ask` in interactive mode |
| `--session <session-id>` | Source session whose read-only context seeds `--side-question` |
| `--approval-mode <mode>` | `default`, `auto-edit`, or `yolo` |
| `--workspace <dir>` | Workspace directory (default: cwd) |
| `--doctor` | Run read-only installation/platform readiness checks and exit |
| `--readiness` | Inspect repository readiness for a blocked task (read-only) and exit |
| `--expected-branch <name>` | Expected branch for the `--readiness` branch check |
| `--remote <name>` | Git remote to probe for `--readiness` (default `origin`) |
| `--repo-context` | Inspect a bounded, redacted repository context snapshot (read-only) and exit |
| `--repo-map` | Inspect a bounded, ranked repository map of key files and top-level symbols (read-only) and exit |
| `--map-tokens <n>` | Token budget for `--repo-map` (default `1024`; ~4 chars per token) |
| `--instruction-context` | Inspect the effective, redacted repository instruction context a fresh session is seeded with (read-only) and exit |
| `--plan <task>` | Produce a bounded, deterministic execution plan for a task (read-only) and exit |
| `--verify-task` | Run the repository's canonical verify commands and report a bounded, head-bound pass/fail verdict and exit |
| `--review-change` | Review the current change against a base ref and emit a bounded, redacted, head-bound review brief and exit |
| `--base <ref>` | Base ref for `--review-change`, `--ci-handoff`, and `--delivery-brief` (default `origin/main`, then `HEAD`) |
| `--ci-handoff` | Compose verify and review into a bounded, redacted, head-bound CI handoff brief and exit |
| `--delivery-brief` | Compose plan, verify, review, and CI handoff into a bounded, redacted, head-bound completion verdict and exit |
| `--ci-result <state>` | CI outcome for `--delivery-brief`: `pass`, `fail`, or `pending` (default `pending`) |
| `--provider-contract` | Inspect the resolved provider extension contract from settings (read-only, redacted) and exit |
| `--provider <id>` | Provider id to select for `--provider-contract` / `--invoke-provider` (defaults to `settings.providers.default` or the sole entry) |
| `--invoke-provider` | Issue one bounded model request to the resolved-`ready` provider from settings once, gated by approval mode, bounded and redacted, and exit |
| `--provider-prompt <text>` | Prompt to send for `--invoke-provider` (defaults to a minimal safe ping) |
| `--mcp-contract` | Inspect the resolved MCP server extension contract from settings (read-only, redacted) and exit |
| `--server <id>` | MCP server id to select for `--mcp-contract` / `--invoke-mcp` (defaults to `settings.mcp.default` or the sole entry) |
| `--invoke-mcp` | Connect to the resolved-`ready` MCP server from settings once and call one of its tools, gated by approval mode and command policy, confined and redacted, and exit |
| `--mcp-tool <name>` | Tool name to call for `--invoke-mcp` (defaults to the sole exposed tool) |
| `--mcp-arg <key=value>` | Argument for the MCP tool call (repeatable), parsed as `key=value` with string values |
| `--tool-contract` | Inspect the resolved tool extension contract from settings (read-only, redacted) and exit |
| `--tool <id>` | Tool id to select for `--tool-contract` / `--invoke-tool` (defaults to `settings.tools.default` or the sole entry) |
| `--invoke-tool` | Invoke the resolved-`ready` tool extension from settings once, gated by approval mode and command policy, confined and redacted, and exit |
| `--invoke-timeout <ms>` | Hard timeout in milliseconds for `--invoke-tool` / `--invoke-mcp` / `--invoke-provider` (default `30000`, max `300000`) |
| `--discover-extensions` | Discover the declared provider, MCP, tool, and workflow extension contracts and readiness from settings (read-only, redacted) and exit |
| `--extension-compat` | Report the supported provider, tool, MCP, and workflow contract versions and a redacted settings-file compatibility verdict (read-only) and exit |
| `--no-probe` | Skip the bounded lifecycle probe for `--mcp-contract` / `--tool-contract` / `--discover-extensions` / `--trust-posture` and report the declared state |
| `--list-workflows` | List the reusable workflows declared in user settings (read-only, redacted) and exit |
| `--run-workflow <name>` | Run a named workflow from user settings non-interactively (sequential headless steps; a failing step halts) and exit |
| `--output <format>` | `-p` output format: `text` (default) or `json` (headless event stream) |
| `--no-color` | Disable ANSI color output (also honors a non-empty `NO_COLOR` env var) |
| `--summary` | Print a privacy-safe execution summary for the run (unattended use) |
| `--budget <usd>` | Spend budget in USD; stop before further provider calls once the estimated cost reaches it (also honors `OMC_SPEND_BUDGET_USD`) |
| `--baseline <file>` | Baseline run-summary file to compare in scorecard mode |
| `--candidate <file>` | Candidate run-summary file to compare in scorecard mode |
| `--max-elapsed-ratio <n>` | Scorecard regression threshold: fractional elapsed-time increase tolerated (default `0.25`) |
| `--max-failure-delta <n>` | Scorecard regression threshold: tool-failure increase tolerated (default `0`) |
| `--recover` | Resume an interrupted task from a recovery checkpoint (read-only) and exit |
| `--checkpoint <file>` | Recovery checkpoint file for `--recover` |
| `--task-identity <id>` | Stable task identity (used by `--recover` and worktree leases) |
| `--evidence <file>` | Current evidence file (JSON `stepId -> digest`) for `--recover` |
| `--export-evidence <file>` | Export a portable, signed evidence bundle to `<file>` and exit |
| `--verify-evidence <file>` | Verify a portable evidence bundle offline and exit |
| `--summary-file <file>` | Run-summary file to include in `--export-evidence` |
| `--outcomes-file <file>` | Command-outcomes file (JSON array) to include in `--export-evidence` |
| `--create-worktree` | Create a leased git worktree for a mutating delegated agent and exit |
| `--clean-worktree` | Clean a leased git worktree after verified completion and exit |
| `--agent-identity <id>` | Stable agent identity for a leased worktree (with `--create-worktree`/`--clean-worktree`) |
| `--worktree-root <dir>` | Directory where leased worktrees live (default `<workspace>/.oh-my-cli/worktrees`) |
| `--command-policy <command>` | Evaluate one shell command against the offline command policy and exit |
| `--provenance <source>` | Command provenance for `--command-policy`: `builtin`, `repository` (default), or `issue` |
| `--trust-info` | Show the folder-trust decision for the workspace (read-only) and exit |
| `--trust` | Trust this workspace for this run only (not persisted) |
| `--trust-workspace` | Persist trust for this workspace in the user trust store and exit |
| `--enforce-folder-trust` | Deny mutating tools when the workspace is untrusted (env: `OMC_ENFORCE_FOLDER_TRUST=1`) |
| `--trust-posture` | Show the effective, redacted workspace trust, sandbox, approval, and extension posture (read-only) and exit |

Color is enabled by default in the interactive REPL and command palette. Pass
`--no-color` or set a non-empty `NO_COLOR` environment variable (per
[no-color.org](https://no-color.org)) for CI-friendly plain output; an empty
`NO_COLOR` is ignored.

### Approval modes

- **default** — prompt interactively for every mutating tool; deny when no TTY.
- **auto-edit** — allow `write` and `edit`; still prompt for `shell` and deny without TTY.
- **yolo** — allow all tools without prompting (unsafe).

Read operations never require approval.

### Approval preview is spoof-resistant

Before a mutating tool is approved, the CLI shows a redacted preview of what it
will touch — the shell command and the file paths (`src/permission-impact.ts`) —
and the command-policy decision/denial renders the same way
(`src/command-policy.ts`). Both surfaces neutralize spoofing Unicode before
display: bidirectional override/isolate controls (e.g. U+202A–U+202E and
U+2066–U+2069), zero-width characters (e.g. U+200B–U+200D, U+FEFF, and U+2060),
and look-alike quote marks. Each such character is replaced with a visible
`[U+XXXX]` marker and counted, so untrusted content (a file the agent read, a
repository, an Issue, or a relayed message) cannot visually reorder or disguise
the preview into a "Trojan Source"-style trap. Secret redaction, home-path
collapsing, whitespace collapsing, and size truncation are unchanged, and
ordinary commands render identically aside from any marker.

### Folder trust

Before any project-controlled instruction, setting, hook, extension, or mutating
tool can affect a run, the CLI decides whether the workspace folder is trusted.
This is the top-level safety boundary: it is **fail closed** and **approval modes
are subordinate to it** — `--approval-mode yolo` cannot widen it, and read-only
tools (`read`/`list`/`glob`/`grep`) are always permitted.

A workspace is **untrusted by default**. Trust is granted only by an explicit
user act, recorded in a **user-owned** store at `~/.oh-my-cli/trust.json` that a
project can never write — so an untrusted repository cannot trust itself or
select its own model endpoint, credential source, hooks, or mutating tools. The
canonical workspace key collapses symlink aliases and linked git worktrees to one
identity, so a subagent or leased worktree inherits its parent's trust (equal
isolation) rather than escaping it.

The decision distinguishes four states, in both interactive and headless modes:

| State | Mutation | Meaning |
|---|---|---|
| `trusted` | permitted | Workspace is in the user trust store (or `--trust` for this run) |
| `sandbox-enforced` | permitted | An effective sandbox is enforced around tool execution (`OMC_SANDBOX=enforced`) |
| `untrusted` | denied | Not trusted and no sandbox; mutating tools fail closed |
| `sandbox-unavailable` | denied | Not trusted and a sandbox is required (`OMC_REQUIRE_SANDBOX=1`) but unavailable |

Enforcement is **opt-in** so existing runs are unchanged: pass
`--enforce-folder-trust` (or set `OMC_ENFORCE_FOLDER_TRUST=1`) to deny mutating
tools when the workspace is untrusted. Grant or inspect trust with:

```bash
# Show the folder-trust decision for the workspace (read-only) and exit
oh-my-cli --trust-info --enforce-folder-trust --workspace path/to/repo

# Trust this workspace for one run (not persisted)
oh-my-cli -p "…" --enforce-folder-trust --trust

# Persist trust for this workspace in the user trust store
oh-my-cli --trust-workspace --workspace path/to/repo
```

```text
Folder Trust
────────────────────────────────────────
Workspace:   ~/code/unfamiliar-repo
Trust state: untrusted
Sandbox:     none
Mutation:    DENIED (fail closed)
Enforcing:   yes
Reason:      Workspace is not trusted; mutating tools fail closed.
```

The trust store fails closed on any missing, malformed, or wrong-schema file
(nothing trusted) rather than widening trust. All diagnostics redact the host
home directory to `~` and never emit secrets. `--trust-info` is a read-only
diagnostic (always exit `0`), not a gate.

**Trust posture.** Before running unattended or delegating mutating work,
`--trust-posture` composes the folder-trust decision, sandbox isolation, approval
mode, and extension readiness (`--discover-extensions`, spanning the provider,
MCP, tool, and workflow contracts) into one redacted, read-only view — answering
"is this run confined the way I expect, and what will it be allowed to do?"
without running each diagnostic separately.

```bash
oh-my-cli --trust-posture --workspace path/to/repo
oh-my-cli --trust-posture --workspace path/to/repo --output json
# show the approval dimension and resolve extensions without probing
oh-my-cli --trust-posture --approval-mode yolo --no-probe
```

It is an **audit, not a gate**: it never mutates the trust store or settings and
always exits `0`. The approval mode is reported as subordinate to folder trust —
the mutation line states `permitted`, `DENIED (fail closed)` (untrusted while
enforcing), or `would be denied if enforcement were on` (untrusted, advisory). An
invalid extension contract is surfaced as a visible warning rather than thrown
(the runtime contract resolvers still fail closed on their own). Add
`--output json` for a versioned record (`schema` `oh-my-cli.trust-posture`).

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
  (`ok` reflects success), `usage` (cumulative tokens and cost estimate per
  round, with budget state), `retry` (a transient provider failure is retried
  with bounded backoff), `error` (`stage` is `provider` or `internal`), and a
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
exit code, classified reason, elapsed time, rounds, provider retries, bounded
tool-call/failure counts, token totals, and a cost estimate — and never carries
prompt, tool, or file content. Secret-shaped strings are redacted and the host home directory is
collapsed to `~`, so the session log path stays private.

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
# retries:   0
# tool calls: 1 (shell×1)
# tokens:    prompt 5, completion 5, total 10
# est. cost: $0.000090 (estimate, not billing)
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
{"protocol":"oh-my-cli.headless","v":1,"seq":3,"ts":"…","type":"summary","summary":{"schema":"oh-my-cli.summary","v":1,"outcome":"success","exitCode":0,"reason":"completed","elapsedMs":2000,"rounds":1,"retries":0,"toolCalls":{"total":1,"byName":{"shell":1}},"toolFailures":{"total":0,"byName":{}},"tokens":{"prompt":5,"completion":5,"total":10},"estimatedCostUsd":0.00009,"evidence":{"sessionId":"01J…","sessionPath":"~/.oh-my-cli/sessions/01J….jsonl"}}}
```

The `outcome` is `success` or `failure`; on failure the `reason` classifies the
terminal state (`provider_error`, `max_rounds`, `budget_reached`, or `error`) and
the `exitCode` preserves the process exit code, so a wrapper can compare the
summary against `$?`. Distinct tool names are capped (overflow rolls into
`__other__`) to keep the summary bounded regardless of how many tools a run
touched.

### Provider cost and spend budget

Token usage is surfaced as it accrues: in `--output json` mode a `usage` event
is emitted once per round with cumulative prompt/completion/total tokens, a cost
estimate, and the budget state, and the run summary carries the same estimated
cost. The cost is an **estimate from a bundled price table, never authoritative
billing** — models not in the table fall back to a conservative rate and are
flagged as unknown (`costKnown: false`), so an unlisted model is over-counted
rather than under-counted.

To cap an unattended run, pass a spend budget in USD with `--budget` (or the
`OMC_SPEND_BUDGET_USD` environment variable; the flag takes precedence). Once the
running estimate reaches the cap, the loop **stops before issuing further
provider calls** — no additional billable calls are made — and the run ends with
reason `budget_reached` (exit `1` in headless mode; an actionable
`Spend budget reached …` line is printed to stderr otherwise). The budget is
checked before each call, so the first call always runs and the estimate is
cumulative across rounds. An invalid budget (non-positive or non-numeric) fails
fast before any provider call.

```bash
# Cap a run at half a cent; it stops before spending more
oh-my-cli -p "Refactor the parser" --budget 0.005 --output json --summary
```

### Provider transient-error retry

Transient provider failures — HTTP `429`, `500`/`502`/`503`/`504`, and retryable
network errors (`ECONNRESET`, `ETIMEDOUT`, …) — are retried automatically with
bounded exponential backoff, so a momentary blip doesn't fail an otherwise
healthy run. The policy is **bounded** for unattended use: at most 3 attempts,
each wait capped at 2 seconds, so the worst-case added latency is small and can
never hang. A server `Retry-After` header is honored (clamped to the per-attempt
cap). Non-retryable failures (auth, invalid request, unsupported model) surface
immediately without a retry.

A retry happens only **before any output for that attempt is produced**, so a
mid-stream failure is never silently restarted (which would duplicate partial
assistant text). Each retry is observable:

- In `--output json` mode a `retry` event carries the upcoming `attempt`,
  `maxAttempts`, a `reasonClass` (`rate_limited`, `server_error`, or
  `network_error`), and the scheduled `delayMs`.
- The run summary reports the run's total `retries`, so a consumer can
  distinguish an exhausted-retry failure (`retries > 0`, then `provider_error`)
  from a non-retryable one (`retries: 0`).

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

### Evidence archive

Run summaries and recovery checkpoints are otherwise machine-local, which makes
independent audit and regression reproduction hard. `--export-evidence` bundles
the durable, already-redacted evidence of a run — the versioned run summary,
recovery checkpoint metadata, command outcomes, and content digests — into one
portable, deterministic JSON archive with a signed manifest. `--verify-evidence`
checks that archive offline.

The bundle carries only metadata and digests — **never prompts, raw tool
payloads, credentials, or absolute host paths** (free-form values are
secret-redacted and the home directory is collapsed to `~`). It is built for
three guarantees:

- **Privacy** — no sensitive content reaches the archive.
- **Determinism** — identical normalized evidence yields byte-identical bytes
  (sorted keys, entries ordered by name, no wall-clock timestamps).
- **Integrity** — each entry carries a sha256 of its content and the manifest
  carries a sha256 signature, so verification fails closed on any missing,
  extra, reordered, or modified entry. ("Signed" is a deterministic integrity
  digest — there is deliberately no key management in this slice.)

```bash
# Export one portable bundle from a run's artifacts
oh-my-cli --export-evidence evidence-bundle.json \
  --summary-file summary.json \
  --checkpoint checkpoint.json \
  --outcomes-file outcomes.json \
  --task-identity deploy-task

# Verify a bundle offline (human or machine-readable)
oh-my-cli --verify-evidence evidence-bundle.json
oh-my-cli --verify-evidence evidence-bundle.json --output json
```

```text
Evidence archive (oh-my-cli.evidence-archive v1)
────────────────────────────────────────
task:      deploy-task
outcome:   success
repo head: 3a61045b781f27e95b496ede6dfd23d0b63a6b4b
entries:   3
  - checkpoint (checkpoint-metadata) 2f0cf65114dd…
  - command-outcomes (command-outcomes) e8638708332b…
  - run-summary (run-summary) e6b89a9f130a…
signature: 3768d82e18366cff751258b98761ec87506b011c34e72e0923e645819e32bcbb
```

The exit code is a documented contract:

- `--export-evidence`: `0` on success, `2` on a usage/input error (no inputs, or an unreadable/malformed artifact).
- `--verify-evidence`: `0` when the bundle is intact, `1` when it is tampered, `2` on a usage error (unreadable/malformed bundle).

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

### Repository context

To see how the CLI models the repository it is working in — before entrusting it
with a task — run a read-only context probe:

```bash
oh-my-cli --repo-context
# or point it at another checkout
oh-my-cli --repo-context --workspace path/to/repo
```

It reports the toolchain (package manager + lockfile), the canonical
`build`/`test`/`typecheck`/`lint` commands resolved from `package.json` scripts,
`Makefile` targets, or `pyproject.toml` tool sections (reported, never run), the
primary languages by a bounded file-extension signal, a bounded top-level
structure outline, and the current VCS state (branch and clean/dirty). The probe
inspects workspace-local files and Git metadata only; it never installs,
creates, edits, executes, fetches into, or otherwise mutates anything, and
secrets and host paths stay redacted.

```text
Repository context (oh-my-cli.repo-context v1)
──────────────────────────────────────────────
Toolchains : npm (package.json, package-lock.json)
Commands   :
  build      [package.json] tsc
  test       [package.json] vitest run tests/unit
  typecheck  [package.json] tsc --noEmit
  lint       —
Languages  : TypeScript (84 files; .ts), Markdown (6 files; .md), JSON (3 files; .json)
Structure  : src/  tests/  docs/  package.json  tsconfig.json  …
VCS        : on "main" — clean
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.repo-context`)
that a downstream planning or verification step can parse independently. The
probe is a snapshot, not a gate, so it always exits `0`; an unknown toolchain
degrades gracefully (reports `unknown` rather than failing).

### Repository map

A fresh session otherwise starts with no automatic view of the workspace: to use
existing code the model must be told which files to read or guess paths. To give
it a concise, always-current overview, the CLI builds a bounded, ranked map of
the workspace's key files and their top-level symbols (signatures only) and
injects it into every fresh session's context, so the model can locate relevant
code and reuse existing abstractions. Inspect the same map directly:

```bash
oh-my-cli --repo-map
# point it at another checkout, and/or set the token budget (default 1024)
oh-my-cli --repo-map --workspace path/to/repo --map-tokens 512
```

The map honors `.gitignore` and a built-in skip set, never follows symlinks (so
it cannot escape the workspace), and excludes binary and likely-secret paths.
Only declaration signatures are surfaced — never file bodies — and every
signature is secret-redacted and length-capped. Files are ranked by relevance
(symbol density, entry-point and source-dir bonuses, depth and test penalties),
each file shows at most its first key declarations, and the rendered map is
clipped to the token budget (≈4 chars per token), so a large repository stays
responsive and cannot flood context.

```text
Repository map (oh-my-cli.repo-map v1)
──────────────────────────────────────
Files      : 10 of 179 symbol-bearing; budget 4096 chars, used 4073
src/index.ts
  export function main()
  export class App
…
… truncated: 169 more symbol-bearing file(s) omitted
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.repo-map`). The
map is a snapshot, not a gate, so it always exits `0`; an empty, untrusted, or
unreadable workspace yields an explicit, non-destructive result rather than a
crash.

### Instruction context

Every fresh model-backed session is seeded with the *effective* instruction
context instead of a generic "you are a helpful coding assistant" prompt. To see
exactly what a session will load — and why — run a read-only probe:

```bash
oh-my-cli --instruction-context
# or point it at another checkout
oh-my-cli --instruction-context --workspace path/to/repo
```

It discovers supported instruction files (`QWEN.md`, `AGENTS.md`) from the
trusted workspace hierarchy — the workspace root plus a bounded walk of its
ancestor directories — and reports each source's trust class, precedence, byte
size, and content fingerprint. Files inside the workspace are `workspace` trust;
files in a strict ancestor directory are `ancestor` trust and lower precedence,
so an out-of-workspace instruction can never override the workspace's own policy
on conflict. A symlinked instruction file whose real path escapes its directory
is rejected (recorded as `symlink-escape`). All content is treated strictly as
data — it can never activate tools, change configuration, or override any policy
or safety boundary — and secrets, spoofing characters, and host paths stay
redacted.

```text
Instruction context (oh-my-cli.instruction-context v1)
──────────────────────────────────────────────
Loaded     : 1 file(s)
Sources    :
  [workspace] QWEN.md — prec 91, 348 bytes
Fingerprint: 9f2c4e…
```

Add `--output json` for a versioned record (`schema`
`oh-my-cli.instruction-context`) whose `combinedText` is the framed block injected
into the session prompt and whose `fingerprint` changes iff that block does. The
probe is a snapshot, not a gate, so it always exits `0`; an empty workspace
degrades gracefully (no sources, empty `combinedText`).

### Task planning

Before entrusting the agent with a task, derive a bounded, deterministic plan
grounded in the repository context — so execution has an objective sequence a
later verification or review step can check against:

```bash
oh-my-cli --plan "add a feature"
# or point it at another checkout
oh-my-cli --plan "fix a bug" --workspace path/to/repo
```

It emits a fixed, dependency-ordered phase sequence — `understand → implement →
verify → review` — whose `verify` step is grounded in the canonical
`build`/`test`/`typecheck`/`lint` commands the repository-context probe actually
detected (listed, never run). The objective and every command are secret-redacted
and bounded, and the plan is deterministic for fixed inputs (same task + same
repository state → same plan). The planner inspects the workspace only; it never
executes the commands it lists, never calls a provider, and never mutates
anything. When no canonical verification command is detected, the `verify` step
degrades gracefully to a manual-verification note rather than inventing commands.

```text
Task plan (oh-my-cli.plan v1)
──────────────────────────────────────────────
Objective : add a feature
Toolchain : npm
Steps     :
  1. understand Read the relevant files and the repository context (toolchain: npm) before editing.
  2. implement  Make the minimal change described by the objective, confined to the workspace.
  3. verify     Run the detected verification commands and confirm they pass before finishing.
       - tsc
       - vitest run tests/unit
       - tsc --noEmit
  4. review     Summarize the change and produce completion evidence (diff and test results).
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.plan`) whose
`steps` array carries the ordered phases and whose `verifyCommands` lists the
grounded verification commands. An empty task description is rejected (exit `2`);
an unknown toolchain degrades gracefully rather than failing.

### Task verification

After a change, get an objective, machine-checkable answer to "does this
repository actually pass its own build/test/typecheck/lint?" `--verify-task`
runs the *same* canonical commands the planner lists — `build → test →
typecheck → lint`, as detected from the repository context — against the
workspace, with a bounded per-command timeout and bounded output capture, and
reports a pass/fail verdict bound to the repository head:

```bash
oh-my-cli --verify-task
# or verify another checkout
oh-my-cli --verify-task --workspace path/to/repo
```

It runs only the commands the repository itself declares (the same ones a
developer runs by hand) and never accepts arbitrary command strings. Captured
output is secret-redacted and the absolute workspace path is scrubbed; the
command set is exactly what `--plan` reports. The verdict is `pass` only when
every detected command passes, `fail` if any fails, or `no-verify-commands`
when none are detected (not a failure). Exit code: `0` pass/none-detected, `1`
any failure, `2` usage error.

```text
Task verification (oh-my-cli.task-verify v1)
──────────────────────────────────────────────
Head   : 9f53e65c64b8dbd9a2616e61d4db18a62ea298ed
Verdict: pass
Commands:
  [PASS] build      tsc  (exit 0, 1180ms)
  [PASS] test       vitest run tests/unit  (exit 0, 8423ms)
  [PASS] typecheck  tsc --noEmit  (exit 0, 1095ms)
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.task-verify`)
whose `head` binds the verdict to the repo head and whose `results` array
carries each command's exit code, pass flag, duration, and redacted output tail.

### Change review

Before opening or merging a PR, get an objective, machine-checkable answer to
"what does this change actually alter, and does it introduce an obvious,
reviewable risk?" `--review-change` computes the change set between a base ref
(default `origin/main`, then `HEAD`) and the current head/worktree using Git
only, and emits a bounded, redacted, head-bound review brief:

```bash
oh-my-cli --review-change
# or review against an explicit base
oh-my-cli --review-change --base origin/main --workspace path/to/repo
```

It runs no commands and calls no provider; every signal is objective and
reproducible. Secret-like content is reported only as a count (never literals)
and the absolute workspace path never appears in the output. The verdict is
`needs-attention` when any objective signal fires — a secret-like string
introduced, a protected governance/security/license path mutated, source
changed without a corresponding test change, an oversized change, or a new
runtime dependency added — `clean` otherwise, or `no-change` for an empty diff.
Exit code: `0` clean/no-change, `1` needs-attention, `2` usage error.

```text
Change review (oh-my-cli.change-review v1)
──────────────────────────────────────────────
Head   : 2426b8272da5c9d56c9d0a4b9355eaa5e6b6f8ac
Base   : origin/main (9f53e65c64b8dbd9a2616e61d4db18a62ea298ed)
Verdict: clean
Changes: 3 file(s), +410 -0
Files:
  A  src/change-review.ts  (+180 -0)
  M  src/index.ts  (+24 -0)
  A  tests/unit/change-review.test.ts  (+206 -0)
Signals:
  Secrets introduced : 0 added line(s)
  Protected paths    : none
  Source w/o tests   : no
  Oversized change   : no
  Runtime deps       : n/a
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.change-review`)
whose `head` binds the brief to the repo head and whose `signals` object carries
each objective risk signal.

### CI handoff

At the CI boundary, get one objective answer to "is this change safe to hand to
CI, and what should CI run?" `--ci-handoff` composes the verify and review
slices into a single bounded, redacted, head-bound handoff brief: the exact
commit, the canonical commands CI should run with their **local** pass/fail
status, the change summary and review signals, and any local blocker that must
be cleared first.

```bash
oh-my-cli --ci-handoff
# or hand off against an explicit base
oh-my-cli --ci-handoff --base origin/main --workspace path/to/repo
```

It runs only the repository's own canonical verify commands (the same ones
`--verify-task` runs); it never mutates the repository or governance paths and
never calls a provider. Secret-like content is reported only as a count (never
literals) and the absolute workspace path never appears in the output. The
verdict is `local-blockers` when an introduced secret, a mutated protected
governance path, or a failing local verify is present; `no-change` when nothing
changed; otherwise `ready-for-ci`. Exit code: `0` ready-for-ci/no-change, `1`
local-blockers, `2` usage error.

```text
CI handoff (oh-my-cli.ci-handoff v1)
──────────────────────────────────────────────
Head   : 2426b8272da5c9d56c9d0a4b9355eaa5e6b6f8ac
Base   : origin/main (9f53e65c64b8dbd9a2616e61d4db18a62ea298ed)
Verdict: ready-for-ci
Change : 3 file(s), +410 -0
Commands for CI:
  [PASS] build      tsc  (exit 0)
  [PASS] test       vitest run tests/unit  (exit 0)
  [PASS] typecheck  tsc --noEmit  (exit 0)
Review signals:
  Secrets introduced : 0 added line(s)
  Protected paths    : none
  Source w/o tests   : no
  Oversized change   : no
  Runtime deps added : none
Blockers: none
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.ci-handoff`)
whose `head` binds the brief to the repo head and whose `commands`, `review`,
and `blockers` fields carry the handoff evidence.

### Delivery brief

After CI finishes, get one objective answer to "is this change ready to ship?"
`--delivery-brief` composes the plan, verify, review, and CI-handoff slices with
a bounded CI result into a single bounded, redacted, head-bound completion
verdict: `ship`, `hold`, or `no-ship`. It is the capstone of the verify → review
→ handoff → deliver arc — the pre-CI handoff brief answers "is this safe to hand
to CI?", while the delivery brief answers "is this clear to ship?" once the CI
result is known.

```bash
oh-my-cli --delivery-brief --ci-result pass
# or deliver against an explicit base
oh-my-cli --delivery-brief --ci-result pass --base origin/main --workspace path/to/repo
```

The CI outcome is a bounded, validated input (`--ci-result pass|fail|pending`,
default `pending`) so the verdict stays deterministic and offline. It runs only
the repository's own canonical verify commands (via the handoff slice); it never
mutates the repository or governance paths and never calls a provider. Secret-
like content is reported only as a count (never literals) and the absolute
workspace path never appears in the output. The verdict is `no-ship` when an
introduced secret, a mutated protected governance path, a failing local verify,
or a failed CI is present; `hold` when there is no change to deliver, CI is still
pending, or the plan has no grounded verification command; otherwise `ship`. Exit
code: `0` ship, `1` hold/no-ship, `2` usage error.

```text
Delivery brief (oh-my-cli.delivery-brief v1)
──────────────────────────────────────────────
Head   : 2426b8272da5c9d56c9d0a4b9355eaa5e6b6f8ac
Base   : origin/main (9f53e65c64b8dbd9a2616e61d4db18a62ea298ed)
Verdict: ship
Change : 3 file(s), +410 -0
Signals:
  plan     grounded
  verify   pass
  review   clean
  handoff  ready-for-ci
  ci       pass
Blockers: none
Holds: none
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.delivery-brief`)
whose `head` binds the verdict to the repo head and whose `signals`, `blockers`,
and `holds` fields carry the completion evidence.

### Provider contract

The CLI's model configuration is a flat set of env-derived settings. To adapt the
CLI to a different provider without forking the core, declare one or more
providers as a **versioned extension contract** in the same unified settings file
(`~/.oh-my-cli/settings.json`, or `--settings <path>`). `--provider-contract`
negotiates the contract version, selects one provider, and resolves its
non-secret configuration — read-only, redacted, and without changing core code.

```json
{
  "providers": {
    "contractVersion": 1,
    "default": "alt",
    "entries": [
      {
        "id": "alt",
        "baseUrl": "https://alt.example/v1",
        "model": "alt-model",
        "models": ["alt-small", "alt-large"],
        "apiKeyEnv": "ALT_KEY",
        "capabilities": { "vision": true }
      }
    ]
  }
}
```

```bash
oh-my-cli --provider-contract
# select one explicitly when several are declared
oh-my-cli --provider-contract --provider alt --output json
```

The contract is untrusted input. The credential is supplied by an
environment-variable name (`apiKeyEnv`, or `OPENAI_API_KEY` when absent) and its
value is never printed; a raw credential field (e.g. `apiKey`) inside an entry is
rejected rather than ignored; an unsupported `contractVersion` fails closed
instead of being silently coerced. Selection is deterministic: an explicit
`--provider` id wins, then `settings.providers.default`, then the sole entry;
ambiguity or an unknown id fails with a clear reason. The resolved endpoint is
reduced to its host and the home path is collapsed to `~`. Credential
availability is reported (`credentialAvailable`) but not gated, so the contract
stays inspectable even when the credential is not currently exported. Exit code:
`0` on success, `2` on a contract/usage error.

```text
Provider:     alt
Contract:     oh-my-cli.provider-contract v1 (settings contract version 1)
Endpoint:     alt.example (settings)
Model:        alt-model
Catalog:      alt-small, alt-large
Credential:   ALT_KEY
Capabilities: vision
Settings:     ~/.oh-my-cli/settings.json
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.provider-contract`)
carrying the negotiated `contractVersion`, the selected `providerId`, the redacted
`endpoint`, `modelCatalog`, `capabilities`, and credential provenance.

### MCP server contract

The bounded health inventory (`--health`) lists every configured MCP server
and extension with a health category — a read-only snapshot. To *depend on* one
MCP server as a governed extension, declare it as a **versioned contract** in the
same unified settings file (`~/.oh-my-cli/settings.json`, or `--settings <path>`).
`--mcp-contract` negotiates the contract version, deterministically selects one
server, and resolves its lifecycle state — read-only, redacted, and without
changing core code.

```json
{
  "mcp": {
    "contractVersion": 1,
    "default": "filesystem",
    "entries": [
      {
        "id": "filesystem",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "capabilities": { "tools": true }
      }
    ]
  }
}
```

```bash
oh-my-cli --mcp-contract
# select one explicitly when several are declared
oh-my-cli --mcp-contract --server filesystem --output json
# resolve the declaration without probing (declared state)
oh-my-cli --mcp-contract --no-probe
```

This slice is limited to safe local/stdio transport: a server's `command` is
resolved on `PATH` but **never executed**, so probing cannot run arbitrary code.
Remote (http/sse) transports are refused (fail closed) in contract version 1. The
contract is untrusted input — a raw credential field inside an entry is rejected
rather than ignored, and an unsupported `contractVersion` fails closed instead of
being silently coerced. Selection is deterministic: an explicit `--server` id
wins, then `settings.mcp.default`, then the sole entry; ambiguity or an unknown id
fails with a clear reason.

The selected server resolves to one lifecycle state with safe failure defaults:
`declared` (valid contract, not probed — via `--no-probe`), `ready` (the command
is resolvable), or `isolated` (disabled, misconfigured, command missing, or the
bounded probe timed out). A disabled or unavailable server resolves to `isolated`
and the command still exits `0` — the consumer skips it without crashing. A
contract/usage error exits `2`. Argument values are never printed (only their
count) and the home path is collapsed to `~`.

```text
Server:       filesystem
Contract:     oh-my-cli.mcp-contract v1 (settings contract version 1)
Transport:    stdio
Command:      npx
Arguments:    3
Enabled:      true
State:        ready [command resolved]
Probe:        1ms (timeout 3000ms)
Capabilities: tools
Settings:     ~/.oh-my-cli/settings.json
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.mcp-contract`)
carrying the negotiated `contractVersion`, the selected `serverId`, `transport`,
`command`, `argCount`, the resolved `state` and `reason`, and `probeMs`.

### Tool contract

The built-in tool registry defines the agent's own capabilities (read, write,
shell). To *depend on* an external tool as a governed extension — a local
executable an operator declares for the core and non-interactive automation to
hand off to — declare it as a **versioned contract** in the same unified settings
file (`~/.oh-my-cli/settings.json`, or `--settings <path>`). `--tool-contract`
negotiates the contract version, deterministically selects one tool, and resolves
its readiness state — read-only, redacted, and without changing core code. It
completes the provider/tool/MCP contract triad alongside `--provider-contract`
and `--mcp-contract`.

```json
{
  "tools": {
    "contractVersion": 1,
    "default": "ripgrep",
    "entries": [
      {
        "id": "ripgrep",
        "kind": "command",
        "command": "rg",
        "args": ["--json"],
        "capabilities": { "readOnly": true, "filesystem": true }
      }
    ]
  }
}
```

```bash
oh-my-cli --tool-contract
# select one explicitly when several are declared
oh-my-cli --tool-contract --tool ripgrep --output json
# resolve the declaration without probing (declared state)
oh-my-cli --tool-contract --no-probe
```

This slice is limited to the safe local `command` kind: a tool's `command` is
resolved on `PATH` but **never executed**, so probing cannot run arbitrary code.
Remote or network tools (a `url` field or a non-`command` kind) are refused (fail
closed) in contract version 1. The contract is untrusted input — a raw credential
field inside an entry is rejected rather than ignored, and an unsupported
`contractVersion` fails closed instead of being silently coerced. Selection is
deterministic: an explicit `--tool` id wins, then `settings.tools.default`, then
the sole entry; ambiguity or an unknown id fails with a clear reason.

The selected tool resolves to one readiness state with safe failure defaults:
`declared` (valid contract, not probed — via `--no-probe`), `ready` (the command
is resolvable), or `isolated` (disabled, misconfigured, command missing, or the
bounded probe timed out). A disabled or unavailable tool resolves to `isolated`
and the command still exits `0` — the consumer skips it without crashing. A
contract/usage error exits `2`. Argument values are never printed (only their
count) and the home path is collapsed to `~`.

```text
Tool:         ripgrep
Contract:     oh-my-cli.tool-contract v1 (settings contract version 1)
Kind:         command
Command:      rg
Arguments:    1
Enabled:      true
State:        ready [command resolved]
Probe:        1ms (timeout 3000ms)
Capabilities: readOnly, filesystem
Settings:     ~/.oh-my-cli/settings.json
```

Add `--output json` for a versioned record (`schema` `oh-my-cli.tool-contract`)
carrying the negotiated `contractVersion`, the selected `toolId`, `kind`,
`command`, `argCount`, the resolved `state` and `reason`, and `probeMs`.

### Provider invocation

`--provider-contract` is read-only — it resolves a provider's configuration but
never issues a request. `--invoke-provider` is the governed next step: it issues
**one** bounded model request to **one** resolved-`ready` provider once,
non-interactively, reusing the same `providers` contract, without changing core
code.

```bash
# invoke the default (or sole) ready provider with a minimal safe ping
oh-my-cli --invoke-provider --approval-mode yolo

# select one explicitly, send a prompt, and emit a versioned JSON result
oh-my-cli --invoke-provider --provider alt --provider-prompt "hello" --output json

# bound a slow provider with a shorter hard timeout
oh-my-cli --invoke-provider --approval-mode yolo --invoke-timeout 5000
```

Every gate runs before the request and fails closed:

- **Readiness** — only a `ready` provider is called; one whose credential
  environment variable is unset or whose endpoint is not a valid URL is refused.
- **Approval mode** — a provider request is a network call to an external model
  API (it can spend credit and read whatever the endpoint returns), so it is
  gated as the most cautious category: `default` and `auto-edit` require approval
  (an interactive terminal may grant it); a non-interactive run is refused unless
  the mode is `yolo`.

The request is bounded in three ways: a hard timeout (`--invoke-timeout`, default
30s, max 300s) aborts the in-flight call, a bounded generation (`max tokens`)
caps what the provider returns, and an output-size cap bounds what enters the
report. The credential is supplied by an environment-variable name and its value
is never printed, logged, or sent through the approval prompt — only the variable
name is reported. The endpoint is reduced to its host, the prompt is reported as
a character count (never echoed), and the response is redacted (secrets and
home/workspace paths) in both text and JSON. Exit codes: `0` on a response with
content; `2` for a contract/selection/version error, a non-`ready` provider, or a
missing approval (refused before calling); `1` for a request runtime failure (an
empty response, auth rejection, unsupported model, rate limiting, network/API
error, timeout, or oversized output) — the run never crashes.

```text
Provider:     alt
Contract:     oh-my-cli.provider-invocation v1 (settings contract version 1)
Endpoint:     alt.example (settings)
Model:        alt-model
Credential:   ALT_KEY
Prompt:       4 chars
Gate:         passed
Invoked:      true
Outcome:      called
Tokens:       8 (prompt 3, completion 5)
Bounds:       123ms (timeout 30000ms, max tokens 256, output cap 65536 bytes)
Reason:       provider returned a response
Result:       pong
Settings:     ~/.oh-my-cli/settings.json
```

### Tool invocation

`--tool-contract` is read-only — it resolves readiness but never runs the tool.
`--invoke-tool` is the governed next step: it invokes **one** resolved-`ready`
tool extension once, non-interactively, reusing the same `tools` contract and the
command trust policy (`--command-policy`), without changing core code.

```bash
# invoke the default (or sole) ready tool, confined to the workspace
oh-my-cli --invoke-tool --approval-mode yolo --workspace ./project

# select one explicitly and emit a versioned JSON result
oh-my-cli --invoke-tool --tool ripgrep --approval-mode yolo --output json

# bound a slow tool with a shorter hard timeout
oh-my-cli --invoke-tool --approval-mode yolo --invoke-timeout 5000
```

Every gate runs before execution and fails closed:

- **Readiness** — only a `ready` tool is invoked; a `declared` or `isolated`
  tool (disabled, misconfigured, or command missing) is refused.
- **Command policy** — the declared `command` and `args` are evaluated as
  untrusted input, confined to the workspace; a denied command (destructive git,
  credential access, path escape, destructive removal, device overwrite) is not
  executed.
- **Approval mode** — a command tool is gated as a shell mutation, so `default`
  and `auto-edit` require approval (an interactive terminal may grant it); a
  non-interactive run is refused unless the mode is `yolo`.

The command runs directly (no shell, so arguments cannot be reinterpreted),
confined to the workspace and bounded by a hard timeout (`--invoke-timeout`,
default 30s, max 300s) and an output-size cap. Captured output is redacted
(secrets and home/workspace paths) in both text and JSON. Exit codes: `0` on a
successful invocation; `2` for a contract/selection/version error, a non-`ready`
tool, a policy denial, or a missing approval (refused before execution); `1` for
a tool runtime failure (timeout, oversized output, non-zero exit, or a spawn
error) — the run never crashes.

### MCP invocation

`--mcp-contract` is read-only — it resolves a server's lifecycle state but never
connects. `--invoke-mcp` is the governed next step: it connects to **one**
resolved-`ready` MCP server over the safe local **stdio** transport, performs the
`initialize` handshake, lists tools, and calls **one** tool once,
non-interactively — reusing the same `mcp` contract and the command trust policy
(`--command-policy`), without changing core code.

```bash
# connect to the default (or sole) ready server and call its sole tool
oh-my-cli --invoke-mcp --approval-mode yolo --workspace ./project

# select a server and one of its tools, with arguments, as versioned JSON
oh-my-cli --invoke-mcp --server filesystem --mcp-tool read_file \
  --mcp-arg path=README.md --approval-mode yolo --output json

# bound a slow server with a shorter hard timeout
oh-my-cli --invoke-mcp --approval-mode yolo --invoke-timeout 5000
```

Every gate runs before connecting and fails closed:

- **Readiness** — only a `ready` server is connected; a `declared` or `isolated`
  server (disabled, misconfigured, or command missing) is refused.
- **Command policy** — the declared `command` and `args` are evaluated as
  untrusted input, confined to the workspace; a denied command (destructive git,
  credential access, path escape, destructive removal, device overwrite) is not
  spawned.
- **Approval mode** — connecting to a server is gated as a shell mutation, so
  `default` and `auto-edit` require approval (an interactive terminal may grant
  it); a non-interactive run is refused unless the mode is `yolo`.

The server command runs directly (no shell, so arguments cannot be
reinterpreted), confined to the workspace; the whole session (connect, handshake,
list, and call) is bounded by a single hard timeout (`--invoke-timeout`, default
30s, max 300s) and an output-size cap. The tool result is redacted (secrets and
home/workspace paths) in both text and JSON, and only `text` content parts are
captured. Tool selection is deterministic: an explicit `--mcp-tool` wins,
otherwise the sole exposed tool is used; ambiguity or an unknown name fails
closed. Exit codes: `0` on a successful tool call; `2` for a
contract/selection/version error, a non-`ready` server, a policy denial, or a
missing approval (refused before connecting); `1` for a session runtime failure
(handshake failure, timeout, oversized output, tool-selection ambiguity, a
tool-level error, or a spawn error) — the run never crashes.

### Extension discovery

Once providers (`--provider-contract`), MCP servers (`--mcp-contract`), tools
(`--tool-contract`), and workflows (`--list-workflows`) are declared as versioned
contracts, `--discover-extensions` composes all four resolvers into a single
read-only, redacted view of which extension surfaces are declared and ready —
without re-probing every integration (`--health`) and without changing core code.
It reads the same unified settings file and reports, per surface, the negotiated
contract version, declared entry count, default, and the entry a consumer would
select (plus the MCP and tool selected entries' lifecycle/readiness state). A
workflow has no default and no external entrypoint to probe — it is selected by
explicit name at run time — so the workflow surface reports only the definition
count and the contract-level readiness (`ready` whenever the contract negotiates
and validates).

```bash
oh-my-cli --discover-extensions
oh-my-cli --discover-extensions --output json
# resolve the declarations without probing (MCP and tool reported as declared)
oh-my-cli --discover-extensions --no-probe
```

A surface with no declared section is reported as **absent** (not an error), and
a missing settings file reports every surface absent — the command still exits
`0`. An invalid contract (unsupported version, raw credential field, malformed
section) fails closed and exits `2`, the same guarantee each contract provides on
its own. Multiple entries with no default are reported as ambiguous (no
selection) rather than failing — discovery never picks on your behalf. No secret
value, argument value, or remote response body is ever printed; only counts, ids,
negotiated versions, and lifecycle state appear, with the home path collapsed to
`~`.

```text
Extension Discovery
────────────────────────────────────────
Settings:  ~/.oh-my-cli/settings.json
Schema:    oh-my-cli.extension-discovery v1

Provider contract: 2 entries (contract version 1)
  Default:  primary
  Selected: primary

MCP contract: 1 entry (contract version 1)
  Default:  filesystem
  Selected: filesystem
  State:    ready [command resolved]

Tool contract: 1 entry (contract version 1)
  Default:  ripgrep
  Selected: ripgrep
  State:    ready [command resolved]

Workflow contract: 1 definition (contract version 1)
  State:    ready [1 workflow definition resolvable]
```

Add `--output json` for a versioned record (`schema`
`oh-my-cli.extension-discovery`) whose `surfaces` array carries one entry per
contract (`kind` `provider` / `mcp` / `tool` / `workflow`), each flagged
`present`, with its `contractVersion`, `entryCount`, `default`, `selectedId`, and
— for MCP and tool — the resolved `state`, `stateReason`, and `probeMs`. The
`workflow` surface carries `default` and `selectedId` as `null` (workflows are
selected by explicit name at run time) and reports the contract-level readiness
`state` with no `probeMs`.

### Extension compatibility

Where `--discover-extensions` reports the version a present section *negotiated*,
`--extension-compat` answers the proactive, pre-run question *"will this settings
file's extension contracts work on this build?"* It publishes the supported
contract-version matrix for all four surfaces (provider, tool, MCP, workflow) —
schema id plus supported version range, sourced from the same
`SUPPORTED_*_CONTRACT_VERSIONS` constants the parsers enforce (no new source of
truth) — and reads the user-owned settings file to emit a per-surface verdict:
**compatible** (declared version within the supported range), **incompatible**
(declared version outside the range, or no valid integer version, naming the
declared and supported versions), or **absent** (section not declared). It reads
only each section's declared `contractVersion` — it never re-validates the full
contract, re-probes readiness, or executes any extension — so a fleet or CI
system can check up front instead of triggering a fail-closed error mid-run.

```bash
oh-my-cli --extension-compat
oh-my-cli --extension-compat --output json
# check a specific settings file before deploying it across mixed CLI versions
oh-my-cli --extension-compat --settings path/to/settings.json --output json
```

An unsupported version is reported as a **verdict** (the command still exits `0`
— an audit, not a gate); only a malformed settings root (invalid JSON or a
non-object) fails closed and exits `2`, matching the settings-level guarantee of
discovery. Because the surface reads only `contractVersion`, no entry id,
argument, or secret value is ever printed; only the home path is collapsed to
`~`.

```text
Extension Compatibility
────────────────────────────────────────
Settings:  ~/.oh-my-cli/settings.json
Schema:    oh-my-cli.extension-compat v1

Provider contract: compatible
  Schema:    oh-my-cli.provider-contract
  Supported: 1
  Declared:  1
  Reason:    declared version 1 is supported

Tool contract: incompatible
  Schema:    oh-my-cli.tool-contract
  Supported: 1
  Declared:  99
  Reason:    declared version 99 is outside the supported range

MCP contract: absent
  Schema:    oh-my-cli.mcp-contract
  Supported: 1
  Declared:  (not declared)
  Reason:    section not declared
```

Add `--output json` for a versioned record (`schema`
`oh-my-cli.extension-compat`) whose `surfaces` array always carries one entry per
contract (`kind` `provider` / `tool` / `mcp` / `workflow`), each with its
`schema`, `supportedVersions`, `present` flag, `declaredVersion` (an integer or
`null`), `verdict` (`compatible` / `incompatible` / `absent`), and a `reason`.

### Reusable workflows

Encode a repeatable, non-interactive automation (for example a CI sequence) as a
**versioned workflow** in the same unified settings file
(`~/.oh-my-cli/settings.json`, or `--settings <path>`), then run it by name. A
workflow is a named, ordered list of steps and each step is a bounded prompt run
through the existing headless `-p` path in its own process — so steps are
isolated and there is no core-code change per consumer. `--list-workflows`
inventories the declared workflows (read-only, redacted); `--run-workflow <name>`
runs one non-interactively.

```json
{
  "workflows": {
    "contractVersion": 1,
    "definitions": {
      "ci-readonly": {
        "description": "Two read-only checks",
        "steps": [
          { "prompt": "List the files in this directory" },
          { "prompt": "Summarize README.md" }
        ]
      }
    }
  }
}
```

```bash
oh-my-cli --list-workflows
oh-my-cli --run-workflow ci-readonly
oh-my-cli --run-workflow ci-readonly --output json
```

Steps run sequentially in declared order. **Safe failure defaults:** the first
failing step halts the run with a bounded non-zero verdict and the remaining
steps do not run. The contract is untrusted input read only from the user-owned
scope — a project-local settings file can never define or run a workflow. A raw
credential field (in a workflow or a step), an unknown/misspelled key, a
malformed step, or an unsupported `contractVersion` fails closed and exits `2`
before any side effect. A completed run exits `0`; a halted run exits `1`.

Output is redacted in both modes — secrets, credentials, and home/workspace
paths never appear — and each step reports pass/fail and bounded wall-clock time.
Human mode streams one line per step; `--output json` emits a single record
(`schema` `oh-my-cli.workflow-contract`) with the `workflow` name, `result`
(`completed` or `failed`), `stepsRun`/`stepsTotal`, and a `steps` array carrying
each step's redacted `prompt`, `ok`, `exitCode`, and `elapsedMs`.

```text
  Step 1/2: List the files in this directory — ok (615ms)
  Step 2/2: Summarize README.md — ok (718ms)
Workflow "ci-readonly": completed (2/2 steps, 1340ms)
```

## Built-in tools

| Tool | Category | Description |
|---|---|---|
| `read` | read | Read a workspace-relative file with optional line offset/limit |
| `list` | read | List the immediate entries of a workspace directory (types, deterministic order) |
| `glob` | read | Recursively match workspace-relative paths against a glob pattern |
| `grep` | read | Search file contents for a regular expression, returning `path:line` matches |
| `write` | mutate-file | Create or replace a workspace-relative UTF-8 file |
| `edit` | mutate-file | Replace exactly one occurrence of text in a file |
| `shell` | mutate-shell | Execute a command via `/bin/bash` (30s default timeout, 120s max, 1 MiB output cap) |

File operations are confined to the workspace directory. Symlink escapes are
detected and rejected. Shell commands run with their working directory confined
to the canonical workspace root, so a command cannot inherit a launch directory
outside the trust boundary.

The `list`, `glob`, and `grep` tools are read-only and therefore never require
approval, so the agent can explore the repository in any approval mode. They
stay strictly inside the workspace (every base path is confined with symlink
escape detection), never follow symbolic links, and apply repository ignore
rules (the root `.gitignore` plus a built-in set of generated directories such
as `node_modules` and `dist`); `glob`/`grep` accept an `ignore:false` option to
search ignored trees and `grep` accepts an `include` glob to narrow matches.
Every collection is bounded by depth, file count, match count, per-file size,
and a wall-clock deadline; binary, oversized, and over-long-line inputs are
skipped or truncated with explicit metadata rather than flooding context, and
results are deterministically ordered. Because no subprocess is ever spawned,
cancellation and time limits cannot leave background processes behind.

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
- `src/provider.ts` — OpenAI-compatible streaming client with text + tool-call aggregation and bounded transient-error retry
- `src/agent.ts` — agent loop with 30-round hard cap and spend-budget gate
- `src/cost.ts` — bundled model price table, token→USD cost estimate, and budget parsing (`--budget`)
- `src/tools.ts` — tool definitions (read, list, glob, grep, write, edit, shell)
- `src/discovery.ts` — bounded, read-only, symlink-safe discovery primitives (list, glob, grep) backing the same-named tools
- `src/workspace.ts` — path confinement with symlink escape detection
- `src/approval.ts` — approval mode logic
- `src/folder-trust.ts` — folder-trust boundary and effective-sandbox detection (`--trust`/`--trust-info`/`--trust-workspace`/`--enforce-folder-trust`)
- `src/command-policy.ts` — deterministic, offline shell-command classification and denial (`--command-policy`)
- `src/permission-impact.ts` — redacted permission-impact preview for the approval prompt
- `src/color.ts` — ANSI color toggle (`--no-color` / `NO_COLOR`) and palette factory
- `src/session.ts` — JSONL session persistence
- `src/compaction.ts` — bounded, versioned, fail-closed session compaction (`--compact`/`--compact-threshold`)
- `src/session-export.ts` — deterministic, redacted local session export to Markdown + JSON manifest (`--export-session`)
- `src/turn-checkpoint.ts` — content-based, fail-closed undo/redo of one completed agent turn (`--undo-turn`/`--redo-turn`/`--dry-run`)
- `src/side-question.ts` — structurally-isolated side question against a bounded, read-only session snapshot, no tools/mutation/persistence (`--side-question`/`--session`, `/ask`)
- `src/session-stats.ts` — deterministic, no-fabrication session activity/efficiency stats engine shared by the `/stats` overlay and the headless `--session-stats` form
- `src/lsp-runtime.ts` — deterministic, secret-safe language-server runtime engine: trust-gated discovery (no implicit install) plus workspace/version/instance-bound diagnostics with stale-event rejection, shared by the `/lsp` overlay and the headless `--lsp-status` form
- `src/task-runtime.ts` — deterministic, secret-safe background-task engine: an eight-state lifecycle with authoritative concurrency/leases/approvals, idempotent scoped cancellation with durable receipts, and restart reconciliation against real process state (never complete from UI alone), shared by the `/tasks` overlay and the headless `--tasks` form
- `src/headless-protocol.ts` — versioned NDJSON event stream (`--output json`)
- `src/run-summary.ts` — privacy-safe execution summary builder/formatter (`--summary`)
- `src/run-scorecard.ts` — deterministic, privacy-safe comparison of two summaries (`--baseline`/`--candidate`)
- `src/run-recovery.ts` — bounded run recovery from a durable checkpoint (`--recover`)
- `src/evidence-archive.ts` — portable, deterministic, signed evidence bundle export/verify (`--export-evidence`/`--verify-evidence`)
- `src/repo-readiness.ts` — read-only repository-readiness inspection (`--readiness`)
- `src/repo-context.ts` — read-only, bounded, redacted repository-context snapshot (`--repo-context`)
- `src/repo-map.ts` — read-only, bounded, ranked repository map of key files and top-level symbols, seeded into every fresh session (`--repo-map`)
- `src/instruction-context.ts` — effective, bounded, redacted repository instruction context seeded into every fresh session (`--instruction-context`)
- `src/task-plan.ts` — deterministic, bounded, redacted task planner grounded in the repo context (`--plan`)
- `src/task-verify.ts` — bounded, redacted, head-bound pass/fail verification of the repo's canonical commands (`--verify-task`)
- `src/change-review.ts` — bounded, redacted, head-bound review brief for the current change against a base ref (`--review-change`)
- `src/ci-handoff.ts` — bounded, redacted, head-bound CI handoff brief composing verify + review (`--ci-handoff`)
- `src/delivery-brief.ts` — bounded, redacted, head-bound completion verdict composing plan + verify + review + handoff with a CI result (`--delivery-brief`)
- `src/provider-contract.ts` — versioned, redacted provider extension contract: declare providers in settings, negotiate the contract version, select one, and resolve its non-secret config (`--provider-contract`)
- `src/provider-invocation.ts` — governed, non-interactive issuance of one bounded model request to one resolved-`ready` provider through its contract: gated by readiness (credential available, endpoint valid) and approval mode, bounded by a hard timeout, a bounded generation, and an output-size cap, redacted in text and JSON with the credential value never printed, and fail-closed on every error (`--invoke-provider`)
- `src/mcp-contract.ts` — versioned, redacted MCP server extension contract: declare servers in settings, negotiate the contract version, select one, and resolve its lifecycle state (declared/ready/isolated) with safe failure defaults (`--mcp-contract`)
- `src/mcp-invocation.ts` — governed, non-interactive connection to one resolved-`ready` MCP server over safe local stdio: initialize handshake, tool listing, and one tool call, gated by readiness, the command trust policy, and approval mode, confined to the workspace, bounded by a hard timeout and output cap, redacted in text and JSON, and fail-closed on every error (`--invoke-mcp`)
- `src/tool-contract.ts` — versioned, redacted tool extension contract: declare tools in settings, negotiate the contract version, select one, and resolve its readiness state (declared/ready/isolated) with safe failure defaults (`--tool-contract`)
- `src/tool-invocation.ts` — governed, non-interactive invocation of one resolved-`ready` tool extension through its contract: gated by readiness, the command trust policy, and approval mode, confined to the workspace, bounded by a hard timeout and output cap, redacted in text and JSON, and fail-closed on every error (`--invoke-tool`)
- `src/extension-discovery.ts` — read-only discovery view composing the provider, MCP, tool, and workflow contract resolvers into one redacted report of which extension surfaces are declared and ready, without core changes (`--discover-extensions`)
- `src/extension-compat.ts` — read-only compatibility view publishing the supported provider, tool, MCP, and workflow contract-version matrix (from the `SUPPORTED_*_CONTRACT_VERSIONS` constants) and a proactive, redacted per-surface verdict (compatible/incompatible/absent) for the user settings file, without re-validating, probing, or executing any extension (`--extension-compat`)
- `src/workflow-contract.ts` — versioned, redacted workflow contract: declare reusable named workflows (ordered steps) in user settings, negotiate the contract version, select one by name, and list them (`--list-workflows`)
- `src/workflow-runner.ts` — run a named workflow non-interactively, each step a bounded prompt through the headless `-p` path in its own process; steps run in declared order, a failing step halts the run, and output is redacted in human and machine modes (`--run-workflow`)
- `src/trust-posture.ts` — read-only posture view composing folder trust, sandbox isolation, approval mode, and extension readiness into one redacted audit of what a run will be allowed to do, without core changes (`--trust-posture`)
- `src/worktree-lease.ts` — collision-safe leased git worktrees per mutating agent (`--create-worktree`/`--clean-worktree`)
- `src/index.ts` — CLI entry point (commander)
- `tests/fake-provider.ts` — fake OpenAI-compatible HTTP server for tests
