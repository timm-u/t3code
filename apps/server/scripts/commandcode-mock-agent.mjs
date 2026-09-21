const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const event = (value) => send({ type: "event", event: value });
if (prompt === "auth-error") {
  send({ type: "result", subtype: "error", error: "Not authenticated", finalText: "" });
  process.exitCode = 3;
} else {
  const resume = args.indexOf("--resume");
  const sessionId = resume < 0 ? "mock-session" : args[resume + 1];
  event({ type: "run_start", sessionId });
  if (prompt === "hang") {
    setInterval(() => {}, 60000);
  } else if (prompt === "broken") {
    process.stdout.write("invalid json\n");
  } else if (prompt === "missing-result") {
    event({ type: "text_delta", delta: "Partial" });
  } else {
    event({ type: "message_start" });
    event({ type: "thinking_delta", delta: "Checking" });
    event({ type: "thinking_end", text: "Checking" });
    event({ type: "text_delta", delta: "Before tool." });
    event({ type: "message_update", content: [{ type: "text", text: "Before tool." }] });
    event({ type: "message_end", content: [{ type: "text", text: "Before tool." }] });
    event({ type: "tool_running", toolCallId: "tool-1", toolName: "read_file", description: null });
    event({
      type: "tool_completed",
      toolCallId: "tool-1",
      toolName: "read_file",
      result: { args, prompt },
    });
    event({ type: "future_event", text: "IGNORE ME" });
    event({ type: "message_start" });
    event({ type: "text_delta", delta: "Final " });
    event({ type: "message_update", content: [{ type: "text", text: "Final " }] });
    event({ type: "text_delta", delta: "answer." });
    event({ type: "message_end", content: [{ type: "text", text: "Final answer." }] });
    send({
      type: "result",
      subtype: prompt === "max-turns" ? "max_turns" : "success",
      sessionId,
      finalText: "Final answer.",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  }
}
