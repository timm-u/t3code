// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";
import { commandCodeArgs, parseCommandCodeModels } from "./CommandCodeProtocol.ts";

const instanceId = ProviderInstanceId.make("commandcode-test");
const threadId = ThreadId.make("commandcode-test-thread");
const fixture = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const binaryPath = yield* Effect.sync(() =>
    writeFakeCli({
      directory: config.stateDir,
      name: "commandcode-mock",
      source: execScriptSource({
        scriptPath: NodeURL.fileURLToPath(
          new URL("../../../scripts/commandcode-mock-agent.mjs", import.meta.url),
        ),
      }),
    }),
  );
  const adapter = yield* makeCommandCodeAdapter({
    binaryPath,
    environment: process.env,
    instanceId,
    cwd: config.cwd,
  });
  const events: ProviderRuntimeEvent[] = [];
  const completed = yield* Deferred.make<void>();
  yield* Stream.runForEach(adapter.streamEvents, (event) => {
    events.push(event);
    return event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void;
  }).pipe(Effect.forkScoped);
  yield* adapter.startSession({ threadId, runtimeMode: "approval-required", cwd: config.cwd });
  return { adapter, events, completed, config };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-commandcode-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

describe("Command Code", () => {
  it("keeps restricted and plan runs read-only", () => {
    expect(commandCodeArgs({ runtimeMode: "approval-required" })).toContain("plan");
    expect(commandCodeArgs({ runtimeMode: "full-access", interactionMode: "plan" })).not.toContain(
      "--yolo",
    );
    expect(commandCodeArgs({ runtimeMode: "full-access" })).toContain("--yolo");
  });
  it("reads CLI model IDs without mistaking headings for models", () => {
    const models = parseCommandCodeModels(
      "Available models  ·  2 models\nOpen Source\ndeepseek/v4  Fast (default)\nclaude-sonnet-4-6  Reasoning\nDocs:  https://commandcode.ai/docs/reference/cli/models\n",
    );
    expect(models.map((x) => x.slug)).toEqual(["deepseek/v4", "claude-sonnet-4-6"]);
    expect(models[0]?.isDefault).toBe(true);
  });
  it.effect(
    "streams distinct messages and tools without repeating snapshots, then resumes the exact session",
    () =>
      provide(
        Effect.gen(function* () {
          const { adapter, events, completed, config } = yield* fixture;
          const turn = yield* adapter.sendTurn({
            threadId,
            input: 'prompt with "quotes" & $() %PATH%',
          });
          yield* Deferred.await(completed);
          expect(turn.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session" });
          const deltas = events
            .filter((x) => x.type === "content.delta")
            .filter((x) => x.payload.streamKind === "assistant_text");
          expect(deltas.map((x) => x.payload.delta).join("")).toBe("Before tool.Final answer.");
          expect(new Set(deltas.map((x) => x.itemId)).size).toBe(2);
          expect(
            events.filter(
              (x) => x.type === "item.completed" && x.payload.itemType === "dynamic_tool_call",
            ),
          ).toHaveLength(1);
          expect(events.filter((x) => x.type === "turn.completed")).toHaveLength(1);
          expect(
            events.every(
              (x) => x.provider === "commandcode" && x.providerInstanceId === instanceId,
            ),
          ).toBe(true);
          yield* adapter.stopSession(threadId);
          yield* adapter.startSession({
            threadId,
            runtimeMode: "full-access",
            cwd: config.cwd,
            resumeCursor: turn.resumeCursor,
          });
          const nextDone = yield* Deferred.make<void>();
          const nextEvents: ProviderRuntimeEvent[] = [];
          yield* Stream.runForEach(adapter.streamEvents, (e) => {
            nextEvents.push(e);
            return e.type === "turn.completed"
              ? Deferred.succeed(nextDone, undefined)
              : Effect.void;
          }).pipe(Effect.forkScoped);
          yield* adapter.sendTurn({ threadId, input: "continue" });
          yield* Deferred.await(nextDone);
          const tool = nextEvents.find(
            (e) => e.type === "item.completed" && e.payload.itemType === "dynamic_tool_call",
          );
          expect(tool?.type === "item.completed" ? tool.payload.data : undefined).toMatchObject({
            args: expect.arrayContaining(["--resume", "mock-session", "--yolo"]),
            prompt: "continue",
          });
        }),
      ),
  );
  for (const prompt of ["auth-error", "broken", "missing-result", "max-turns"]) {
    it.effect(`finishes ${prompt} with one failed terminal event`, () =>
      provide(
        Effect.gen(function* () {
          const { adapter, events, completed } = yield* fixture;
          yield* adapter.sendTurn({ threadId, input: prompt }).pipe(Effect.result);
          yield* Deferred.await(completed);
          const terminal = events.filter((e) => e.type === "turn.completed");
          expect(terminal).toHaveLength(1);
          expect(terminal[0]?.payload.state).toBe("failed");
        }),
      ),
    );
  }
  it.effect("interrupts an active child and clears the active turn", () =>
    provide(
      Effect.gen(function* () {
        const { adapter, events, completed } = yield* fixture;
        yield* adapter.sendTurn({ threadId, input: "hang" });
        yield* adapter.interruptTurn(threadId);
        yield* Deferred.await(completed);
        expect(
          events.filter((e) => e.type === "turn.completed").map((e) => e.payload.state),
        ).toEqual(["interrupted"]);
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
      }),
    ),
  );
});
