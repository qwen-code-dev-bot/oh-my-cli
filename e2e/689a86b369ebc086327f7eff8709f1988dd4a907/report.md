## Tmux E2E verification

- Repository: `qwen-code-dev-bot/oh-my-cli`
- Pull request: `#99`
- Commit: `689a86b369ebc086327f7eff8709f1988dd4a907`
- Viewport: `120x36`
- Scenario: Qwen-style brand header, quiet transcript, framed composer, and two-row footer
- Result: **PASS**

### Assertions

- Product identity and session context are visible without wrapping.
- The empty state gives a clear next action.
- The composer is fixed directly above the session footer.
- No credential, account name, or private workspace path appears in the capture.

![Exact-head tmux capture](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/689a86b369ebc086327f7eff8709f1988dd4a907/terminal.png)

- [Readable transcript](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/689a86b369ebc086327f7eff8709f1988dd4a907/transcript.txt)
- [ANSI capture](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/689a86b369ebc086327f7eff8709f1988dd4a907/terminal.ansi)
- [Timeline](https://raw.githubusercontent.com/qwen-code-dev-bot/oh-my-cli/e2e-evidence/e2e/689a86b369ebc086327f7eff8709f1988dd4a907/timeline.json)
