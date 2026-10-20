# Command Code

Use your Command Code account in T3 Code on Windows, macOS, or Linux, including ARM64 Raspberry Pi hosts. GOAT and higher subscriptions use their existing plan credits and model access.

Install the current CLI on each environment with `npm install -g command-code`, then run `command-code login` there. In T3 Settings, add a Command Code provider instance and enable it. Select that instance and a model when starting a thread. Models come from the installed CLI's live catalog; your plan determines which models can run.

An existing Command Code desktop/CLI login is reused. For a separate account, set `CMD_API_KEY` as a sensitive environment variable on the provider instance. Remote instances use the login on the remote machine. Windows uses the `command-code` executable, avoiding the built-in `cmd.exe` shell name.

Responses stream with separate reasoning, tool activity, and final text. Follow-up messages resume the same native Command Code session, including after a T3 server restart. Provider settings can check for CLI updates and update recognized npm installations.

Chat uses Command Code's ACP server. Approval-required mode lets the agent request permission to edit files or run commands. Full access uses its bypass mode, and Plan uses its native plan mode. Agent questions appear as choices you can answer in T3. Queue follow-up messages while a turn is running, or stop the turn before sending a replacement.

File and image attachments are supported. Models expose their available effort controls after the native session selects them. Conversation rollback is unavailable; checkpoints and Git diffs remain available through T3. Existing Command Code threads continue using their saved native session IDs.
