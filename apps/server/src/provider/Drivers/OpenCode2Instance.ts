import { ProviderDriverKind, type OpenCodeSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  makeOpenCode2AdapterRuntime,
  openCode2Models,
  configureOpenCode2Session,
} from "../acp/OpenCode2AcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  makeProviderSnapshotSettingsSource,
  haveProviderSnapshotSettingsChanged,
} from "../providerUpdateSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const driver = ProviderDriverKind.make("opencode");

export const makeOpenCode2Instance = Effect.fn("makeOpenCode2Instance")(function* (
  input: ProviderDriverCreateInput<OpenCodeSettings>,
  binaryPath: string,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const loggers = yield* ProviderEventLoggers;
  const environment = mergeProviderInstanceEnvironment(input.environment);
  const settings = { enabled: input.enabled, binaryPath, customModels: input.config.customModels };
  const identity = defaultProviderContinuationIdentity({
    driverKind: driver,
    instanceId: input.instanceId,
  });
  const continuationIdentity = {
    ...identity,
    continuationKey: `${identity.continuationKey}:v2-acp`,
  };
  const stamp = withInstanceIdentity({
    ...input,
    accentColor: input.accentColor,
    driverKind: driver,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
    provider: driver,
    packageName: "@opencode-ai/cli",
  });
  const protocol = {
    provider: driver,
    harness: "OpenCode 2",
    resumeVersion: 2,
    makeRuntime: makeOpenCode2AdapterRuntime,
    resolveModel: (model: string | null | undefined) => model?.trim() || "default",
    beforePrompt: (
      runtime: Parameters<typeof configureOpenCode2Session>[0],
      turn: Parameters<ProviderInstance["adapter"]["sendTurn"]>[0],
    ) => configureOpenCode2Session(runtime, turn.modelSelection, turn.interactionMode),
  };
  const adapter = yield* makeGrokAdapter(settings, {
    instanceId: input.instanceId,
    environment,
    protocol,
    ...(loggers.native ? { nativeEventLogger: loggers.native } : {}),
  });
  const textGeneration = yield* makeGrokTextGeneration(settings, environment, protocol);
  const probe = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.enabled)
      return stamp(
        buildServerProvider({
          presentation: { displayName: "OpenCode 2", showInteractionModeToggle: true },
          enabled: false,
          checkedAt,
          models: [],
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
          },
        }),
      );
    const result = yield* Effect.gen(function* () {
      const runtime = yield* makeOpenCode2AdapterRuntime({
        grokSettings: settings,
        environment,
        childProcessSpawner: spawner,
        cwd: config.cwd,
        clientInfo: { name: "t3-code-provider-probe", version: "1" },
      });
      const started = yield* runtime.start();
      const models = openCode2Models(yield* runtime.getConfigOptions);
      // Probe sessions have no turns. Delete only the session this probe just created.
      yield* runtime
        .request("session/delete", { sessionId: started.sessionId })
        .pipe(Effect.ignore);
      return { models, version: started.initializeResult.agentInfo?.version ?? null };
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.result,
    );
    return stamp(
      buildServerProvider({
        presentation: { displayName: "OpenCode 2", showInteractionModeToggle: true },
        enabled: true,
        checkedAt,
        models: result._tag === "Success" ? result.success.models : [],
        probe:
          result._tag === "Success"
            ? {
                installed: true,
                version: result.success.version,
                status: "ready",
                auth: { status: "unknown" },
              }
            : {
                installed: true,
                version: null,
                status: "error",
                auth: { status: "unknown" },
                message: `OpenCode 2: ${result.failure.message}`,
              },
      }),
    );
  });
  const snapshotSettings = makeProviderSnapshotSettingsSource(
    { ...input.config, enabled: input.enabled },
    settingsService,
  );
  const snapshot = yield* makeManagedServerProvider({
    getSettings: snapshotSettings.getSettings,
    streamSettings: snapshotSettings.streamSettings,
    haveSettingsChanged: haveProviderSnapshotSettingsChanged,
    resolveMaintenance: () => Effect.succeed(maintenance),
    initialSnapshot: () =>
      Effect.map(DateTime.now, (now) =>
        stamp(
          buildServerProvider({
            presentation: { displayName: "OpenCode 2" },
            enabled: input.enabled,
            checkedAt: DateTime.formatIso(now),
            models: [],
            probe: {
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Checking OpenCode 2 ACP...",
            },
          }),
        ),
      ),
    checkProvider: probe,
    refreshOnInterval: false,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver,
          instanceId: input.instanceId,
          detail: cause.message,
          cause,
        }),
    ),
  );
  return {
    ...input,
    driverKind: driver,
    continuationIdentity,
    snapshot,
    adapter,
    textGeneration,
  } satisfies ProviderInstance;
});
