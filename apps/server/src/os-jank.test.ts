import { describe, expect, it, vi } from "vitest";

import { fixPath } from "./os-jank.ts";

describe("fixPath", () => {
  it("hydrates PATH on Android using the Termux shell", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/data/data/com.termux/files/usr/bin/sh",
      PATH: "/data/data/com.termux/files/usr/bin",
    };
    const readPath = vi.fn(() => "/data/data/com.termux/files/usr/bin:/system/bin");

    fixPath({
      env,
      platform: "android",
      readPath,
    });

    expect(readPath).toHaveBeenCalledWith("/data/data/com.termux/files/usr/bin/sh");
    expect(env.PATH).toBe("/data/data/com.termux/files/usr/bin:/system/bin");
  });
});
