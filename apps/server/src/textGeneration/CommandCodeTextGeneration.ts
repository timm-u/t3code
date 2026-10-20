import type { CommandCodeSettings, ModelSelection } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import type {
  ProviderTextGeneration,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "@t3tools/provider-core/server/textGenerationUtils";
import { makeCommandCodeRunner } from "../provider/commandcode/CommandCodeRuntime.ts";
import {
  commandCodeArgs,
  commandCodeErrorText,
} from "../provider/commandcode/CommandCodeProtocol.ts";

export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  settings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const run = yield* makeCommandCodeRunner(settings.binaryPath, environment);
  const runCommandCodeJson = <S extends Schema.Top>(input: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }) =>
    Effect.gen(function* () {
      const result = yield* run({
        cwd: input.cwd,
        prompt: input.prompt,
        args: [
          ...commandCodeArgs({
            model: input.modelSelection.model,
            runtimeMode: "full-access",
            interactionMode: "plan",
            noSession: true,
          }),
          "--max-turns",
          "1",
        ],
        onFrame: () => Effect.void,
      });
      if (result.subtype !== "success")
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: commandCodeErrorText(result.error),
        });
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
        extractJsonObject(result.finalText),
      );
    }).pipe(
      Effect.timeout("180 seconds"),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Command Code text generation failed.",
            cause,
          }),
      ),
    );
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    "CommandCodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      policy: input.policy,
    });

    const generated = yield* runCommandCodeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    "CommandCodeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      policy: input.policy,
      changeRequestTemplate: input.changeRequestTemplate,
    });

    const generated = yield* runCommandCodeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    "CommandCodeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runCommandCodeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    "CommandCodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      previousTitle: input.previousTitle,
      linkedContext: input.linkedContext,
      attachments: input.attachments,
    });

    const generated = yield* runCommandCodeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies ProviderTextGeneration;
});
