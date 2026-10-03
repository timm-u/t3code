import { CommandCodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import { makeCommandCodeTextGeneration } from "../../textGeneration/CommandCodeTextGeneration.ts";
import { makeCommandCodeAdapter } from "../commandcode/CommandCodeAdapter.ts";
import { CommandCodeStatus, parseCommandCodeModels } from "../commandcode/CommandCodeProtocol.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const driver = ProviderDriverKind.make("commandcode");
const decodeSettings = Schema.decodeUnknownSync(CommandCodeSettings);
const decodeStatus = Schema.decodeEffect(Schema.fromJsonString(CommandCodeStatus));
export const commandCodeMaintenance = makePackageManagedProviderMaintenanceResolver({
  provider: driver,
  npmPackageName: "command-code",
  nativeUpdate: null,
});
export type CommandCodeDriverEnv =
  | IdAllocatorV2
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;
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
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const env = mergeProviderInstanceEnvironment(input.environment);
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
      const snapshotSettings = makeProviderSnapshotSettingsSource(config, serverSettings);
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
        const inventory = yield* process
          .run({
            command: config.binaryPath,
            args: ["--list-models", "--no-auto-update"],
            env,
            timeout: "25 seconds",
            maxOutputBytes: 262_144,
          })
          .pipe(Effect.result);
        const models =
          inventory._tag === "Success" && inventory.success.code === 0
            ? parseCommandCodeModels(inventory.success.stdout)
            : [];
        return stamp(
          buildServerProvider({
            presentation: {
              displayName: "Command Code",
              showInteractionModeToggle: true,
              supportsConversationRollback: false,
            },
            enabled: input.enabled,
            checkedAt,
            models: providerModelsFromSettings(models, config.customModels, {
              optionDescriptors: [],
            }),
            probe: {
              installed: true,
              version: status.success.version,
              status: status.success.authenticated ? "ready" : "warning",
              auth: { status: status.success.authenticated ? "authenticated" : "unauthenticated" },
              ...(!status.success.authenticated
                ? {
                    message:
                      "Run command-code login on this environment, or set CMD_API_KEY in this instance's environment variables.",
                  }
                : {}),
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
        cwd: serverConfig.cwd,
      });
      const textGeneration = yield* makeCommandCodeTextGeneration(config, env);
      return {
        ...input,
        driverKind: driver,
        continuationIdentity,
        snapshot,
        orchestrationAdapter: adapter,
        textGeneration,
      };
    }),
};
