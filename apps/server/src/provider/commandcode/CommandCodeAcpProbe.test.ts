import { describe, expect, it } from "@effect/vitest";
import type { AcpSessionRuntimeStartResult } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { commandCodeAcpModels } from "./CommandCodeAcpProbe.ts";

const start = (
  sessionSetupResult: AcpSessionRuntimeStartResult["sessionSetupResult"],
): AcpSessionRuntimeStartResult => ({
  sessionId: "discovery",
  modelConfigId: "model",
  initializeResult: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
  sessionSetupResult,
});

describe("Command Code ACP model discovery", () => {
  it("uses native grouped model choices, default selection, and effort controls", () => {
    const result = commandCodeAcpModels(
      start({
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "model-b",
            options: [
              {
                groupId: "provider",
                name: "Provider",
                options: [
                  { value: "model-a", name: "Model A" },
                  { value: "model-b", name: "Model B" },
                ],
              },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ],
      }),
    );
    expect(result.models.map((model) => [model.slug, model.name, model.isDefault])).toEqual([
      ["model-a", "Model A", false],
      ["model-b", "Model B", true],
    ]);
    expect(result.capabilities.optionDescriptors?.some((option) => option.id === "effort")).toBe(
      true,
    );
  });

  it("accepts the legacy ACP models field when there is no config picker", () => {
    const result = commandCodeAcpModels(
      start({
        models: {
          currentModelId: "native",
          availableModels: [{ modelId: "native", name: "Native model" }],
        },
      }),
    );
    expect(result.models).toMatchObject([
      { slug: "native", name: "Native model", isDefault: true },
    ]);
  });
});
