import * as NodeReadline from "node:readline";
let model = "openai/gpt-6-astra";
let activePrompt;
const sessionId = "opencode2-mock-session";
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const result = (id, value) => send({ id, result: value });
const options = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "openai/gpt-6-astra", name: "Astra" },
      { value: "openai/gpt-5.6-luna", name: "Luna" },
    ],
  },
];
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === "approval") {
    const approved =
      request.result?.outcome?.outcome === "selected" && request.result.outcome.optionId === "once";
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: approved ? "APPROVED_OK" : "DECLINED_OK" },
        },
      },
    });
    result(activePrompt, { stopReason: "end_turn" });
    activePrompt = undefined;
    return;
  }
  switch (request.method) {
    case "initialize":
      return result(request.id, {
        protocolVersion: 1,
        agentInfo: { name: "OpenCode", version: "0.0.0-beta-test" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        authMethods: [],
      });
    case "authenticate":
      return send({
        id: request.id,
        error: { code: -32601, message: "V2 must not start interactive authentication" },
      });
    case "session/new":
    case "session/resume":
      return result(request.id, { sessionId, configOptions: options() });
    case "session/set_config_option":
      model = request.params.value;
      return result(request.id, { configOptions: options() });
    case "session/prompt":
      activePrompt = request.id;
      send({
        id: "approval",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "mock-read",
            title: "Read fixture",
            kind: "read",
            status: "pending",
            rawInput: { path: "fixture.txt" },
          },
          options: [
            { optionId: "once", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    case "session/cancel":
      if (activePrompt !== undefined) result(activePrompt, { stopReason: "cancelled" });
      activePrompt = undefined;
      return;
    default:
      if (request.id !== undefined) result(request.id, {});
  }
});
