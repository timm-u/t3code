import type { CommandCodeSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
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
  const runJson: TextGenerationOperations.Runner = Effect.fn("CommandCodeTextGeneration.runJson")(
    function* (request) {
      const result = yield* run({
        cwd: request.cwd,
        prompt: request.prompt,
        args: [
          ...commandCodeArgs({
            model: request.modelSelection.model,
            runtimeMode: "full-access",
            interactionMode: "plan",
            noSession: true,
          }),
          "--max-turns",
          request.investigate ? "64" : "1",
        ],
        onFrame: () => Effect.void,
      });
      if (result.subtype !== "success")
        return yield* new TextGenerationError({
          operation: request.operation,
          detail: commandCodeErrorText(result.error),
        });
      return yield* TextGenerationOperations.decodeJsonReply(
        request,
        "Command Code",
        result.finalText,
      );
    },
    (effect, request) =>
      effect.pipe(
        Effect.timeout(request.investigate?.timeoutMs ?? 180_000),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: request.operation,
              detail: "Command Code text generation failed.",
              cause,
            }),
        ),
      ),
  );
  return TextGenerationOperations.fromRunner("CommandCodeTextGeneration", runJson);
});
