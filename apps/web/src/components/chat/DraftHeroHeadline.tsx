import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { CloudIcon, FolderPlusIcon, MonitorIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useStartProjectlessThread } from "~/hooks/useStartProjectlessThread";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { isProjectlessProject } from "~/lib/projectless";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const handleNewThread = useNewThreadHandler();
  const startProjectlessThread = useStartProjectlessThread();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const visibleProjectGroups = useMemo(
    () =>
      projectGroups.filter(
        (group) => !group.memberProjects.every((project) => isProjectlessProject(project)),
      ),
    [projectGroups],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: visibleProjectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, visibleProjectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const projectless = activeProject !== null && isProjectlessProject(activeProject);
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label={hasResolvedProject ? "Change project" : "Choose a project"}
              className="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {activeProjectDisplayName ?? "Choose a project"}
        </TooltipTrigger>
        {activeProjectDisplayName ? (
          <TooltipPopup side="top" className="max-w-80">
            {activeProjectDisplayName}
          </TooltipPopup>
        ) : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 min-w-40! w-max max-w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            const entry = projectEntryByKey.get(value as string);
            if (!entry || value === activeProjectKey) {
              return;
            }
            const project = entry.targetProject;
            if (!draftId) {
              return;
            }
            // Project selection changes the target of the open draft in
            // place. The prompt stays in the same composer session, so the
            // sidebar only gets a draft row if the user later navigates away.
            const currentDraft = getComposerDraft(draftId);
            setLogicalProjectDraftThreadId(
              entry.group.projectKey,
              scopeProjectRef(project.environmentId, project.id),
              draftId,
            );
            if (!hasExplicitComposerModelSelection(currentDraft)) {
              applyStickyState(draftId);
              if (project.defaultModelSelection) {
                setModelSelection(draftId, project.defaultModelSelection, {
                  replaceOptions: true,
                });
              }
            }
          }}
        >
          {projectPickerEntries.map(({ group }) => {
            return (
              <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
                <Tooltip>
                  <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                    {group.displayName}
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-80">
                    {group.displayName}
                  </TooltipPopup>
                </Tooltip>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  const environmentOptions = useMemo(() => {
    if (projectless) {
      return environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => ({
          environmentId: environment.environmentId,
          projectId: null,
          label: environment.label,
          isPrimary: environment.environmentId === primaryEnvironmentId,
        }));
    }

    if (!activeProjectGroup) return [];
    const seen = new Set<string>();
    return activeProjectGroup.memberProjects.flatMap((project) => {
      if (seen.has(project.environmentId)) return [];
      seen.add(project.environmentId);
      return [
        {
          environmentId: project.environmentId,
          projectId: project.id,
          label: environmentLabelById.get(project.environmentId) ?? project.environmentId,
          isPrimary: project.environmentId === primaryEnvironmentId,
        },
      ];
    });
  }, [activeProjectGroup, environmentLabelById, environments, primaryEnvironmentId, projectless]);
  const activeEnvironmentId = activeProjectRef?.environmentId ?? null;
  const activeEnvironment =
    environmentOptions.find((environment) => environment.environmentId === activeEnvironmentId) ??
    null;
  const environmentLabel = activeEnvironment?.label ?? "this machine";

  const changeEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const environment = environmentOptions.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!environment || environment.environmentId === activeEnvironmentId) return;
      try {
        if (projectless) {
          await startProjectlessThread(environment.environmentId, { replace: true });
          return;
        }
        if (environment.projectId) {
          await handleNewThread(scopeProjectRef(environment.environmentId, environment.projectId), {
            replace: true,
          });
        }
      } catch (cause) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change machine",
            description: cause instanceof Error ? cause.message : "An unexpected error occurred.",
          }),
        );
      }
    },
    [activeEnvironmentId, environmentOptions, handleNewThread, projectless, startProjectlessThread],
  );

  const environmentSelector =
    environmentOptions.length > 1 ? (
      <Menu>
        <MenuTrigger
          aria-label="Choose which machine runs this thread"
          className="pointer-events-auto inline-flex max-w-64 items-center gap-1.5 border-foreground/60 border-b border-dotted align-bottom text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          title={environmentLabel}
        >
          {activeEnvironment?.isPrimary ? (
            <MonitorIcon className="size-[0.8em]" />
          ) : (
            <CloudIcon className="size-[0.8em]" />
          )}
          <span className="truncate">{environmentLabel}</span>
        </MenuTrigger>
        <MenuPopup align="center" className="max-h-80 min-w-48 overflow-y-auto">
          <MenuRadioGroup
            value={activeEnvironmentId ?? ""}
            onValueChange={(value) => void changeEnvironment(value as EnvironmentId)}
          >
            {environmentOptions.map((environment) => {
              const Icon = environment.isPrimary ? MonitorIcon : CloudIcon;
              return (
                <MenuRadioItem
                  key={environment.environmentId}
                  value={environment.environmentId}
                  closeOnClick
                >
                  <Icon className="size-3.5" />
                  <span className="min-w-0 truncate">{environment.label}</span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    ) : (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex max-w-64 items-center gap-1.5 border-muted-foreground/35 border-b border-dotted align-bottom text-muted-foreground/80" />
          }
        >
          {activeEnvironment?.isPrimary ? (
            <MonitorIcon className="size-[0.8em]" />
          ) : (
            <CloudIcon className="size-[0.8em]" />
          )}
          <span className="truncate">{environmentLabel}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">Runs on {environmentLabel}</TooltipPopup>
      </Tooltip>
    );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {projectless ? (
        <>What can I help with on {environmentSelector}?</>
      ) : hasResolvedProject ? (
        <>
          What should we build in {projectSelector} on {environmentSelector}?
        </>
      ) : canChooseProject ? (
        <>{projectSelector} to start</>
      ) : (
        <>Add a project to start</>
      )}
    </h1>
  );
}
