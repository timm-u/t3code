import type { OrchestrationProject } from "@t3tools/contracts";

export const PROJECTLESS_PROJECT_TITLE = "No project";
export const PROJECTLESS_WORKSPACE_ROOT = "~/.t3/projectless";

export function isProjectlessProject(
  project: Pick<OrchestrationProject, "title" | "workspaceRoot">,
): boolean {
  const normalizedWorkspaceRoot = project.workspaceRoot
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();

  return (
    project.title === PROJECTLESS_PROJECT_TITLE &&
    (normalizedWorkspaceRoot === PROJECTLESS_WORKSPACE_ROOT ||
      normalizedWorkspaceRoot.endsWith("/.t3/projectless"))
  );
}
