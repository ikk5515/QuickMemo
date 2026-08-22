import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplatePickerDialog } from "./TemplatePickerDialog";

afterEach(cleanup);

const candidates = [
  { body: "# A", id: "a", path: "Templates/A.md", title: "A" },
  { body: "# B\n{{path}}\n{{prompt:참석자}}", id: "b", path: "Templates/B.md", title: "B" }
];

describe("TemplatePickerDialog", () => {
  it("focuses search and provides roving listbox keyboard navigation", () => {
    render(<TemplatePickerDialog candidates={candidates} mode="insert" onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("searchbox")).toHaveFocus();
    const options = screen.getAllByRole("option");
    options[0].focus();
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("closes on Escape without executing a template", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<TemplatePickerDialog candidates={candidates} mode="create" onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps create disabled while encrypted name reservations are being re-audited", () => {
    const onConfirm = vi.fn();
    render(
      <TemplatePickerDialog
        candidates={candidates}
        confirmDisabled
        confirmDisabledReason="암호화된 이름 예약 확인 중"
        mode="create"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByRole("button", { name: "만들기" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("암호화된 이름 예약 확인 중");
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("moves selection to the first visible result when filtering hides the old selection", () => {
    const onConfirm = vi.fn();
    render(<TemplatePickerDialog candidates={candidates} mode="insert" onCancel={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "B" } });
    const option = screen.getByRole("option", { name: /B/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(option).toHaveAttribute("tabindex", "0");
    fireEvent.click(screen.getByRole("button", { name: "삽입" }));
    expect(onConfirm.mock.calls[0][0].id).toBe("b");
  });

  it("collects safe prompt input and shows a bounded pre-execution preview", () => {
    const onConfirm = vi.fn();
    render(
      <TemplatePickerDialog
        candidates={candidates.slice(1)}
        currentPath="Meetings/current.md"
        currentTitle="회의록"
        mode="insert"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    fireEvent.change(screen.getByLabelText("참석자"), { target: { value: "김민수" } });
    expect(screen.getByRole("region", { name: "템플릿 미리보기" })).toHaveTextContent("Meetings/current.md");
    expect(screen.getByRole("region", { name: "템플릿 미리보기" })).toHaveTextContent("김민수");
    fireEvent.click(screen.getByRole("button", { name: "삽입" }));
    expect(onConfirm).toHaveBeenCalledWith(candidates[1], "회의록", { "참석자": "김민수" });
  });
});
