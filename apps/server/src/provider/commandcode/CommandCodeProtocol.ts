import type { RuntimeMode, ServerProviderModel } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createModelCapabilities } from "@t3tools/shared/model";

const Usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Finite),
  outputTokens: Schema.optional(Schema.Finite),
  cacheReadTokens: Schema.optional(Schema.Finite),
  cacheWriteTokens: Schema.optional(Schema.Finite),
});
export const CommandCodeEvent = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optional(Schema.String),
  delta: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Usage),
});
export const CommandCodeResult = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.Literals(["success", "error", "max_turns"]),
  sessionId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  finalText: Schema.String,
  usage: Schema.optional(Usage),
  error: Schema.optional(Schema.Unknown),
});
export type CommandCodeResult = typeof CommandCodeResult.Type;
export const CommandCodeFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("event"), event: CommandCodeEvent }),
  CommandCodeResult,
]);
export type CommandCodeFrame = typeof CommandCodeFrame.Type;
export const decodeCommandCodeFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CommandCodeFrame),
);
export const CommandCodeStatus = Schema.Struct({
  authenticated: Schema.Boolean,
  version: Schema.String,
});

export function commandCodeArgs(input: {
  model?: string | undefined;
  resumeSessionId?: string | undefined;
  runtimeMode: RuntimeMode;
  interactionMode?: "default" | "plan" | undefined;
  noSession?: boolean;
}) {
  return [
    "--print",
    "--output-format",
    "json",
    "--skip-onboarding",
    "--no-auto-update",
    // Headless cannot ask for approval. Restricted runs must remain read-only.
    ...(input.interactionMode === "plan" || input.runtimeMode !== "full-access"
      ? ["--permission-mode", "plan"]
      : ["--yolo"]),
    ...(input.model && input.model !== "default" ? ["--model", input.model] : []),
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ...(input.noSession ? ["--no-session"] : []),
  ];
}

export function parseCommandCodeModels(text: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9._:/-]+)\s{2,}(.+)$/i.exec(line.trim());
    if (!match || match[1]!.endsWith(":") || seen.has(match[1]!)) continue;
    const slug = match[1]!;
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      isCustom: false,
      isDefault: match[2]!.includes("(default)"),
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    });
  }
  return models;
}

const decodeErrorMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

export function commandCodeErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  const value = decodeErrorMessage(error);
  return value._tag === "Some" ? value.value.message : "Command Code could not complete this run.";
}
