import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeCommandCodeRunner } from "./CommandCodeRuntime.ts";
import {
  commandCodeArgs,
  commandCodeErrorText,
  CommandCodeResume,
  type CommandCodeResult,
} from "./CommandCodeProtocol.ts";

const provider = ProviderDriverKind.make("commandcode");
const decodeResume = Schema.decodeUnknownEffect(CommandCodeResume);
const parseResume = Schema.decodeUnknownOption(CommandCodeResume);
type Update<E = ProviderRuntimeEvent> = E extends ProviderRuntimeEvent
  ? Omit<E, "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt">
  : never;
interface SessionContext {
  session: ProviderSession;
  fiber?: Fiber.Fiber<void> | undefined;
  interrupted: boolean;
}

export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (options: {
  binaryPath: string;
  environment: NodeJS.ProcessEnv;
  instanceId: ProviderInstanceId;
  cwd: string;
}) {
  const scope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const run = yield* makeCommandCodeRunner(options.binaryPath, options.environment);
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, SessionContext>();
  const fail = (method: string, detail: string) =>
    new ProviderAdapterRequestError({ provider, method, detail });
  const id = () => crypto.randomUUIDv4.pipe(Effect.orDie);
  const emit = (ctx: SessionContext, update: Update) =>
    Effect.gen(function* () {
      yield* PubSub.publish(events, {
        ...update,
        eventId: EventId.make(yield* id()),
        provider,
        providerInstanceId: options.instanceId,
        threadId: ctx.session.threadId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      } as ProviderRuntimeEvent);
    });
  const requireSession = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const ctx = sessions.get(threadId);
      return ctx
        ? Effect.succeed(ctx)
        : Effect.fail(fail("session", "Command Code session is not active."));
    });
  const interrupt = Effect.fn("CommandCode.interrupt")(function* (ctx: SessionContext) {
    ctx.interrupted = true;
    if (ctx.fiber) yield* Fiber.interrupt(ctx.fiber);
  });
  const stop = Effect.fn("CommandCode.stop")(function* (threadId: ThreadId) {
    const ctx = sessions.get(threadId);
    if (!ctx) return;
    yield* interrupt(ctx);
    sessions.delete(threadId);
    yield* emit(ctx, {
      type: "session.exited",
      payload: { exitKind: "graceful", reason: "Session stopped" },
    });
  });
  const stopAll = () => Effect.forEach([...sessions.keys()], stop, { discard: true });
  yield* Effect.addFinalizer(stopAll);

  return {
    provider,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession: (input) =>
      Effect.gen(function* () {
        yield* stop(input.threadId);
        const resume =
          input.resumeCursor === undefined
            ? undefined
            : yield* decodeResume(input.resumeCursor).pipe(
                Effect.mapError(() => fail("resume", "Invalid Command Code session cursor.")),
              );
        const now = DateTime.formatIso(yield* DateTime.now);
        const session: ProviderSession = {
          provider,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd ?? options.cwd,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          ...(resume ? { resumeCursor: resume } : {}),
          createdAt: now,
          updatedAt: now,
        };
        const ctx: SessionContext = { session, interrupted: false };
        sessions.set(input.threadId, ctx);
        yield* emit(ctx, { type: "session.started", payload: { ...(resume ? { resume } : {}) } });
        return session;
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.session.activeTurnId)
          return yield* fail(
            "prompt",
            "A Command Code turn is already running. Queue the follow-up or interrupt it first.",
          );
        if (!input.input?.trim())
          return yield* fail("prompt", "Command Code requires a text prompt.");
        if (input.attachments?.length)
          return yield* fail(
            "prompt",
            "Command Code headless mode does not accept T3 attachments yet. Reference workspace files in your prompt.",
          );
        const turnId = TurnId.make(yield* id());
        const admitted = yield* Deferred.make<
          ProviderTurnStartResult,
          ProviderAdapterRequestError
        >();
        const resume = parseResume(ctx.session.resumeCursor);
        const model = input.modelSelection?.model ?? ctx.session.model;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          ...(model ? { model } : {}),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        ctx.interrupted = false;
        let result: CommandCodeResult | undefined;
        let textItem: RuntimeItemId | undefined;
        let reasoningItem: RuntimeItemId | undefined;
        let text = "";
        let lastMessageText = "";
        const closeText = Effect.fn("CommandCode.closeText")(function* () {
          if (!textItem) return;
          yield* emit(ctx, {
            type: "item.completed",
            turnId,
            itemId: textItem,
            payload: { itemType: "assistant_message", status: "completed", data: { text } },
          });
          lastMessageText = text;
          textItem = undefined;
          text = "";
        });
        const appendText = Effect.fn("CommandCode.appendText")(function* (delta: string) {
          if (!delta) return;
          if (!textItem) {
            textItem = RuntimeItemId.make(yield* id());
            yield* emit(ctx, {
              type: "item.started",
              turnId,
              itemId: textItem,
              payload: { itemType: "assistant_message", status: "inProgress" },
            });
          }
          text += delta;
          yield* emit(ctx, {
            type: "content.delta",
            turnId,
            itemId: textItem,
            payload: { streamKind: "assistant_text", delta },
          });
        });
        const body = Effect.gen(function* () {
          yield* emit(ctx, {
            type: "turn.started",
            turnId,
            payload: { ...(model ? { model } : {}) },
          });
          result = yield* run({
            cwd: ctx.session.cwd ?? options.cwd,
            prompt: input.input!,
            args: commandCodeArgs({
              model,
              runtimeMode: ctx.session.runtimeMode,
              interactionMode: input.interactionMode,
              resumeSessionId: resume._tag === "Some" ? resume.value.sessionId : undefined,
            }),
            onFrame: (frame) =>
              Effect.gen(function* () {
                if (frame.type === "result") return;
                const event = frame.event;
                if (event.type === "run_start" && event.sessionId) {
                  const resumeCursor = { schemaVersion: 1 as const, sessionId: event.sessionId };
                  ctx.session = { ...ctx.session, resumeCursor };
                  yield* emit(ctx, {
                    type: "thread.started",
                    payload: { providerThreadId: event.sessionId },
                  });
                  yield* Deferred.succeed(admitted, {
                    threadId: input.threadId,
                    turnId,
                    resumeCursor,
                  });
                } else if (event.type === "text_delta" && event.delta) {
                  yield* appendText(event.delta);
                } else if (event.type === "message_end") {
                  yield* closeText();
                } else if (event.type === "thinking_delta" && event.delta) {
                  if (!reasoningItem) {
                    reasoningItem = RuntimeItemId.make(yield* id());
                    yield* emit(ctx, {
                      type: "item.started",
                      turnId,
                      itemId: reasoningItem,
                      payload: { itemType: "reasoning" },
                    });
                  }
                  yield* emit(ctx, {
                    type: "content.delta",
                    turnId,
                    itemId: reasoningItem,
                    payload: { streamKind: "reasoning_text", delta: event.delta },
                  });
                } else if (event.type === "thinking_end" && reasoningItem) {
                  yield* emit(ctx, {
                    type: "item.completed",
                    turnId,
                    itemId: reasoningItem,
                    payload: { itemType: "reasoning", status: "completed" },
                  });
                  reasoningItem = undefined;
                } else if (
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
                  yield* emit(ctx, {
                    type: running ? "item.started" : "item.completed",
                    turnId,
                    itemId: RuntimeItemId.make(event.toolCallId),
                    payload: {
                      itemType: "dynamic_tool_call",
                      status: running
                        ? "inProgress"
                        : event.type === "tool_completed"
                          ? "completed"
                          : "failed",
                      title: event.toolName || "Tool",
                      ...(event.description ? { detail: event.description } : {}),
                      data: event.result ?? event.error,
                    },
                  });
                }
              }),
          });
          // NDJSON includes cumulative message snapshots and a repeated final result.
          // Only deltas enter the answer; use finalText solely if no final text streamed.
          if (result.finalText && !text && result.finalText !== lastMessageText)
            yield* appendText(result.finalText);
          yield* closeText();
          if (result.subtype !== "success")
            return yield* fail(
              "prompt",
              result.subtype === "max_turns"
                ? "Command Code reached its turn limit. Send a follow-up to continue."
                : commandCodeErrorText(result.error),
            );
        }).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const failed = Exit.isFailure(exit) && !ctx.interrupted;
              const detail = failed ? commandCodeErrorText(Cause.squash(exit.cause)) : undefined;
              yield* closeText();
              const usage = result?.usage;
              const { activeTurnId: _, ...session } = ctx.session;
              ctx.session = {
                ...session,
                status: "ready",
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              };
              ctx.fiber = undefined;
              yield* emit(ctx, {
                type: "turn.completed",
                turnId,
                payload: {
                  state: ctx.interrupted ? "interrupted" : failed ? "failed" : "completed",
                  ...(detail ? { errorMessage: detail } : {}),
                  ...(usage ? { usage } : {}),
                },
              });
              yield* Deferred.fail(
                admitted,
                fail("prompt", detail ?? "Command Code stopped before opening the session."),
              );
            }),
          ),
          Effect.ignore,
        );
        ctx.fiber = yield* Effect.forkIn(body, scope);
        return yield* Deferred.await(admitted);
      }),
    interruptTurn: (threadId, turnId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((ctx) =>
          turnId && turnId !== ctx.session.activeTurnId ? Effect.void : interrupt(ctx),
        ),
      ),
    stopSession: stop,
    stopAll,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) => requireSession(threadId).pipe(Effect.as({ threadId, turns: [] })),
    rollbackThread: () =>
      Effect.fail(
        fail("rollback", "Command Code headless sessions do not support conversation rollback."),
      ),
    respondToRequest: () =>
      Effect.fail(
        fail(
          "approval",
          "Command Code headless mode cannot answer interactive approvals. Use Full access to permit edits, or Plan for read-only work.",
        ),
      ),
    respondToUserInput: () =>
      Effect.fail(fail("input", "Reply with a follow-up message to Command Code.")),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterRequestError>;
});
