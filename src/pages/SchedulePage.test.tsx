import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SchedulePage from "./SchedulePage";

const testData = vi.hoisted(() => {
  const matrixLabels = {
    important: "중요 업무",
    importantUrgent: "중요·긴급",
    todayOverdue: "오늘/지연",
    urgent: "긴급 업무",
    waiting: "대기 업무"
  };

  return {
    matrixLabels,
    userProfile: {
      allowedShareTargetUids: [],
      avatarText: "김",
      color: "#2f7d70",
      displayName: "김테스트",
      isActive: true,
      isAdmin: false,
      loginEmail: "tester@quickmemo.local",
      order: 1,
      publicKeyJwk: {},
      quickKey: 1,
      role: "user",
      uid: "user-a"
    }
  };
});

vi.mock("../components/AppShell", () => ({
  AppShell: ({ children }: PropsWithChildren) => <div>{children}</div>
}));

vi.mock("../components/UnlockPanel", () => ({
  UnlockPanel: () => <div>잠금 해제</div>
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    changePassword: vi.fn(),
    firebaseUser: null,
    keyError: null,
    loading: false,
    loginRosterUser: vi.fn(),
    privateKey: {} as CryptoKey,
    profile: testData.userProfile,
    signOut: vi.fn(),
    unlockPrivateKey: vi.fn()
  })
}));

vi.mock("../lib/koreanHolidays", async () => {
  const actual = await vi.importActual<typeof import("../lib/koreanHolidays")>("../lib/koreanHolidays");

  return {
    ...actual,
    getKoreanHolidayMapForDates: vi.fn().mockResolvedValue({})
  };
});

vi.mock("../services/userPreferences", () => ({
  defaultUserPreferences: {
    defaultHome: "notes",
    matrixLabels: testData.matrixLabels,
    scheduleDefaultView: "todo",
    theme: "system",
    uid: "user-a"
  },
  getCachedUserPreferences: vi.fn(() => ({
    defaultHome: "notes",
    matrixLabels: testData.matrixLabels,
    scheduleDefaultView: "todo",
    theme: "system",
    uid: "user-a"
  })),
  getUserPreferences: vi.fn().mockResolvedValue({
    defaultHome: "notes",
    matrixLabels: testData.matrixLabels,
    scheduleDefaultView: "todo",
    theme: "system",
    uid: "user-a"
  }),
  subscribeUserPreferences: vi.fn((_uid, onNext) => {
    onNext({
      defaultHome: "notes",
      matrixLabels: testData.matrixLabels,
      scheduleDefaultView: "todo",
      theme: "system",
      uid: "user-a"
    });
    return vi.fn();
  })
}));

vi.mock("../services/scheduleTasks", () => ({
  createScheduleTask: vi.fn(),
  deleteScheduleTask: vi.fn(),
  getScheduleTask: vi.fn(),
  subscribeScheduleTasks: vi.fn((_uid, onNext) => {
    onNext([]);
    return vi.fn();
  }),
  updateScheduleTask: vi.fn(),
  updateScheduleTaskOrderBatch: vi.fn()
}));

vi.mock("../services/recurringHabits", () => ({
  createRecurringHabit: vi.fn(),
  deleteRecurringHabit: vi.fn(),
  setRecurringHabitCheckIn: vi.fn(),
  subscribeRecurringHabitCheckIns: vi.fn((_uid, onNext) => {
    onNext([]);
    return vi.fn();
  }),
  subscribeRecurringHabits: vi.fn((_uid, onNext) => {
    onNext([]);
    return vi.fn();
  }),
  updateRecurringHabit: vi.fn(),
  updateRecurringHabitDayState: vi.fn(),
  updateRecurringHabitOrderBatch: vi.fn()
}));

describe("SchedulePage quick work panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles the lightning quick panel without moving the active tab", async () => {
    const user = userEvent.setup();

    render(<SchedulePage />);

    const todoTab = await screen.findByRole("button", { name: "할 일" });
    const quickPanelButton = screen.getByRole("button", { name: /빠른 업무 패널 열기/ });

    expect(todoTab).toHaveAttribute("aria-pressed", "true");
    expect(quickPanelButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("지연 업무")).not.toBeInTheDocument();

    await user.click(quickPanelButton);

    expect(screen.getByRole("button", { name: /빠른 업무 패널 닫기/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("지연 업무")).toBeInTheDocument();
    expect(screen.getByText("오늘 일정")).toBeInTheDocument();
    expect(screen.getByText("반복 업무")).toBeInTheDocument();
    expect(todoTab).toHaveAttribute("aria-pressed", "true");

    await user.click(quickPanelButton);

    expect(screen.getByRole("button", { name: /빠른 업무 패널 열기/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("지연 업무")).not.toBeInTheDocument();
    expect(todoTab).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the quick panel with Escape and outside pointer input", async () => {
    const user = userEvent.setup();

    render(<SchedulePage />);

    const quickPanelButton = await screen.findByRole("button", { name: /빠른 업무 패널 열기/ });

    await user.click(quickPanelButton);
    expect(screen.getByText("오늘 일정")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("오늘 일정")).not.toBeInTheDocument());
    await waitFor(() => expect(quickPanelButton).toHaveFocus());

    await user.click(quickPanelButton);
    expect(screen.getByText("오늘 일정")).toBeInTheDocument();

    await user.click(document.body);

    expect(screen.queryByText("오늘 일정")).not.toBeInTheDocument();
    expect(quickPanelButton).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the create dialog open when Escape closes a nested date picker", async () => {
    const user = userEvent.setup();
    const { container } = render(<SchedulePage />);

    await user.click(await screen.findByRole("button", { name: "새 일정" }));

    expect(screen.getByRole("dialog", { name: "새 일정 추가" })).toBeInTheDocument();

    const dateTrigger = container.querySelector<HTMLButtonElement>(".date-picker-trigger");
    expect(dateTrigger).not.toBeNull();

    await user.click(dateTrigger!);
    expect(document.querySelector(".date-picker-popover")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(document.querySelector(".date-picker-popover")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "새 일정 추가" })).toBeInTheDocument();
  });
});
