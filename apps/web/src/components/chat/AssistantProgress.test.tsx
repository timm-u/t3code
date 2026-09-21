import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";
import { AssistantProgress } from "./AssistantProgress";

describe("AssistantProgress", () => {
  it("shows short updates directly and preserves an expanded report as more text arrives", async () => {
    let renderer!: ReactTestRenderer;
    const render = (text: string) => (
      <AssistantProgress text={text} active>
        <article>{text}</article>
      </AssistantProgress>
    );
    await act(async () => {
      renderer = create(render("Verified X. Continuing with Y."));
    });
    expect(renderer.root.findByType("article").children.join("")).toBe(
      "Verified X. Continuing with Y.",
    );
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    const report = "## Prior blockers\n\n" + "Detailed finding. ".repeat(60);
    await act(async () => {
      renderer.update(render(report));
    });
    expect(renderer.root.findAllByType("article")).toHaveLength(0);
    expect(renderer.root.findAllByType("p")).toHaveLength(0);
    expect(renderer.root.findByType("button").findByType("span").children).toEqual([
      "Writing response",
    ]);
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });
    expect(renderer.root.findByType("article").children.join("")).toBe(report);
    await act(async () => {
      renderer.update(render(report + "Still checking."));
    });
    expect(renderer.root.findByType("article").children.join("")).toContain("Still checking.");
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });
    expect(renderer.root.findAllByType("article")).toHaveLength(0);
    await act(async () => {
      renderer.update(
        <AssistantProgress text={report} active={false} revealKey="citation-1">
          <article>{report}</article>
        </AssistantProgress>,
      );
    });
    expect(renderer.root.findByType("button").findByType("span").children).toEqual([
      "Response preview",
    ]);
    expect(renderer.root.findByType("article").children.join("")).toBe(report);
    await act(async () => {
      renderer.unmount();
    });
  });
});
