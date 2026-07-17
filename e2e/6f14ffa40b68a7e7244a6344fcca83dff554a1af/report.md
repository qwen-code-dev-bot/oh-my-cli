## Tmux E2E verification

- Repository: `qwen-code-dev-bot/oh-my-cli`
- Pull request: `#99`
- Commit: `6f14ffa40b68a7e7244a6344fcca83dff554a1af`
- Viewport: `120x36`
- Scenario: First-run hierarchy and fixed composer at 120x36
- Result: **PASS**

### Assertions

- Product identity and session context are visible without wrapping.
- The empty state gives a clear next action.
- The composer is fixed directly above the session footer.
- No credential, account name, or private workspace path appears in the capture.

![Exact-head tmux capture](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/6f14ffa40b68a7e7244a6344fcca83dff554a1af/terminal.png)

- [Readable transcript](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/6f14ffa40b68a7e7244a6344fcca83dff554a1af/transcript.txt)
- [ANSI capture](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/6f14ffa40b68a7e7244a6344fcca83dff554a1af/terminal.ansi)
- [Timeline](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/6f14ffa40b68a7e7244a6344fcca83dff554a1af/timeline.json)
