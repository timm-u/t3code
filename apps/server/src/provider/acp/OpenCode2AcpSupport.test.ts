// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import {
  makeOpenCode2AdapterRuntime,
  openCode2Models,
  openCode2SelectOptions,
} from "./OpenCode2AcpSupport.ts";

describe("OpenCode 2 ACP", () => {
  for (const decision of ["accept", "decline"] as const) {
    it.effect(`routes ${decision} through native ACP without interactive login`, () =>
      Effect.gen(function* () {
        const server = yield* ServerConfig;
        const binaryPath = yield* Effect.sync(() =>
          writeFakeCli({
            directory: server.stateDir,
            name: "opencode2-mock",
            source: execScriptSource({
              scriptPath: NodeURL.fileURLToPath(
                new URL("../../../scripts/opencode2-mock-agent.mjs", import.meta.url),
              ),
              expectedArgs: ["acp"],
            }),
          }),
        );
        const instanceId = ProviderInstanceId.make("opencode");
        const threadId = ThreadId.make(`opencode2-${decision}`);
        const adapter = yield* makeGrokAdapter(
          { enabled: true, binaryPath, customModels: [] },
          {
            instanceId,
            protocol: {
              provider: ProviderDriverKind.make("opencode"),
              harness: "OpenCode 2",
              resumeVersion: 2,
              makeRuntime: makeOpenCode2AdapterRuntime,
              resolveModel: (model) => model?.trim() || "default",
            },
          },
        );
        const completed = yield* Deferred.make<void>();
        const deltas = yield* Ref.make("");
        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.type === "request.opened")
            return adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(event.requestId!),
              decision,
            );
          if (event.type === "content.delta")
            return Ref.update(deltas, (text) => text + event.payload.delta);
          if (event.type === "turn.completed") return Deferred.succeed(completed, undefined);
          return Effect.void;
        }).pipe(Effect.forkScoped);
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId, model: "openai/gpt-5.6-luna" },
        });
        expect(session.model).toBe("openai/gpt-5.6-luna");
        const turn = yield* adapter
          .sendTurn({ threadId, input: "Read fixture" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(completed);
        yield* Fiber.join(turn);
        expect(yield* Ref.get(deltas)).toBe(decision === "accept" ? "APPROVED_OK" : "DECLINED_OK");
        yield* adapter.stopAll();
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode2-mock-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      ),
    );
  }
  it("preserves provider-qualified model ids and grouped choices", () => {
    const options = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select" as const,
        currentValue: "openai/gpt-6-astra",
        options: [
          {
            group: "openai",
            name: "OpenAI",
            options: [{ value: "openai/gpt-6-astra", name: "Astra" }],
          },
        ],
      },
    ];
    expect(openCode2Models(options).map((model) => model.slug)).toEqual(["openai/gpt-6-astra"]);
    expect(
      openCode2SelectOptions({ id: "toggle", name: "Toggle", type: "boolean", currentValue: true }),
    ).toEqual([]);
  });

  it.effect.skipIf(!process.env.T3_OPENCODE2_LIVE_BINARY)(
    "streams a live v2 turn, then resumes the same session",
    () =>
      Effect.gen(function* () {
        const binaryPath = process.env.T3_OPENCODE2_LIVE_BINARY!;
        const instanceId = ProviderInstanceId.make("opencode");
        const threadId = ThreadId.make("opencode2-live-check");
        const server = yield* ServerConfig;
        const adapter = yield* makeGrokAdapter(
          { binaryPath, enabled: true, customModels: [] },
          {
            instanceId,
            protocol: {
              provider: ProviderDriverKind.make("opencode"),
              harness: "OpenCode 2",
              resumeVersion: 2,
              makeRuntime: makeOpenCode2AdapterRuntime,
              resolveModel: (value) => value?.trim() || "default",
            },
          },
        );
        const events = yield* Ref.make<ProviderRuntimeEvent[]>([]);
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Ref.update(events, (all) => [...all, event]),
        ).pipe(Effect.forkScoped);
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: instanceId,
          cwd: server.cwd,
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId,
            model: process.env.T3_OPENCODE2_LIVE_MODEL || "opencode/big-pickle",
          },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "Reply with exactly T3_OPENCODE2_OK. Do not use tools.",
        });
        const received = yield* Ref.get(events);
        const completed = received.filter((event) => event.type === "turn.completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.payload.state).toBe("completed");
        expect(
          received
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
        ).toContain("T3_OPENCODE2_OK");
        expect(received.every((event) => event.provider === "opencode")).toBe(true);
        yield* adapter.stopSession(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: instanceId,
          cwd: server.cwd,
          runtimeMode: "approval-required",
          resumeCursor: session.resumeCursor,
        });
        expect(resumed.resumeCursor).toEqual(session.resumeCursor);
        yield* adapter.stopAll();
        expect(yield* adapter.listSessions()).toHaveLength(0);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode2-live-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      ),
    120000,
  );
});
