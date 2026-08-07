import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback } from "react";

import {
  isProjectlessProject,
  PROJECTLESS_PROJECT_TITLE,
  PROJECTLESS_WORKSPACE_ROOT,
} from "~/lib/projectless";
import { newProjectId } from "~/lib/utils";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { useNewThreadHandler } from "./useHandleNewThread";

export function useStartProjectlessThread() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  return useCallback(
    async (environmentId: EnvironmentId, options?: { readonly replace?: boolean }) => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!environment || !canCreateProjectInEnvironment(environment.connection.phase)) {
        throw new Error(`${environment?.label ?? "The selected environment"} is not connected.`);
      }

      const existingProject = projects.find(
        (project) => project.environmentId === environmentId && isProjectlessProject(project),
      );
      if (existingProject) {
        await handleNewThread(scopeProjectRef(environmentId, existingProject.id), options);
        return;
      }

      const projectId = newProjectId();
      const providers =
        environment.serverConfig?.providers ??
        (environmentId === primaryEnvironmentId ? primaryProviders : []);
      const result = await createProject({
        environmentId,
        input: {
          projectId,
          title: PROJECTLESS_PROJECT_TITLE,
          workspaceRoot: PROJECTLESS_WORKSPACE_ROOT,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: resolveDefaultProviderModelSelection(providers, null),
        },
      });

      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        throw cause instanceof Error ? cause : new Error("Could not create the scratch workspace.");
      }

      await handleNewThread(scopeProjectRef(environmentId, projectId), options);
    },
    [
      createProject,
      environments,
      handleNewThread,
      primaryEnvironmentId,
      primaryProviders,
      projects,
    ],
  );
}
