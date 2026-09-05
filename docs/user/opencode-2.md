# OpenCode 2

OpenCode 2 beta is supported through its native Agent Client Protocol (ACP). Enable OpenCode in Settings and set its binary path to `opencode2` if both versions are installed. If the default v1 command or a saved npm-managed v1 installation has been removed, T3 discovers `opencode2` automatically. Explicit custom binary paths and external v1 server URLs remain unchanged.

The provider appears as **OpenCode 2**. Its model list comes from your OpenCode installation and keeps provider-qualified names. Use OpenCode's own login flow to connect model providers; T3 does not copy or replace credentials.

Streaming, model switching, Build/Plan selection, approval decisions, cancellation, attachments, and resuming v2 conversations use native ACP. Title and commit-message generation use the same connection. Existing v1 conversations need the v1 provider to continue, since the two versions do not share a conversation protocol. V2 conversation rollback is not advertised. Upgrade the beta with OpenCode's own updater.
