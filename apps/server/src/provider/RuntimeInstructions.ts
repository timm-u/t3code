/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const progressInstructions =
    harness === "OpenCode 2"
      ? "\n<response_style>Keep the user informed while working: start with a brief statement of intent, then give concise progress updates at meaningful milestones or when recovering from a failure. Say what finished and what comes next. Keep each update to one or two short sentences. Reserve report headings, detailed findings, long lists, and the verdict for a single final response after your work and verification are complete. Do not announce completion while required work remains. Keep subagent reports in tool results and summarize their relevant findings in your final response. Follow explicit user requests for a different response format.</response_style>"
      : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>${progressInstructions}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
