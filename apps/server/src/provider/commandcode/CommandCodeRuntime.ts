import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  decodeCommandCodeFrame,
  type CommandCodeFrame,
  type CommandCodeResult,
} from "./CommandCodeProtocol.ts";

export class CommandCodeProcessError extends Schema.TaggedError<CommandCodeProcessError>()(
  "CommandCodeProcessError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}
const isRequestError = Schema.is(CommandCodeProcessError);

export const makeCommandCodeRunner = Effect.fn("makeCommandCodeRunner")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return Effect.fn("CommandCode.run")(
    function* (input: {
      args: ReadonlyArray<string>;
      cwd: string;
      prompt: string;
      onFrame: (frame: CommandCodeFrame) => Effect.Effect<void>;
    }) {
      const command = yield* resolveSpawnCommand(binaryPath, input.args, { env: environment });
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          cwd: input.cwd,
          env: environment,
          extendEnv: true,
          shell: command.shell,
        }),
      );
      let result: CommandCodeResult | undefined;
      const frames = child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.runForEach((line) =>
          decodeCommandCodeFrame(line).pipe(
            Effect.flatMap((frame) => {
              if (frame.type === "result") result = frame;
              return input.onFrame(frame);
            }),
          ),
        ),
      );
      const [, stderr, code] = yield* Effect.all(
        [
          frames,
          collectUint8StreamText({ stream: child.stderr, maxBytes: 16_384 }),
          child.exitCode,
          // Prompt text goes over stdin, never through Windows shell quoting.
          Stream.run(Stream.encodeText(Stream.make(input.prompt)), child.stdin),
        ],
        { concurrency: "unbounded" },
      );
      if (!result)
        return yield* new CommandCodeProcessError({
          detail: `Command Code exited (${Number(code)}) without a result. ${stderr.text.trim()}`,
        });
      if (Number(code) !== 0 && result.subtype === "success")
        return yield* new CommandCodeProcessError({
          detail: `Command Code exited with code ${Number(code)}.`,
        });
      return result;
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      isRequestError(cause)
        ? cause
        : new CommandCodeProcessError({
            detail: "Command Code process or JSON stream failed.",
            cause,
          }),
    ),
  );
});
