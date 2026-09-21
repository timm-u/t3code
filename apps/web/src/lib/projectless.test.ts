import { describe, expect, it } from "vite-plus/test";

import { isProjectlessProject } from "./projectless";

describe("isProjectlessProject", () => {
  it.each([
    "~/.t3/projectless",
    "/Users/test/.t3/projectless/",
    "C:\\Users\\test\\.t3\\projectless",
  ])("recognizes the managed scratch workspace %s", (workspaceRoot) => {
    expect(isProjectlessProject({ title: "No project", workspaceRoot })).toBe(true);
  });

  it("does not hide a user project that merely has the same title", () => {
    expect(isProjectlessProject({ title: "No project", workspaceRoot: "/repos/no-project" })).toBe(
      false,
    );
  });
});
