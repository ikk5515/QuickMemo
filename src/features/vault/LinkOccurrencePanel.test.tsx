import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ResolvedLinkOccurrence,
  UnlinkedMentionOccurrence,
  VaultIndexEntry
} from "../knowledge/types";
import { LinkOccurrencePanel, MAX_RENDERED_LINK_OCCURRENCES } from "./LinkOccurrencePanel";

function entry(id: string, path: string, updatedAt = 0): VaultIndexEntry {
  return { id, kind: "markdown", path, updatedAt };
}

function link(overrides: Partial<ResolvedLinkOccurrence> = {}): ResolvedLinkOccurrence {
  return {
    candidateEntryIds: ["target"],
    column: 3,
    context: "[[Target]]를 연결한 문맥",
    embedded: false,
    line: 4,
    raw: "[[Target]]",
    sourceEntryId: "source",
    sourcePath: "Sources/Source.md",
    status: "resolved",
    syntax: "wikilink",
    target: "Target",
    targetEntryId: "target",
    targetPath: "Targets/Target.md",
    unresolvedKey: "Target",
    ...overrides
  };
}

function mention(overrides: Partial<UnlinkedMentionOccurrence> = {}): UnlinkedMentionOccurrence {
  return {
    column: 8,
    context: "Target을 평문으로 언급한 문맥",
    endOffset: 13,
    line: 6,
    matchedTerm: "Target",
    matchedText: "Target",
    sourceEntryId: "source-a",
    sourcePath: "Sources/Alpha.md",
    startOffset: 7,
    targetEntryId: "target",
    targetPath: "Targets/Target.md",
    ...overrides
  };
}

