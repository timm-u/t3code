import * as NodeReadline from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const sessionId = "mock-session";
let mode = "default",
  model = "model-a",
  waitingPrompt;
const pending = new Map();
const update = (value) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const setup = () => ({
  models: { currentModelId: model, availableModels: [{ modelId: "model-a", name: "Model A" }] },
  modes: {
    currentModeId: mode,
    availableModes: ["default", "plan", "bypass"].map((id) => ({ id, name: id })),
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [{ value: "model-a", name: "Model A" }],
    },
  ],
});
NodeReadline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  if (pending.has(request.id)) {
    pending.get(request.id)(request.result);
    pending.delete(request.id);
    return;
  }
  const p = request.params;
  switch (request.method) {
    case "initialize":
      result(request.id, {
        protocolVersion: 1,
        agentInfo: { name: "Command Code mock", version: "1.0.0" },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      });
      break;
    case "session/new":
      result(request.id, { sessionId, ...setup() });
      break;
    case "session/load":
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Historical reply." },
      });
      result(request.id, setup());
      break;
    case "session/set_mode":
      mode = p.modeId;
      result(request.id, {});
      break;
    case "session/set_model":
      model = p.modelId;
      result(request.id, {});
      break;
    case "session/set_config_option":
      result(request.id, { configOptions: setup().configOptions });
      break;
    case "session/cancel":
      if (waitingPrompt) {
        result(waitingPrompt, { stopReason: "cancelled" });
        waitingPrompt = undefined;
      }
      break;
    case "session/prompt": {
      const prompt = p.prompt
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
      const text = /<user_request>\s*([\s\S]*?)\s*<\/user_request>/.exec(prompt)?.[1] ?? prompt;
      if (text === "hang") {
        waitingPrompt = request.id;
        update({
          sessionUpdate: "tool_call",
          toolCallId: "waiting",
          title: "Waiting for cancellation",
          kind: "other",
          status: "in_progress",
        });
        break;
      }
      if (text === "auth-error") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: "Authentication expired" },
        });
        break;
      }
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Before tool." },
      });
      update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking." },
      });
      update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Write file",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: "fixture.txt" }],
        rawInput: { mode, model, text },
      });
      if (text === "permission") {
        await new Promise((resolve) => {
          pending.set(9001, resolve);
          send({
            jsonrpc: "2.0",
            id: 9001,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: { toolCallId: "tool-1", title: "Write file", kind: "edit" },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          });
        });
      }
      let selectedOption;
      if (text === "question") {
        const response = await new Promise((resolve) => {
          pending.set(9002, resolve);
          send({
            jsonrpc: "2.0",
            id: 9002,
            method: "session/request_permission",
            params: {
              sessionId,
              toolCall: {
                toolCallId: "question-1",
                title: "Choose a crop",
                kind: "other",
                rawInput: { question: "Choose a crop", options: ["Carrot", "Turnip"] },
              },
              options: [
                { optionId: "option_0", name: "Carrot", kind: "allow_once" },
                { optionId: "option_1", name: "Turnip", kind: "allow_once" },
              ],
            },
          });
        });
        selectedOption = response.outcome.optionId;
      }
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { mode, model, text, selectedOption },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Final answer." },
      });
      result(request.id, { stopReason: "end_turn" });
      break;
    }
    default:
      if (request.id !== undefined)
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        });
  }
});
