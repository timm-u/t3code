import type { ServerProviderModel, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import { parseSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeCommandCodeAcpRuntime } from "./CommandCodeAdapter.ts";

export function commandCodeAcpModels(start: AcpSessionRuntime.AcpSessionRuntimeStartResult) {
  const setup = start.sessionSetupResult;
  const capabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors({
      configOptions: setup.configOptions,
      modeState: parseSessionModeState(setup),
    }),
  });
  const option = setup.configOptions?.find(
    (candidate) => candidate.category === "model" && candidate.type === "select",
  );
  const advertised =
    option?.type === "select"
      ? option.options
          .flatMap((group) => ("value" in group ? [group] : group.options))
          .map((model) => ({ id: model.value, name: model.name }))
      : (setup.models?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
        }));
  const current = option?.type === "select" ? option.currentValue : setup.models?.currentModelId;
  const models: ReadonlyArray<ServerProviderModel> =
    advertised.length > 0
      ? advertised.map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          isDefault: model.id === current,
          capabilities,
        }))
      : [{ slug: "default", name: "Default", isCustom: false, isDefault: true, capabilities }];
  return { models, capabilities };
}

export const probeCommandCodeAcp = Effect.fn("CommandCode.probeAcp")(function* (input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const runtime = yield* makeCommandCodeAcpRuntime(
      { ...input, spawner },
      {
        cwd: input.cwd,
        runtimePolicy: {
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: input.cwd,
        },
        mcpServers: [],
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-code-commandcode-probe", version: "1" },
        protocolLogging: {},
        onTermination: () => Effect.void,
      },
    );
    const commands = yield* Ref.make<ReadonlyArray<ServerProviderSlashCommand>>([]);
    yield* runtime.handleSessionUpdate((notification) =>
      notification.update.sessionUpdate === "available_commands_update"
        ? Ref.set(
            commands,
            notification.update.availableCommands.map((command) => ({
              name: command.name,
              description: command.description,
            })),
          )
        : Effect.void,
    );
    const started = yield* runtime.start();
    const discovered = commandCodeAcpModels(started);
    // Release the empty discovery session without touching any saved user session.
    yield* runtime.closeSession(started.sessionId).pipe(Effect.ignore);
    return {
      ...discovered,
      slashCommands: yield* Ref.get(commands),
    };
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"));
});
