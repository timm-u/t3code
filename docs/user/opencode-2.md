# OpenCode 2

OpenCode 2 is supported through its native Agent Client Protocol (ACP). Install the released CLI with `npm install -g @opencode/cli`, enable OpenCode in Settings, and use `opencode` as its binary path. T3 detects v2 from its version. Legacy `opencode2` commands remain supported, and removed npm-managed v1 paths can discover the current default command. Explicit custom paths and external v1 server URLs remain unchanged.

The provider appears as **OpenCode 2**. Models come from your OpenCode installation with their provider-qualified names. Use OpenCode's login flow to connect model providers.

Streaming, model switching, Build/Plan selection, approval decisions, cancellation, attachments, and resuming v2 conversations use ACP. Child-session updates stay out of the parent's response; delegated results remain available in the parent tool result. Title and commit-message generation use the same connection. Existing v1 conversations need v1 to continue because the versions use different session protocols. V2 rollback is not advertised.

**Check for updates** checks the released `@opencode/cli` package. **Update** uses the package manager that owns the executable and preserves its installation prefix. Custom executables without a recognized package-manager installation remain manual updates.
