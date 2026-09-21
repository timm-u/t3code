import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { makeGrokAcpRuntime } from "./GrokAcpSupport.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as AcpSchema from "effect-acp/schema";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const makeOpenCode2Runtime = Effect.fn("makeOpenCode2Runtime")(function* (
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "authMethodId" | "clientCapabilities">,
) {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: null,
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }),
  );
  return yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context));
});

export function openCode2SelectOptions(option: AcpSchema.SessionConfigOption) {
  return option.type === "select"
    ? option.options.flatMap((entry) => ("value" in entry ? [entry] : [...entry.options]))
    : [];
}

export function openCode2Models(
  options: ReadonlyArray<AcpSchema.SessionConfigOption>,
): ServerProviderModel[] {
  const model = options.find((option) => option.category === "model" || option.id === "model");
  if (!model) return [];
  return openCode2SelectOptions(model).map((entry) => ({
    slug: entry.value,
    name: entry.name,
    isCustom: false,
    isDefault: model.type === "select" && model.currentValue === entry.value,
    ...(entry.description ? { description: entry.description } : {}),
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  }));
}

export const configureOpenCode2Session = Effect.fn("configureOpenCode2Session")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  selection: ModelSelection | undefined,
  interactionMode?: "default" | "plan",
) {
  if (selection?.model && selection.model !== "default") yield* runtime.setModel(selection.model);
  const options = yield* runtime.getConfigOptions;
  const effort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
  const effortOption = options.find((option) => option.category === "thought_level");
  if (
    effort &&
    effortOption &&
    openCode2SelectOptions(effortOption).some((entry) => entry.value === effort)
  ) {
    yield* runtime.setConfigOption(effortOption.id, effort);
  }
  if (interactionMode) yield* runtime.setMode(interactionMode === "plan" ? "plan" : "build");
});

/** Bridge ACP config-option model selection to the shared ACP adapter's model-state view. */
export const makeOpenCode2AdapterRuntime: typeof makeGrokAcpRuntime = (input) =>
  Effect.gen(function* () {
    const runtime = yield* makeOpenCode2Runtime({
      ...input,
      spawn: {
        command: input.grokSettings?.binaryPath || "opencode2",
        args: ["acp"],
        cwd: input.cwd,
        ...(input.environment ? { env: input.environment } : {}),
      },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
    );
    return {
      ...runtime,
      start: () =>
        runtime.start().pipe(
          Effect.flatMap((started) =>
            Effect.gen(function* () {
              const options = yield* runtime.getConfigOptions;
              const model = options.find((option) => option.category === "model");
              if (!model || model.type !== "select") return started;
              return {
                ...started,
                sessionSetupResult: {
                  ...started.sessionSetupResult,
                  models: {
                    currentModelId: model.currentValue,
                    availableModels: openCode2SelectOptions(model).map((entry) => ({
                      modelId: entry.value,
                      name: entry.name,
                    })),
                  },
                },
              };
            }),
          ),
        ),
      setSessionModel: (modelId, meta) =>
        Effect.gen(function* () {
          yield* runtime.setModel(modelId);
          const effort = meta?.reasoningEffort;
          if (typeof effort === "string") {
            const options = yield* runtime.getConfigOptions;
            const setting = options.find((option) => option.category === "thought_level");
            if (
              setting &&
              openCode2SelectOptions(setting).some((entry) => entry.value === effort)
            ) {
              yield* runtime.setConfigOption(setting.id, effort);
            }
          }
          return {};
        }),
    };
  });
