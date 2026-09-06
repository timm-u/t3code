import { useId, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";

/** Keep live narration readable without giving an unfinished report answer typography. */
export function AssistantProgress({
  text,
  active,
  revealKey,
  children,
}: {
  text: string;
  active: boolean;
  revealKey?: string;
  children: ReactNode;
}) {
  const [disclosure, setDisclosure] = useState({ expanded: Boolean(revealKey), revealKey });
  const expanded = disclosure.expanded;
  const contentId = useId();
  // A citation navigation must reveal its source even inside long working notes.
  if (revealKey && revealKey !== disclosure.revealKey) {
    setDisclosure({ expanded: true, revealKey });
  }
  const isReport =
    text.length > 600 ||
    /(^|\n)(#{1,6}\s|```|\|.+\|)/.test(text.slice(0, 600)) ||
    text.split("\n", 8).length > 6;

  if (!isReport) {
    return (
      <div className="text-foreground/80 [&_p]:text-[13px] [&_p]:leading-relaxed [&_strong]:font-medium">
        {children}
      </div>
    );
  }

  const firstParagraph =
    text
      .trimStart()
      .slice(0, 221)
      .split(/\n\s*\n/, 1)[0] ?? "";
  const preview = firstParagraph.slice(0, 220).replace(/\s+/g, " ").trim();
  return (
    <div className="border-l border-border pl-3">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setDisclosure((value) => ({ ...value, expanded: !value.expanded }))}
        className="flex cursor-pointer items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={expanded ? "size-3.5 rotate-90" : "size-3.5"}
        />
        <span>Working notes</span>
        {active ? <span className="ml-1">Still in progress</span> : null}
      </button>
      <div id={contentId} className="mt-1.5">
        {expanded ? (
          <div className="text-foreground/80 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_p]:text-[13px] [&_li]:text-[13px]">
            {children}
          </div>
        ) : (
          <p className="line-clamp-2 break-words text-[13px] leading-relaxed text-muted-foreground">
            {preview}
            {firstParagraph.length > 220 ? "…" : ""}
          </p>
        )}
      </div>
    </div>
  );
}
