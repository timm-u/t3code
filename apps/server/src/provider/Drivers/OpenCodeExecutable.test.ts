import { describe, expect, it } from "@effect/vitest";
import { canDiscoverOpenCode2, isOpenCode2Command } from "./OpenCodeExecutable.ts";

describe("OpenCode executable selection", () => {
  it("recognizes native v2 executables and package manager shims", () => {
    for (const path of [
      "opencode2",
      "C:\\Users\\user\\npm\\opencode2.cmd",
      "/home/user/.local/bin/opencode2",
      "C:/apps/opencode2.exe",
    ])
      expect(isOpenCode2Command(path)).toBe(true);
    expect(isOpenCode2Command("opencode")).toBe(false);
  });
  it("allows discovery after removal of a managed v1 installation", () => {
    expect(canDiscoverOpenCode2("opencode")).toBe(true);
    expect(
      canDiscoverOpenCode2(
        "C:\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe",
      ),
    ).toBe(true);
    expect(canDiscoverOpenCode2("/custom/pinned/opencode")).toBe(false);
  });
});
