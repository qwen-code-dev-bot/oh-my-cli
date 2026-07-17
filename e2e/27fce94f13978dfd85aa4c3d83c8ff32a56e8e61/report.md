## Tmux E2E verification

- Repository: `qwen-code-dev-bot/oh-my-cli`
- Pull request: `#100`
- Commit: `27fce94f13978dfd85aa4c3d83c8ff32a56e8e61`
- Viewport: `120x36`
- Scenario: Qwen-style brand header, quiet transcript, framed composer, and two-row footer
- Result: **PASS**

### Assertions

- Product identity and session context are visible without wrapping.
- The conversation canvas remains quiet and the tip row provides orientation.
- The composer is fixed directly above the session footer.
- No credential, account name, or private workspace path appears in the capture.

![Exact-head tmux capture](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/bot/e2e-evidence-v2/e2e/27fce94f13978dfd85aa4c3d83c8ff32a56e8e61/terminal.png)

- [Readable transcript](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/bot/e2e-evidence-v2/e2e/27fce94f13978dfd85aa4c3d83c8ff32a56e8e61/transcript.txt)
- [ANSI capture](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/bot/e2e-evidence-v2/e2e/27fce94f13978dfd85aa4c3d83c8ff32a56e8e61/terminal.ansi)
- [Timeline](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/bot/e2e-evidence-v2/e2e/27fce94f13978dfd85aa4c3d83c8ff32a56e8e61/timeline.json)
