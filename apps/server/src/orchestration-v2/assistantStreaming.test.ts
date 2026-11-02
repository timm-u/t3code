import { describe, expect, it } from "vite-plus/test";
import { MessageId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";

describe("V2 assistant streaming", () => {
  it("delivers reasoning without waiting for Markdown boundaries while respecting turn buffering", () => {
    const now = DateTime.makeUnsafe("2026-10-31T00:00:00Z");
    const event = {
      type: "turn_item.updated",
      driver: ProviderDriverKind.make("commandcode"),
      turnItem: {
        id: TurnItemId.make("streaming-reasoning"),
        threadId: ThreadId.make("streaming-thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "reasoning",
        text: "Let me inspect the file",
        streaming: true,
      },
    } satisfies ProviderAdapter.ProviderAdapterV2Event;
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(event, 0)).toEqual(event);
    const next = {
      ...event,
      turnItem: { ...event.turnItem, text: "Let me inspect the file first" },
    };
    expect(filter(next, 200)).toBeNull();
    expect(filter(next, 400)).toEqual(next);
    const answer = {
      ...event,
      turnItem: {
        ...event.turnItem,
        id: TurnItemId.make("streaming-answer"),
        messageId: MessageId.make("streaming-answer-message"),
        type: "assistant_message" as const,
      },
    };
    expect(filter(answer, 0)).toBeNull();
    expect(makeAssistantStreamingFilter("turn")(event, 0)).toBeNull();
    const completed = {
      ...next,
      turnItem: {
        ...next.turnItem,
        status: "completed" as const,
        streaming: false,
        completedAt: now,
      },
    };
    expect(filter(completed, 401)).toEqual(completed);
  });

  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});