describe("LinkOccurrencePanel", () => {
  it("keeps parsed backlinks separate from searchable unlinked-mention occurrences", async () => {
    const onCreateUnlinkedLink = vi.fn();
    render(
      <LinkOccurrencePanel
        direction="backlinks"
        emptyLabel="백링크가 없습니다."
        entries={[
          entry("source-a", "Sources/Alpha.md"),
          entry("source-b", "Sources/Beta.md"),
          entry("target", "Targets/Target.md")
        ]}
        occurrences={[
          link({ context: "첫 번째 실제 링크", sourceEntryId: "source-a", sourcePath: "Sources/Alpha.md" }),
          link({ context: "두 번째 실제 링크", line: 8, sourceEntryId: "source-b", sourcePath: "Sources/Beta.md" })
        ]}
        unlinkedMentions={[mention()]}
        onCreateUnlinkedLink={onCreateUnlinkedLink}
        onOpenEntry={() => undefined}
      />
    );

    expect(screen.getByRole("region", { name: "백링크 실제 링크" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "연결되지 않은 언급" })).toHaveTextContent("1개");
    expect(screen.getByText("Target을 평문으로 언급한 문맥")).toBeInTheDocument();
    expect(screen.getByText("첫 번째 실제 링크")).toBeInTheDocument();
    expect(screen.getByText("두 번째 실제 링크")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "링크 문맥 검색" }), { target: { value: "두 번째" } });
    await waitFor(() => expect(screen.queryByText("첫 번째 실제 링크")).not.toBeInTheDocument());
    expect(screen.getByText("두 번째 실제 링크")).toBeInTheDocument();
    expect(screen.queryByText("Target을 평문으로 언급한 문맥")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "링크 문맥 검색" }), { target: { value: "Target" } });
    await waitFor(() => expect(screen.getByText("Target을 평문으로 언급한 문맥")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Alpha 6행 8열 링크 만들기" }));
    expect(onCreateUnlinkedLink).toHaveBeenCalledWith(expect.objectContaining({ startOffset: 7 }));
  });

  it("offers explicit occurrence, name, path, and update sorting", () => {
    render(
      <LinkOccurrencePanel
        direction="outgoing"
        emptyLabel="나가는 링크가 없습니다."
        entries={[
          entry("source", "Source.md"),
          entry("beta", "Z/Beta.md", 20),
          entry("alpha", "A/Alpha.md", 10)
        ]}
        occurrences={[
          link({ target: "Beta", targetEntryId: "beta", targetPath: "Z/Beta.md" }),
          link({ line: 9, target: "Alpha", targetEntryId: "alpha", targetPath: "A/Alpha.md" })
        ]}
        onOpenEntry={() => undefined}
      />
    );

    const sort = screen.getByRole("combobox", { name: "링크 정렬" });
    expect(sort).toHaveTextContent("링크 발생 순서");
    expect(sort).toHaveTextContent("파일 이름");
    expect(sort).toHaveTextContent("파일 경로");
    expect(sort).toHaveTextContent("최근 업데이트");

    fireEvent.change(sort, { target: { value: "file-name" } });
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Alpha", "Beta"]);

    fireEvent.change(sort, { target: { value: "updated" } });
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Beta", "Alpha"]);
  });

  it("collapses one source group or every visible group and expands them accessibly", () => {
    render(
      <LinkOccurrencePanel
        direction="backlinks"
        emptyLabel="백링크가 없습니다."
        entries={[entry("source-a", "Alpha.md"), entry("source-b", "Beta.md"), entry("target", "Target.md")]}
        occurrences={[
          link({ context: "Alpha 문맥", sourceEntryId: "source-a", sourcePath: "Alpha.md" }),
          link({ context: "Beta 문맥", sourceEntryId: "source-b", sourcePath: "Beta.md" })
        ]}
        onOpenEntry={() => undefined}
      />
    );

    const alphaToggle = screen.getByRole("button", { name: "Alpha 링크 그룹 접기" });
    expect(alphaToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(alphaToggle);
    expect(screen.queryByRole("button", { name: "Alpha 4행 3열 실제 링크 열기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta 4행 3열 실제 링크 열기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "모든 링크 그룹 접기" }));
    expect(screen.queryByRole("button", { name: "Beta 4행 3열 실제 링크 열기" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "모든 링크 그룹 펼치기" }));
    expect(screen.getByRole("button", { name: "Alpha 4행 3열 실제 링크 열기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta 4행 3열 실제 링크 열기" })).toBeInTheDocument();
  });

  it("opens the source for backlinks and the resolved target for outgoing links", () => {
    const onOpenEntry = vi.fn();
    const commonEntries = [entry("source", "Source.md"), entry("target", "Target.md")];
    const rendered = render(
      <LinkOccurrencePanel
        direction="backlinks"
        emptyLabel="없음"
        entries={commonEntries}
        occurrences={[link()]}
        onOpenEntry={onOpenEntry}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Source 4행 3열 실제 링크 열기" }));
    expect(onOpenEntry).toHaveBeenLastCalledWith("source");

    rendered.rerender(
      <LinkOccurrencePanel
        direction="outgoing"
        emptyLabel="없음"
        entries={commonEntries}
        occurrences={[link()]}
        onOpenEntry={onOpenEntry}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Target 4행 3열 실제 링크 열기" }));
    expect(onOpenEntry).toHaveBeenLastCalledWith("target");
  });

  it("caps rendered occurrence rows at 500 after filtering and reports the full match count", () => {
    const occurrences = Array.from({ length: MAX_RENDERED_LINK_OCCURRENCES + 1 }, (_, index) => link({
      column: 1,
      context: `문맥 ${index + 1}`,
      line: index + 1
    }));
    render(
      <LinkOccurrencePanel
        direction="outgoing"
        emptyLabel="없음"
        entries={[entry("source", "Source.md"), entry("target", "Target.md")]}
        occurrences={occurrences}
        onOpenEntry={() => undefined}
      />
    );

    expect(screen.getAllByRole("button", { name: /\uc2e4\uc81c \ub9c1\ud06c \uc5f4\uae30$/u })).toHaveLength(MAX_RENDERED_LINK_OCCURRENCES);
    expect(screen.getByText("실제 내부 링크 500개 표시 · 전체 501개")).toBeInTheDocument();
    expect(screen.queryByText("문맥 501")).not.toBeInTheDocument();
  });
});
