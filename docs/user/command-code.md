# Command Code

Use your Command Code account in T3 Code on Windows, macOS, or Linux, including ARM64 Raspberry Pi hosts. GOAT and higher subscriptions use their existing plan credits and model access.

Install the current CLI on each environment with `npm install -g command-code`, then run `command-code login` there. In T3 Settings, add a Command Code provider instance and enable it. Select that instance and a model when starting a thread. Models come from the installed CLI's live catalog; your plan determines which models can run.

An existing Command Code desktop/CLI login is reused. For a separate account, set `CMD_API_KEY` as a sensitive environment variable on the provider instance. Remote instances use the login on the remote machine. Windows uses the `command-code` executable, avoiding the built-in `cmd.exe` shell name.

Responses stream with separate reasoning, tool activity, and final text. Follow-up messages resume the same native Command Code session, including after a T3 server restart. Provider settings can check for CLI updates and update recognized npm installations.

Full access allows the agent to edit files and run commands. Plan mode and approval-required mode are read-only because the CLI's headless mode cannot request interactive approvals. Queue follow-up messages while a turn is running, or stop the turn before sending a replacement.

File/image attachments, interactive questions, and conversation rollback are not supported by this integration yet. Reference files in the workspace in your text prompt, and answer questions in a follow-up message. Checkpoints and Git diffs remain available through T3.
