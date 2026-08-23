import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KanbanBoard,
  kanbanEmptyColumnDropId,
  moveKanbanColumn,
  moveKanbanCardForDrop
} from "./KanbanBoard";
import { MAX_KANBAN_PARSE_DIAGNOSTICS, createKanbanSource, parseKanbanSource } from "./model";

const downloadBlobMock = vi.hoisted(() => vi.fn());

vi.mock("../vault/browserDownload", () => ({
  downloadBlob: downloadBlobMock
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  downloadBlobMock.mockReset();
});

describe("KanbanBoard", () => {
  it("moves a card into an empty column through the dedicated safe drop target", () => {
    const parsed = parseKanbanSource(
      createKanbanSource().replace("## 할 일\n", "## 할 일\n- [ ] 초안\n")
    );
    const document = parsed.document!;
    const result = moveKanbanCardForDrop(
      document,
      document.columns[0].cards[0].id,
      kanbanEmptyColumnDropId(document.columns[1].id)
    );

    expect(result?.targetColumnIndex).toBe(1);
    expect(result?.document.columns[0].cards).toHaveLength(0);
    expect(result?.document.columns[1].cards).toEqual([
      expect.objectContaining({ text: "초안" })
    ]);
    expect(document.columns[0].cards).toHaveLength(1);
  });

  it("rejects a stale empty-column target after that column receives a card", () => {
    const parsed = parseKanbanSource(
      createKanbanSource()
        .replace("## 할 일\n", "## 할 일\n- [ ] 초안\n")
        .replace("## 진행 중\n", "## 진행 중\n- [ ] 기존 카드\n")
    );
    const document = parsed.document!;

    expect(moveKanbanCardForDrop(
      document,
      document.columns[0].cards[0].id,
      kanbanEmptyColumnDropId(document.columns[1].id)
    )).toBeNull();
  });

  it("renders named empty-column drop targets and keeps a keyboard move fallback", () => {
    const onChange = vi.fn();
    const source = createKanbanSource().replace("## 할 일\n", "## 할 일\n- [ ] 초안\n");
    render(<KanbanBoard onChange={onChange} source={source} />);

    const emptyTarget = screen.getByRole("group", { name: "진행 중 빈 열 카드 놓기 영역" });
    expect(emptyTarget).toHaveTextContent("카드를 여기로 끌어오세요");
    expect(emptyTarget).toHaveTextContent("키보드에서는 카드의 열 이동 메뉴를 사용하세요.");

    fireEvent.change(screen.getByRole("combobox", { name: "카드 열 이동" }), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(parseKanbanSource(onChange.mock.calls[0][0]).document?.columns[1].cards[0].text).toBe("초안");
    expect(screen.getByText("카드를 진행 중 열로 옮겼습니다.")).toBeInTheDocument();
  });

  it("edits a card while keeping Markdown as the source of truth", () => {
    const onChange = vi.fn();
    const source = createKanbanSource().replace("## 할 일\n", "## 할 일\n- [ ] 초안\n");
    render(<KanbanBoard onChange={onChange} source={source} />);
    const input = screen.getByRole("textbox", { name: "카드 내용" });
    fireEvent.change(input, { target: { value: "검토" } });
    fireEvent.blur(input);
    const emitted = onChange.mock.calls[0]?.[0] as string;
    expect(parseKanbanSource(emitted).document?.columns[0].cards[0].text).toBe("검토");
    expect(emitted).toContain("- [ ] 검토");
  });

  it("keeps every card on one checkbox line", () => {
    const onChange = vi.fn();
    const source = createKanbanSource().replace("## 할 일\n", "## 할 일\n- [ ] 첫 줄\n");
    render(<KanbanBoard onChange={onChange} source={source} />);

    const input = screen.getByRole("textbox", { name: "카드 내용" });
    fireEvent.change(input, { target: { value: "첫 줄\n둘째 줄" } });
    fireEvent.blur(input);

    const emitted = onChange.mock.calls[0]?.[0] as string;
    const cardText = parseKanbanSource(emitted).document?.columns[0].cards[0].text;
    expect(cardText).toContain("첫 줄");
    expect(cardText).toContain("둘째 줄");
    expect(cardText).not.toMatch(/[\r\n]/u);
  });

  it("opens only safe wikilinks through accessible controls without duplicating card Markdown", () => {
    const onChange = vi.fn();
    const onOpenLink = vi.fn();
    const card = "[[Roadmap|로드맵]] 확인 [[javascript:alert(1)|위험]] [[https%3A%2F%2Fexample.com|인코딩 URL]] [외부](https://example.com)";
    const source = createKanbanSource().replace("## 할 일\n", `## 할 일\n- [ ] ${card}\n`);
    render(<KanbanBoard onChange={onChange} onOpenLink={onOpenLink} source={source} />);

    const links = screen.getByRole("group", { name: "카드 내부 링크" });
    fireEvent.click(screen.getByRole("button", { name: "로드맵 노트 열기" }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(onOpenLink).toHaveBeenCalledTimes(1);
    expect(onOpenLink).toHaveBeenCalledWith("Roadmap");
    expect(links).toHaveTextContent("로드맵");
    expect(screen.queryByRole("button", { name: "위험 노트 열기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "인코딩 URL 노트 열기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "외부 노트 열기" })).not.toBeInTheDocument();
    const emitted = onChange.mock.calls[0]?.[0] as string;
    expect(emitted.match(/\[\[Roadmap\|로드맵\]\]/gu)).toHaveLength(1);
  });

  it("shows unsupported Markdown as read-only", () => {
    const source = createKanbanSource().replace("## 할 일\n", "## 할 일\n> 보존할 블록\n");
    render(<KanbanBoard onChange={vi.fn()} source={source} />);
    expect(screen.getByText(/읽기 전용/)).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")[0]).toBeDisabled();
  });

  it("never renders an unbounded malformed-board error list", () => {
    const source = `---\nquickmemo-plugin: kanban-v1\n---\n${"x\n".repeat(1_000)}`;
    render(<KanbanBoard onChange={vi.fn()} source={source} />);

    const alert = screen.getByRole("alert");
    expect(alert.querySelectorAll("li")).toHaveLength(MAX_KANBAN_PARSE_DIAGNOSTICS);
    expect(alert).toHaveTextContent(/추가 진단 .*개/u);
  });

  it("reorders lanes without mutating the parsed Markdown model", () => {
    const document = parseKanbanSource(createKanbanSource()).document!;
    const moved = moveKanbanColumn(document, 0, 1);
    expect(moved?.columns.map((column) => column.title)).toEqual(["진행 중", "할 일", "완료"]);
    expect(document.columns.map((column) => column.title)).toEqual(["할 일", "진행 중", "완료"]);
  });

  it("edits and persists a nested card checklist", () => {
    const onChange = vi.fn();
    const source = createKanbanSource().replace(
      "## 할 일\n",
      "## 할 일\n- [ ] 릴리스\n  - [ ] 모바일 점검\n"
    );
    render(<KanbanBoard onChange={onChange} source={source} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "모바일 점검 완료" }));
    const emitted = onChange.mock.calls[0]?.[0] as string;
    expect(emitted).toContain("  - [x] 모바일 점검");
    expect(parseKanbanSource(emitted).document?.columns[0].cards[0].checklist?.[0].checked).toBe(true);
  });

  it("offers accessible lane reorder controls", () => {
    const onChange = vi.fn();
    render(<KanbanBoard onChange={onChange} source={createKanbanSource()} />);

    expect(screen.getByRole("button", { name: "할 일 열 왼쪽으로 이동" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "할 일 열 오른쪽으로 이동" }));
    expect(parseKanbanSource(onChange.mock.calls[0][0]).document?.columns.map((column) => column.title))
      .toEqual(["진행 중", "할 일", "완료"]);
  });

  it("requires compatibility inspection and explicit replacement consent before import", () => {
    const onChange = vi.fn();
    render(<KanbanBoard onChange={onChange} source={createKanbanSource("기존 보드")} />);
    fireEvent.click(screen.getByRole("button", { name: "Obsidian 가져오기·내보내기" }));
    const imported = `---
kanban-plugin: basic
---
# 가져온 보드

## 대기
- [ ] 확인
`;
    fireEvent.change(screen.getByRole("textbox", { name: "가져올 Markdown" }), { target: { value: imported } });
    fireEvent.click(screen.getByRole("button", { name: "호환성 검사" }));

    expect(onChange).not.toHaveBeenCalled();
    const apply = screen.getByRole("button", { name: "확인 후 가져오기 적용" });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /현재 보드 본문을 검사한 내용으로 교체/u }));
    fireEvent.click(apply);

    expect(onChange).toHaveBeenCalledTimes(1);
    const parsed = parseKanbanSource(onChange.mock.calls[0][0]);
    expect(parsed.document?.title).toBe("가져온 보드");
    expect(parsed.document?.columns[0].cards[0].text).toBe("확인");
  });

  it("keeps the current board unchanged for incompatible or stale import inspections", () => {
    const onChange = vi.fn();
    const { rerender } = render(<KanbanBoard onChange={onChange} source={createKanbanSource("기존")} />);
    fireEvent.click(screen.getByRole("button", { name: "Obsidian 가져오기·내보내기" }));
    const input = screen.getByRole("textbox", { name: "가져올 Markdown" });
    fireEvent.change(input, { target: { value: "# Board\n\n## Lane\n> 보존할 callout\n" } });
    fireEvent.click(screen.getByRole("button", { name: "호환성 검사" }));
    expect(screen.getByText("호환 불가 · 현재 보드 변경 없음")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "# Board\n\n## Lane\n- [ ] 카드\n" } });
    fireEvent.click(screen.getByRole("button", { name: "호환성 검사" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /현재 보드 본문을 검사한 내용으로 교체/u }));
    rerender(<KanbanBoard onChange={onChange} source={createKanbanSource("외부 변경")} />);
    fireEvent.click(screen.getByRole("button", { name: "확인 후 가져오기 적용" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("검사 후 현재 보드가 변경되었습니다. 다시 호환성을 검사해주세요.")).toBeInTheDocument();
  });

  it("always exposes a bounded export textarea when clipboard is unavailable", async () => {
    const onChange = vi.fn();
    render(<KanbanBoard onChange={onChange} source={createKanbanSource("내보내기")} />);
    fireEvent.click(screen.getByRole("button", { name: "Obsidian 가져오기·내보내기" }));
    fireEvent.click(screen.getByRole("button", { name: "복사 및 원문 준비" }));

    const output = await screen.findByRole("textbox", { name: "내보내기 원문" });
    expect(output).toHaveAttribute("readonly");
    expect((output as HTMLTextAreaElement).value).toContain("kanban-plugin: basic");
    expect(screen.getByRole("button", { name: "Markdown 다운로드" })).toBeEnabled();
    await waitFor(() => expect(screen.getByText(/아래 내보내기 원문과 다운로드/u)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Markdown 다운로드" }));
    expect(downloadBlobMock).toHaveBeenCalledWith(expect.any(Blob), "내보내기.md");
    expect((downloadBlobMock.mock.calls[0][0] as Blob).type).toBe("text/markdown;charset=utf-8");
    expect(onChange).not.toHaveBeenCalled();
  });
});
