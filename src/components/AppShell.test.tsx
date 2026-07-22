import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultMatrixLabels } from "../lib/matrixLabels";
import type { MatrixLabels, UserPreferencesDocument } from "../types";
import { SettingsModal, ThemeToggleButton } from "./AppShell";

function preferences(matrixLabels: MatrixLabels = defaultMatrixLabels): UserPreferencesDocument {
  return {
    uid: "user-a",
    defaultHome: "notes",
    matrixLabels,
    scheduleDefaultView: "todo",
    theme: "system"
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
    expect(screen.getAllByRole("textbox")).toHaveLength(5);
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
          todayOverdue: "오늘 처리",
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

  it("offers recurring work as a default schedule tab while excluding completed history", () => {
    render(
      <SettingsModal
        preferences={{ ...preferences(), scheduleDefaultView: "completed" }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const defaultScheduleSelect = screen.getByLabelText("일정관리 기본 화면") as HTMLSelectElement;

    expect(defaultScheduleSelect.value).toBe("todo");
    expect(screen.getByRole("option", { name: "할 일" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "달력" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "매트릭스" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "반복 업무" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "완료" })).not.toBeInTheDocument();
  });

  it("offers the encrypted library as a default start screen", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsModal
        preferences={preferences()}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    await user.selectOptions(screen.getByLabelText("작업 시작 기본 화면"), "library");
    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(screen.getByRole("option", { name: "자료실" })).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith({
      defaultHome: "library",
      matrixLabels: defaultMatrixLabels,
      scheduleDefaultView: "todo"
    });
  });

  it("only offers granted features and hides schedule settings when denied", () => {
    render(
      <SettingsModal
        featureAccess={{ notes: false, library: true, schedule: false }}
        preferences={preferences()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const homeSelect = screen.getByLabelText("작업 시작 기본 화면") as HTMLSelectElement;
    expect(homeSelect.value).toBe("library");
    expect(screen.getByRole("option", { name: "자료실" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "노트" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("일정관리 기본 화면")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "매트릭스 명칭 설정" })).not.toBeInTheDocument();
  });

  it("explains when no workspace feature is available", () => {
    render(
      <SettingsModal
        featureAccess={{ notes: false, library: false, schedule: false }}
        preferences={preferences()}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByText("현재 사용할 수 있는 작업 기능이 없습니다. 관리자에게 권한을 요청해 주세요.")).toBeInTheDocument();
    expect(screen.queryByLabelText("작업 시작 기본 화면")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });
});

describe("ThemeToggleButton", () => {
  it("exposes the next theme action and pressed state", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(<ThemeToggleButton resolvedTheme="light" onToggle={onToggle} />);

    const darkButton = screen.getByRole("button", { name: "다크모드로 전환" });
    expect(darkButton).toHaveAttribute("aria-pressed", "false");

    await user.click(darkButton);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<ThemeToggleButton resolvedTheme="dark" onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "라이트모드로 전환" })).toHaveAttribute("aria-pressed", "true");
  });
});
