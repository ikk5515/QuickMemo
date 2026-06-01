import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultMatrixLabels } from "../lib/matrixLabels";
import type { MatrixLabels, UserPreferencesDocument } from "../types";
import { SettingsModal } from "./AppShell";

function preferences(matrixLabels: MatrixLabels = defaultMatrixLabels): UserPreferencesDocument {
  return {
    uid: "user-a",
    defaultHome: "notes",
    matrixLabels,
    scheduleDefaultView: "todo"
  };
}

describe("SettingsModal", () => {
  it("saves trimmed per-user matrix labels without changing preference keys", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsModal
        preferences={preferences()}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    const saveButton = screen.getByRole("button", { name: "저장" });
    const urgentLabelInput = screen.getByLabelText(/^긴급 업무/) as HTMLInputElement;

    expect(screen.getByRole("heading", { name: "매트릭스 명칭 설정" })).toBeInTheDocument();
    expect(saveButton).toBeDisabled();

    await user.clear(urgentLabelInput);
    await user.type(urgentLabelInput, "  위임 업무  ");
    await user.tab();
    await user.click(saveButton);

    expect(urgentLabelInput.value).toBe("위임 업무");
    expect(onSave).toHaveBeenCalledWith({
      defaultHome: "notes",
      matrixLabels: {
        ...defaultMatrixLabels,
        urgent: "위임 업무"
      },
      scheduleDefaultView: "todo"
    });
  });

  it("blocks empty matrix labels before saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsModal
        preferences={preferences()}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    await user.clear(screen.getByLabelText(/^중요 업무/));
    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(screen.getByText("중요 업무 명칭을 입력해 주세요.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("resets matrix labels to defaults for the next save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsModal
        preferences={preferences({
          importantUrgent: "바로 처리",
          urgent: "위임 업무",
          important: "집중 업무",
          waiting: "대기 목록"
        })}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    await user.click(screen.getByRole("button", { name: "기본값으로 초기화" }));
    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(onSave).toHaveBeenCalledWith({
      defaultHome: "notes",
      matrixLabels: defaultMatrixLabels,
      scheduleDefaultView: "todo"
    });
  });
});
