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
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import { commandCodeSessionMode, makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";

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
    selfInvocation: yield* resolveSelfInvocation(),
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
  const updates = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const observe = (current: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
    Stream.runForEach(current.events, (event) =>
      Effect.gen(function* () {
        events.push(event);
        yield* Queue.offer(updates, event);
        if (event.type === "provider_thread.updated" && event.providerThread.nativeThreadRef)
          yield* Deferred.succeed(admitted, undefined);
        if (event.type === "turn.terminal") yield* Queue.offer(terminals, event);
      }),
    ).pipe(Effect.forkScoped);
  yield* observe(runtime);
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const waitFor = (
    predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
  ): Effect.Effect<ProviderAdapter.ProviderAdapterV2Event> =>
    Queue.take(updates).pipe(
      Effect.flatMap((event) => (predicate(event) ? Effect.succeed(event) : waitFor(predicate))),
    );
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
    providerThread,
    waitFor,
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        layerTestProviderHost().pipe(Layer.provide(NodeServices.layer)),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-commandcode-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
    Effect.scoped,
  );
const isEvent = Schema.is(ProviderAdapter.ProviderAdapterV2Event);

describe("Command Code ACP adapter", () => {
  it("maps plan and access policies to native Command Code modes", () => {
    expect(commandCodeSessionMode(runtimePolicy)).toBe("default");
    expect(commandCodeSessionMode({ ...runtimePolicy, runtimeMode: "full-access" })).toBe("bypass");
    expect(
      commandCodeSessionMode({
        ...runtimePolicy,
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    ).toBe("plan");
  });

  it.effect(
    "streams text, reasoning, and tools without losing the final answer",
    () =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          expect(f.providerThread.nativeThreadRef?.nativeId).toBe("mock-session");
          yield* f.runtime.startTurn(f.turnInput("hello"));
          expect((yield* Queue.take(f.terminals)).status).toBe("completed");
          expect(f.events.every(isEvent)).toBe(true);
          const serialized = JSON.stringify(f.events);
          expect(serialized).toContain("Before tool.");
          expect(serialized).toContain("Thinking.");
          expect(serialized).toContain("Final answer.");
          expect(serialized).toContain("fixture.txt");
          expect(f.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        }),
      ),
    { timeout: 15_000 },
  );

  it.effect(
    "loads existing native sessions without replaying history as a new reply",
    () =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Scope.close(f.sessionScope, Exit.void);
          const resumed = yield* f.adapter.openSession({
            ...f.sessionInput,
            providerSessionId: ProviderSessionId.make("commandcode-resumed-session"),
            initialNativeThreadId: "mock-session",
          });
          yield* f.observe(resumed);
          const thread = yield* resumed.resumeThread({
            providerThread: f.providerThread,
            modelSelection,
            runtimePolicy,
          });
          yield* resumed.startTurn(f.turnInput("after restart", 2, thread));
          expect((yield* Queue.take(f.terminals)).status).toBe("completed");
          expect(JSON.stringify(f.events)).not.toContain("Historical reply.");
          expect(JSON.stringify(f.events)).toContain("Final answer.");
        }),
      ),
    { timeout: 15_000 },
  );

  it.effect(
    "waits for approval and sends the selected permission to ACP",
    () =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.runtime.startTurn(f.turnInput("permission"));
          const event = yield* f.waitFor(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
          if (event.type !== "runtime_request.updated")
            throw new Error("Expected permission request");
          expect(f.events.filter((event) => event.type === "turn.terminal")).toHaveLength(0);
          yield* f.runtime.respondToRuntimeRequest({
            requestId: event.runtimeRequest.id,
            decision: "accept",
          });
          expect((yield* Queue.take(f.terminals)).status).toBe("completed");
        }),
      ),
    { timeout: 15_000 },
  );

  it.effect(
    "interrupts a pending native prompt exactly once",
    () =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.runtime.startTurn(f.turnInput("hang"));
          const event = yield* f.waitFor(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "running",
          );
          if (event.type !== "provider_turn.updated") throw new Error("Expected running turn");
          yield* f.waitFor(
            (event) =>
              event.type === "turn_item.updated" &&
              JSON.stringify(event).includes("Waiting for cancellation"),
          );
          yield* f.runtime.interruptTurn({
            providerThread: f.providerThread,
            providerTurnId: event.providerTurn.id,
          });
          expect((yield* Queue.take(f.terminals)).status).toBe("interrupted");
          expect(f.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        }),
      ),
    { timeout: 15_000 },
  );

  it.effect(
    "asks for a choice even in full access and returns the selected option",
    () =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.runtime.startTurn({
            ...f.turnInput("question"),
            runtimePolicy: { ...runtimePolicy, runtimeMode: "full-access" },
          });
          const event = yield* f.waitFor(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.kind === "user_input" &&
              event.runtimeRequest.status === "pending",
          );
          if (event.type !== "runtime_request.updated") throw new Error("Expected question");
          expect(f.events.filter((event) => event.type === "turn.terminal")).toHaveLength(0);
          yield* f.runtime.respondToRuntimeRequest({
            requestId: event.runtimeRequest.id,
            answers: { "question-1": ["option_1"] },
          });
          expect((yield* Queue.take(f.terminals)).status).toBe("completed");
          expect(JSON.stringify(f.events)).toContain("option_1");
        }),
      ),
    { timeout: 15_000 },
  );

  it.effect(
    "settles native RPC failures instead of leaving a turn spinning",
    () =>
      provide(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.runtime.startTurn(f.turnInput("auth-error"));
          const terminal = yield* Queue.take(f.terminals);
          expect(terminal.status).toBe("failed");
          expect(JSON.stringify(terminal)).toContain("Authentication expired");
          expect(f.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        }),
      ),
    { timeout: 15_000 },
  );
});
