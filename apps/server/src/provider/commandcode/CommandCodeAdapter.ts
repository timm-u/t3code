import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderAdapter from "../../orchestration-v2/ProviderAdapter.ts";
import { AcpProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import { turnScopedSelectionTransition } from "../../orchestration-v2/ProviderSelectionTransition.ts";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "../../orchestration-v2/ProviderFailure.ts";
import { makeCommandCodeRunner } from "./CommandCodeRuntime.ts";
import { commandCodeArgs, commandCodeErrorText } from "./CommandCodeProtocol.ts";

const driver = ProviderDriverKind.make("commandcode");
const capabilities = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
  turns: { ...AcpProviderCapabilitiesV2.turns, supportsSteeringByInterruptRestart: false },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  context: { ...AcpProviderCapabilitiesV2.context, canGenerateSummaries: false },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface ActiveTurn {
  providerTurn: OrchestrationV2ProviderTurn;
  fiber?: Fiber.Fiber<void>;
  interrupted: boolean;
}

export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (options: {
  binaryPath: string;
  environment: NodeJS.ProcessEnv;
  instanceId: ProviderInstanceId;
  cwd: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const run = yield* makeCommandCodeRunner(options.binaryPath, options.environment);
  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });
  const nativeRef = (nativeId: string) => ({ driver, nativeId, strength: "strong" as const });
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("CommandCode.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? options.cwd,
        model: input.modelSelection.model,
        capabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      let pendingContext = "";
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const updateSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) =>
        Effect.gen(function* () {
          session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
          yield* emit({ type: "provider_session.updated", driver, providerSession: session });
        });
      const updateThread = (patch: Partial<OrchestrationV2ProviderThread>) =>
        Effect.gen(function* () {
          if (!thread) return;
          thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
          yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
        });
      const register = Effect.fn("CommandCode.ensureThread")(function* (
        request: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (active)
          return yield* protocolError("Cannot change Command Code threads while a turn is running");
        const createdAt = yield* DateTime.now;
        const existing = request.existingProviderThread;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: ids.derive.providerThread({
                driver,
                providerInstanceId: options.instanceId,
                nativeThreadId: `pending:${request.threadId}`,
              }),
              driver,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: request.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
        yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
        return thread;
      });
      const interrupt = Effect.fn("CommandCode.interrupt")(function* () {
        const turn = active;
        if (!turn) return;
        turn.interrupted = true;
        if (turn.fiber) yield* Fiber.interrupt(turn.fiber);
      });
      yield* Effect.addFinalizer(() => interrupt().pipe(Effect.andThen(Queue.shutdown(events))));
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return session;
        },
        events: Stream.fromQueue(events),
        ensureThread: register,
        resumeThread: (request) =>
          register({
            threadId: request.threadId ?? request.providerThread.appThreadId ?? input.threadId,
            modelSelection: request.modelSelection ?? input.modelSelection,
            runtimePolicy: request.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: request.providerThread,
          }),
        injectHistory: (request) =>
          Effect.sync(() => {
            pendingContext = request.context;
            return true;
          }),
        startTurn: Effect.fn("CommandCode.startTurn")(function* (turnInput) {
          if (active)
            return yield* protocolError(
              "A Command Code turn is already running. Queue the follow-up or stop it first",
            );
          if (!thread || thread.id !== turnInput.providerThread.id)
            return yield* protocolError("Command Code thread is not registered");
          if (!turnInput.message.text.trim())
            return yield* protocolError("Command Code requires a text prompt");
          if (turnInput.message.attachments.length)
            return yield* protocolError(
              "Command Code does not accept T3 attachments yet. Reference workspace files in your prompt",
            );
          thread = turnInput.providerThread;
          const startedAt = yield* DateTime.now;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: ids.derive.providerTurn({
              driver,
              nativeTurnId: `${options.instanceId}:${turnInput.runId}:${turnInput.providerTurnOrdinal}`,
            }),
            providerThreadId: thread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: null,
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          const turn: ActiveTurn = { providerTurn, interrupted: false };
          active = turn;
          const prompt = pendingContext
            ? `${pendingContext}\n\n${turnInput.message.text}`
            : turnInput.message.text;
          pendingContext = "";
          let nextOrdinal = 0;
          const items = new Map<string, { ordinal: number; startedAt: DateTime.Utc }>();
          let textItem: string | undefined;
          let reasoningItem: string | undefined;
          let text = "";
          let reasoning = "";
          let lastText = "";
          const itemId = () =>
            crypto.randomUUIDv4.pipe(
              Effect.orDie,
              Effect.map((id) => `${options.instanceId}:${providerTurn.id}:${id}`),
            );
          const base = (
            key: string,
            emittedAt: DateTime.Utc,
            status: OrchestrationV2TurnItem["status"],
          ) => {
            let item = items.get(key);
            if (!item) {
              item = { ordinal: nextOrdinal++, startedAt: emittedAt };
              items.set(key, item);
            }
            return {
              id: ids.derive.turnItemFromProviderItem({ driver, nativeItemId: key }),
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              providerThreadId: providerTurn.providerThreadId,
              providerTurnId: providerTurn.id,
              nativeItemRef: nativeRef(key),
              parentItemId: null,
              ordinal: item.ordinal,
              status,
              title: null,
              startedAt: item.startedAt,
              completedAt: status === "running" ? null : emittedAt,
              updatedAt: emittedAt,
            };
          };
          const publishText = Effect.fn("CommandCode.publishText")(function* (
            kind: "assistant_message" | "reasoning",
            done: boolean,
          ) {
            const key = kind === "assistant_message" ? textItem : reasoningItem;
            if (!key) return;
            const emittedAt = yield* DateTime.now;
            const item = base(key, emittedAt, done ? "completed" : "running");
            if (kind === "reasoning") {
              yield* emit({
                type: "turn_item.updated",
                driver,
                turnItem: { ...item, type: "reasoning", text: reasoning, streaming: !done },
              });
              if (done) {
                reasoningItem = undefined;
                reasoning = "";
              }
              return;
            }
            const messageId = ids.derive.messageFromProviderItem({ driver, nativeItemId: key });
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: { ...item, type: "assistant_message", messageId, text, streaming: !done },
            });
            yield* emit({
              type: "message.updated",
              driver,
              message: {
                id: messageId,
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                nodeId: turnInput.rootNodeId,
                role: "assistant",
                text,
                attachments: [],
                streaming: !done,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt!,
                updatedAt: emittedAt,
              },
            });
            if (done) {
              lastText = text;
              textItem = undefined;
              text = "";
            }
          });
          const appendText = Effect.fn("CommandCode.appendText")(function* (delta: string) {
            if (!delta) return;
            textItem ??= yield* itemId();
            text += delta;
            yield* publishText("assistant_message", false);
          });
          const body = Effect.gen(function* () {
            yield* updateSession("running");
            yield* updateThread({
              status: "active",
              firstRunOrdinal: thread?.firstRunOrdinal ?? turnInput.runOrdinal,
              lastRunOrdinal: turnInput.runOrdinal,
            });
            yield* emit({
              type: "provider_turn.updated",
              driver,
              threadId: turnInput.threadId,
              providerTurn,
            });
            const resumeSessionId = thread?.nativeThreadRef?.nativeId ?? undefined;
            const result = yield* run({
              cwd: turnInput.runtimePolicy.cwd ?? session.cwd,
              prompt,
              args: commandCodeArgs({
                model: turnInput.modelSelection.model,
                resumeSessionId,
                runtimeMode: turnInput.runtimePolicy.runtimeMode,
                interactionMode: turnInput.runtimePolicy.interactionMode,
              }),
              onFrame: (frame) =>
                Effect.gen(function* () {
                  if (frame.type === "result") return;
                  const event = frame.event;
                  if (event.type === "run_start" && event.sessionId) {
                    if (resumeSessionId && event.sessionId !== resumeSessionId)
                      return yield* Effect.die(
                        protocolError("Command Code resumed a different native session"),
                      );
                    yield* updateThread({ nativeThreadRef: nativeRef(event.sessionId) });
                  } else if (event.type === "text_delta" && event.delta)
                    yield* appendText(event.delta);
                  else if (event.type === "message_end")
                    yield* publishText("assistant_message", true);
                  else if (event.type === "thinking_delta" && event.delta) {
                    reasoningItem ??= yield* itemId();
                    reasoning += event.delta;
                    yield* publishText("reasoning", false);
                  } else if (event.type === "thinking_end") yield* publishText("reasoning", true);
                  else if (
                    event.toolCallId &&
                    [
                      "tool_running",
                      "tool_completed",
                      "tool_errored",
                      "tool_denied",
                      "tool_hook_blocked",
                    ].includes(event.type)
                  ) {
                    const running = event.type === "tool_running";
                    const emittedAt = yield* DateTime.now;
                    const key = `${options.instanceId}:${providerTurn.id}:tool:${event.toolCallId}`;
                    yield* emit({
                      type: "turn_item.updated",
                      driver,
                      turnItem: {
                        ...base(
                          key,
                          emittedAt,
                          running
                            ? "running"
                            : event.type === "tool_completed"
                              ? "completed"
                              : "failed",
                        ),
                        type: "dynamic_tool",
                        title: event.toolName || "Tool",
                        toolName: event.toolName || null,
                        input: event.description ?? null,
                        output: event.result ?? event.error,
                      },
                    });
                  }
                }),
            });
            if (result.finalText && !text && result.finalText !== lastText)
              yield* appendText(result.finalText);
            yield* publishText("assistant_message", true);
            if (result.subtype !== "success")
              return yield* protocolError(
                result.subtype === "max_turns"
                  ? "Command Code reached its turn limit. Send a follow-up to continue"
                  : commandCodeErrorText(result.error),
              );
          }).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* publishText("assistant_message", true);
                yield* publishText("reasoning", true);
                const completedAt = yield* DateTime.now;
                const failure =
                  Exit.isFailure(exit) && !turn.interrupted
                    ? makeProviderFailure({
                        message: commandCodeErrorText(Cause.squash(exit.cause)),
                      })
                    : null;
                const status = turn.interrupted ? "interrupted" : failure ? "failed" : "completed";
                yield* emit({
                  type: "provider_turn.updated",
                  driver,
                  threadId: turnInput.threadId,
                  providerTurn: { ...providerTurn, status, completedAt },
                });
                yield* updateThread({ status: "idle" });
                yield* updateSession("ready", failure?.message ?? null);
                active = undefined;
                if (failure) {
                  const ordinal = Math.max(1, nextOrdinal);
                  yield* emit({
                    type: "turn_item.updated",
                    driver,
                    turnItem: makeProviderFailureTurnItem({
                      idAllocator: ids,
                      driver,
                      threadId: turnInput.threadId,
                      runId: turnInput.runId,
                      nodeId: turnInput.rootNodeId,
                      providerThreadId: providerTurn.providerThreadId,
                      providerTurnId: providerTurn.id,
                      itemOrdinal: ordinal,
                      failure,
                      occurredAt: completedAt,
                    }),
                  });
                  yield* emit({
                    type: "turn.terminal",
                    driver,
                    providerThreadId: providerTurn.providerThreadId,
                    providerTurnId: providerTurn.id,
                    runOrdinal: turnInput.runOrdinal,
                    failureItemOrdinal: ordinal,
                    status: "failed",
                    failure,
                    threadDisposition: "reusable",
                  });
                } else
                  yield* emit({
                    type: "turn.terminal",
                    driver,
                    providerThreadId: providerTurn.providerThreadId,
                    providerTurnId: providerTurn.id,
                    runOrdinal: turnInput.runOrdinal,
                    status: turn.interrupted ? "interrupted" : "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  });
              }),
            ),
            Effect.ignore,
          );
          turn.fiber = yield* body.pipe(Effect.forkIn(scope));
        }),
        steerTurn: (request) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: request.providerThread.id,
            }),
          ),
        interruptTurn: (request) =>
          active?.providerTurn.id === request.providerTurnId ? interrupt() : Effect.void,
        respondToRuntimeRequest: () =>
          Effect.fail(
            protocolError("Command Code headless mode cannot answer interactive requests"),
          ),
        readThreadSnapshot: () =>
          Effect.fail(protocolError("Command Code conversation snapshots are not supported")),
        rollbackThread: () =>
          Effect.fail(protocolError("Command Code conversation rollback is not supported")),
        forkThread: () =>
          Effect.fail(protocolError("Command Code native conversation forks are not supported")),
      };
      return runtime;
    }),
  });
});
