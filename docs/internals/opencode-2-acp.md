# OpenCode 2 ACP integration

The OpenCode driver retains the upstream v1 HTTP adapter for installed v1 commands and configured server URLs. `OpenCodeExecutable` limits automatic v2 discovery to default commands and removed npm-managed v1 installations. `OpenCode2Instance` supplies a separate continuation identity and resume schema version.

The v2 runtime uses existing credentials without invoking interactive ACP authentication. Model and effort selection use negotiated config options, not the deprecated model-selection RPC. Empty probe sessions are deleted by their returned id. Periodic probes are disabled to avoid repeatedly creating sessions.

Protocol hooks in the existing Grok ACP adapter and text-generation implementation share the tested session lifecycle, request decisions, cancellation, event draining, and stale-turn guards. Grok's default hooks remain unchanged; v2 does not use its xAI completion extension. The v2 hook supplies its own runtime, model identifiers, prompt configuration, and harness name.

The adapter does not claim provider-side conversation rollback. Model access depends on the credentials held by OpenCode, and discovery is not proof that every listed model will accept a request.
