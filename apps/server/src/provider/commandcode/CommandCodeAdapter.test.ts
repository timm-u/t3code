// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderAdapter from "../../orchestration-v2/ProviderAdapter.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";
import { commandCodeArgs, parseCommandCodeModels } from "./CommandCodeProtocol.ts";

const instanceId = ProviderInstanceId.make("commandcode-test");
const threadId = ThreadId.make("commandcode-test-thread");
const modelSelection = { instanceId, model: "default" };
const runtimePolicy = {
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  cwd: null,
};
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
  const sessionScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
  const sessionInput = {
    threadId,
    providerSessionId: ProviderSessionId.make("commandcode-test-session"),
    modelSelection,
    runtimePolicy,
  };
  const runtime = yield* adapter
    .openSession(sessionInput)
    .pipe(Effect.provideService(Scope.Scope, sessionScope));
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const terminals =
    yield* Queue.unbounded<
      Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
    >();
  const admitted = yield* Deferred.make<void>();
  const observe = (current: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
    Stream.runForEach(current.events, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "provider_thread.updated" && event.providerThread.nativeThreadRef)
          yield* Deferred.succeed(admitted, undefined);
        if (event.type === "turn.terminal") yield* Queue.offer(terminals, event);
      }),
    ).pipe(Effect.forkScoped);
  yield* observe(runtime);
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("commandcode-project"),
    title: "Command Code test",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: runtimePolicy.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const turnInput = (text: string, ordinal = 1, current = providerThread) => ({
    appThread,
    threadId,
    runId: RunId.make(`commandcode-run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`commandcode-attempt-${ordinal}`),
    rootNodeId: NodeId.make(`commandcode-node-${ordinal}`),
    providerThread: current,
    message: {
      messageId: MessageId.make(`commandcode-message-${ordinal}`),
      text,
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    },
    modelSelection,
    runtimePolicy,
  });
  return {
    adapter,
    runtime,
    sessionInput,
    sessionScope,
    events,
    terminals,
    admitted,
    observe,
    turnInput,
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-commandcode-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
    Effect.scoped,
  );
const isEvent = Schema.is(ProviderAdapter.ProviderAdapterV2Event);

describe("Command Code orchestration v2", () => {
  it("keeps restricted and plan runs read-only", () => {
    expect(commandCodeArgs({ runtimeMode: "approval-required" })).toContain("plan");
    expect(commandCodeArgs({ runtimeMode: "full-access", interactionMode: "plan" })).not.toContain(
      "--yolo",
    );
    expect(commandCodeArgs({ runtimeMode: "full-access" })).toContain("--yolo");
  });
  it("excludes headings and the documentation footer from the model catalog", () => {
    expect(
      parseCommandCodeModels(
        "Available models  ·  2 models\nOpen Source\ndeepseek/v4  Fast (default)\nclaude-sonnet-4-6  Reasoning\nDocs:  https://commandcode.ai/docs/reference/cli/models\n",
      ).map((m) => m.slug),
    ).toEqual(["deepseek/v4", "claude-sonnet-4-6"]);
  });
  it.effect(
    "streams distinct messages, reasoning and tools without duplicate final text, then resumes after session recreation",
    () =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.runtime.startTurn(f.turnInput('prompt with "quotes" & $() %PATH%'));
          expect((yield* Queue.take(f.terminals)).status).toBe("completed");
          expect(f.events.every(isEvent)).toBe(true);
          const messages = f.events
            .filter((e) => e.type === "message.updated")
            .filter((e) => !e.message.streaming);
          expect(messages.map((e) => e.message.text)).toEqual(["Before tool.", "Final answer."]);
          expect(
            f.events.filter(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "reasoning" &&
                e.turnItem.status === "completed",
            ),
          ).toHaveLength(1);
          const tools = f.events.filter(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "dynamic_tool" &&
              e.turnItem.status === "completed",
          );
          expect(tools).toHaveLength(1);
          const previous = f.events
            .filter((e) => e.type === "provider_thread.updated")
            .at(-1)!.providerThread;
          expect(previous.nativeThreadRef?.nativeId).toBe("mock-session");
          yield* Scope.close(f.sessionScope, Exit.void);
          const resumed = yield* f.adapter.openSession({
            ...f.sessionInput,
            providerSessionId: ProviderSessionId.make("commandcode-resumed"),
          });
          yield* f.observe(resumed);
          const current = yield* resumed.resumeThread({ providerThread: previous });
          yield* resumed.injectHistory!({
            providerThread: current,
            messages: [],
            context: "Remembered handoff context",
          });
          yield* resumed.startTurn({
            ...f.turnInput("continue", 2, current),
            runtimePolicy: { ...runtimePolicy, runtimeMode: "full-access" },
          });
          expect((yield* Queue.take(f.terminals)).status).toBe("completed");
          const tool = f.events
            .filter((e) => e.type === "turn_item.updated")
            .filter((e) => e.turnItem.type === "dynamic_tool" && e.turnItem.status === "completed")
            .at(-1)!;
          expect(tool.turnItem.type === "dynamic_tool" ? tool.turnItem.output : null).toMatchObject(
            {
              args: expect.arrayContaining(["--resume", "mock-session", "--yolo"]),
              prompt: "Remembered handoff context\n\ncontinue",
            },
          );
        }),
      ),
  );
  it.effect.each(["auth-error", "broken", "missing-result", "max-turns"])(
    "terminalizes %s once and accepts the next turn",
    (text) =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.runtime.startTurn(f.turnInput(text));
          expect((yield* Queue.take(f.terminals)).status).toBe("failed");
          const current = f.events
            .filter((e) => e.type === "provider_thread.updated")
            .at(-1)!.providerThread;
          yield* f.runtime.startTurn(f.turnInput("retry", 2, current));
          expect((yield* Queue.take(f.terminals)).status).toBe("completed");
          expect(f.events.filter((e) => e.type === "turn.terminal")).toHaveLength(2);
        }),
      ),
  );
  it.effect("stops the active CLI child and terminalizes it once", () =>
    provide(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.runtime.startTurn(f.turnInput("hang"));
        yield* Deferred.await(f.admitted);
        const active = f.events.find((e) => e.type === "provider_turn.updated")!.providerTurn;
        const current = f.events
          .filter((e) => e.type === "provider_thread.updated")
          .at(-1)!.providerThread;
        yield* f.runtime.interruptTurn({ providerThread: current, providerTurnId: active.id });
        expect((yield* Queue.take(f.terminals)).status).toBe("interrupted");
        expect(f.runtime.providerSession.status).toBe("ready");
        expect(f.events.filter((e) => e.type === "turn.terminal")).toHaveLength(1);
      }),
    ),
  );
});
