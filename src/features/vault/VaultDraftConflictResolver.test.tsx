import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VaultDraftConflictResolver } from "./VaultDraftConflictResolver";

const base = "before\nbase\nafter\n";
const local = "before\nlocal\nafter\n";
const remote = "before\nserver\nafter\n";

describe("VaultDraftConflictResolver", () => {
  it("does not apply an unresolved conflict and exposes all four explicit choices", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <VaultDraftConflictResolver
        baseMarkdown={base}
        localMarkdown={local}
        onCancel={vi.fn()}
        onResolve={onResolve}
        remoteMarkdown={remote}
      />
    );

    expect(screen.getByRole("dialog", { name: "편집 충돌 안전 병합" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "내 편집본" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "서버 최신본" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "둘 다 보존" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "직접 편집" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "선택한 병합본 적용" }));
    expect(screen.getByRole("alert")).toHaveTextContent("보존 방법을 선택");
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("applies a selected local or both-preserved merge without exposing scope identifiers", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <VaultDraftConflictResolver
        baseMarkdown={base}
        localMarkdown={local}
        onCancel={vi.fn()}
        onResolve={onResolve}
        remoteMarkdown={remote}
      />
    );

    await user.click(screen.getByRole("radio", { name: "내 편집본" }));
    await user.click(screen.getByRole("button", { name: "선택한 병합본 적용" }));
    expect(onResolve).toHaveBeenLastCalledWith("before\nlocal\nafter\n", {
      automatic: false,
      conflictCount: 1,
      usedManualResolution: false
    });

    const conflict = screen.getAllByRole("group", { name: /충돌/u })[0];
    await user.click(within(conflict).getByRole("radio", { name: "둘 다 보존" }));
    await user.click(screen.getByRole("button", { name: "선택한 병합본 적용" }));
    expect(onResolve.mock.calls.at(-1)?.[0]).toContain("local\nserver\n");
    expect(screen.queryByText(/note-|entry-|revision-/u)).not.toBeInTheDocument();
  });

  it("starts manual editing with both originals and submits only the reviewed text", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <VaultDraftConflictResolver
        baseMarkdown={base}
        localMarkdown={local}
        onCancel={vi.fn()}
        onResolve={onResolve}
        remoteMarkdown={remote}
      />
    );

    await user.click(screen.getByRole("radio", { name: "직접 편집" }));
    const textarea = screen.getByRole("textbox", { name: "직접 편집한 병합 내용" });
    expect(textarea).toHaveValue("local\nserver\n");
    await user.clear(textarea);
    await user.type(textarea, "reviewed\n");
    await user.click(screen.getByRole("button", { name: "선택한 병합본 적용" }));

    expect(onResolve).toHaveBeenCalledWith("before\nreviewed\nafter\n", {
      automatic: false,
      conflictCount: 1,
      usedManualResolution: true
    });
  });

  it("applies a conflict-free automatic merge and labels it separately", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(
      <VaultDraftConflictResolver
        baseMarkdown={"one\ntwo\nthree\n"}
        localMarkdown={"one-local\ntwo\nthree\n"}
        onCancel={vi.fn()}
        onResolve={onResolve}
        remoteMarkdown={"one\ntwo\nthree-server\n"}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("자동 병합");
    await user.click(screen.getByRole("button", { name: "자동 병합본 적용" }));
    expect(onResolve).toHaveBeenCalledWith("one-local\ntwo\nthree-server\n", {
      automatic: true,
      conflictCount: 0,
      usedManualResolution: false
    });
  });

  it("closes with Escape only while no save is active", () => {
    const onCancel = vi.fn();
    const rendered = render(
      <VaultDraftConflictResolver
        baseMarkdown={base}
        localMarkdown={local}
        onCancel={onCancel}
        onResolve={vi.fn()}
        remoteMarkdown={remote}
      />
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <VaultDraftConflictResolver
        baseMarkdown={base}
        busy
        localMarkdown={local}
        onCancel={onCancel}
        onResolve={vi.fn()}
        remoteMarkdown={remote}
      />
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a generic save failure without rendering thrown sensitive text", async () => {
    const user = userEvent.setup();
    render(
      <VaultDraftConflictResolver
        baseMarkdown={base}
        localMarkdown={local}
        onCancel={vi.fn()}
        onResolve={vi.fn(async () => { throw new Error("cipherText=TOP-SECRET note-id-123"); })}
        remoteMarkdown={remote}
      />
    );
    await user.click(screen.getByRole("radio", { name: "서버 최신본" }));
    await user.click(screen.getByRole("button", { name: "선택한 병합본 적용" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("서버 최신 상태를 다시 확인");
    expect(screen.queryByText(/TOP-SECRET|note-id-123|cipherText/u)).not.toBeInTheDocument();
  });

  it("does not duplicate two oversized plaintext versions into the manual editor", async () => {
    const user = userEvent.setup();
    render(
      <VaultDraftConflictResolver
        baseMarkdown="base"
        localMarkdown={"l".repeat(300_000)}
        onCancel={vi.fn()}
        onResolve={vi.fn()}
        remoteMarkdown={"r".repeat(300_000)}
      />
    );

    await user.click(screen.getByRole("radio", { name: "직접 편집" }));
    expect(screen.getByRole("textbox", { name: "직접 편집한 병합 내용" })).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("저장 한도를 넘습니다");
  });
});
