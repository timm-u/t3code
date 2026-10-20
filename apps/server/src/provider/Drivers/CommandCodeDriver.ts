import { CommandCodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Cache from "effect/Cache";
import * as Ref from "effect/Ref";
import { createModelCapabilities } from "@t3tools/shared/model";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import { ModelCapabilities } from "@t3tools/contracts";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as ProcessRunner from "../../processRunner.ts";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import { makeCommandCodeTextGeneration } from "../../textGeneration/CommandCodeTextGeneration.ts";
import { makeCommandCodeAdapter } from "../commandcode/CommandCodeAdapter.ts";
import { CommandCodeStatus } from "../commandcode/CommandCodeProtocol.ts";
import { probeCommandCodeAcp } from "../commandcode/CommandCodeAcpProbe.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  buildServerProvider,
  providerModelsFromSettings,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";

const driver = ProviderDriverKind.make("commandcode");
const decodeSettings = Schema.decodeUnknownSync(CommandCodeSettings);
const decodeStatus = Schema.decodeEffect(Schema.fromJsonString(CommandCodeStatus));
const equalCapabilities = Schema.toEquivalence(ModelCapabilities);
export const commandCodeMaintenance = makePackageManagedProviderMaintenanceResolver({
  provider: driver,
  npmPackageName: "command-code",
  nativeUpdate: { args: ["update"] },
});
export type CommandCodeDriverEnv =
  | IdAllocatorV2
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path;
export const CommandCodeDriver: ProviderDriver<CommandCodeSettings, CommandCodeDriverEnv> = {
  driverKind: driver,
  metadata: { displayName: "Command Code", supportsMultipleInstances: true },
  configSchema: CommandCodeSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const process = yield* ProcessRunner.make();
      const httpClient = yield* HttpClient.HttpClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const host = yield* ProviderHost.ProviderHost;
      const driverScope = yield* Effect.scope;
      const baseEnvironment = yield* HostProcessEnvironment;
      const env = mergeProviderInstanceEnvironment(input.environment, baseEnvironment);
      const config = { ...input.config, enabled: input.enabled };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: driver,
        instanceId: input.instanceId,
      });
      const stamp = withInstanceIdentity({
        ...input,
        driverKind: driver,
        accentColor: input.accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(commandCodeMaintenance, {
          binaryPath: config.binaryPath,
          env,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(config, host.settings);
      const discoveryCache = yield* Cache.make({
        capacity: 1,
        timeToLive: "15 minutes",
        lookup: () =>
          probeCommandCodeAcp({
            binaryPath: config.binaryPath,
            environment: env,
            cwd: host.paths.providerStatusCacheDir,
          }),
      });
      const modelCapabilities = yield* Ref.make(new Map<string, ModelCapabilities>());
      const pending = (checkedAt: string) =>
        stamp(
          buildServerProvider({
            presentation: {
              displayName: "Command Code",
              showInteractionModeToggle: true,
              supportsConversationRollback: false,
            },
            enabled: input.enabled,
            checkedAt,
            models: [],
            probe: {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Checking Command Code...",
            },
          }),
        );
      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!input.enabled) return pending(checkedAt);
        const statusResult = yield* process
          .run({
            command: config.binaryPath,
            args: ["status", "--json"],
            env,
            timeout: "25 seconds",
            maxOutputBytes: 65_536,
          })
          .pipe(Effect.result);
        if (statusResult._tag === "Failure")
          return {
            ...pending(checkedAt),
            status: "error" as const,
            message:
              "Install Command Code with npm install -g command-code, then run command-code login on this environment.",
          };
        const status = yield* decodeStatus(statusResult.success.stdout.trim()).pipe(Effect.result);
        if (status._tag === "Failure")
          return {
            ...pending(checkedAt),
            status: "error" as const,
            message: "Command Code returned an unsupported status response. Update its CLI.",
          };
        const inventory = status.success.authenticated
          ? yield* Cache.get(discoveryCache, undefined).pipe(Effect.result)
          : undefined;
        const discovery = inventory?._tag === "Success" ? inventory.success : undefined;
        const observedCapabilities = yield* Ref.get(modelCapabilities);
        return stamp(
          buildServerProvider({
            presentation: {
              displayName: "Command Code",
              showInteractionModeToggle: true,
              supportsConversationRollback: false,
            },
            enabled: input.enabled,
            checkedAt,
            models: providerModelsFromSettings(
              discovery?.models.map((model) => ({
                ...model,
                capabilities: observedCapabilities.get(model.slug) ?? model.capabilities,
              })) ?? [],
              config.customModels,
              discovery?.capabilities ?? {
                optionDescriptors: [],
              },
            ),
            slashCommands: discovery?.slashCommands ?? [],
            probe: {
              installed: true,
              version: status.success.version,
              status: !status.success.authenticated ? "warning" : discovery ? "ready" : "error",
              auth: { status: status.success.authenticated ? "authenticated" : "unauthenticated" },
              ...(!status.success.authenticated
                ? {
                    message:
                      "Run command-code login on this environment, or set CMD_API_KEY in this instance's environment variables.",
                  }
                : discovery
                  ? {}
                  : {
                      message:
                        "Command Code ACP could not start. Update its CLI and check its local login.",
                    }),
            },
          }),
        );
      });
      const snapshot = yield* makeManagedServerProvider({
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => Effect.map(DateTime.now, (now) => pending(DateTime.formatIso(now))),
        checkProvider,
        resolveMaintenance,
        refreshOnInterval: false,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenance) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenance, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
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
      const adapter = yield* makeCommandCodeAdapter({
        binaryPath: config.binaryPath,
        environment: env,
        instanceId: input.instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        onSessionConfigurationUpdate: (configOptions, modeState) =>
          Effect.gen(function* () {
            const model = configOptions.find(
              (option) => option.category === "model" && option.type === "select",
            );
            if (model?.type !== "select") return;
            const capabilities = createModelCapabilities({
              optionDescriptors: acpProviderOptionDescriptors({ configOptions, modeState }),
            });
            const current = yield* Ref.get(modelCapabilities);
            const previous = current.get(model.currentValue);
            if (previous !== undefined && equalCapabilities(previous, capabilities)) return;
            yield* Ref.set(
              modelCapabilities,
              new Map(current).set(model.currentValue, capabilities),
            );
            yield* snapshot.refresh.pipe(Effect.forkIn(driverScope));
          }),
      });
      const textGeneration = yield* makeCommandCodeTextGeneration(config, env);
      return {
        ...input,
        driverKind: driver,
        continuationIdentity,
        snapshot,
        orchestrationAdapter: adapter,
        invalidateCaches: Cache.invalidate(discoveryCache, undefined),
        textGeneration,
      };
    }),
};
