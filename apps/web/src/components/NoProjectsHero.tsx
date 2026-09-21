import { PlusIcon, MessageSquareIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

export function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const openNewThread = useCallback(() => openCommandPalette({ open: "new-thread-in" }), []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Start with a project, or open a projectless scratch thread.
              </EmptyDescription>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
                <Button size="sm" variant="outline" onClick={openNewThread}>
                  <MessageSquareIcon className="size-4" />
                  No project
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
