import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeRecurringHabitCheckIns, subscribeRecurringHabits } from "../services/recurringHabits";
import { subscribeScheduleTasks } from "../services/scheduleTasks";
import SchedulePage from "./SchedulePage";

function renderSchedulePage(routeView?: "recurring") {
  return render(
    <MemoryRouter initialEntries={[routeView ? "/schedule/recurring" : "/schedule"]}>
      <Routes>
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/schedule/recurring" element={<SchedulePage routeView="recurring" />} />
      </Routes>
    </MemoryRouter>
  );
}

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
    privateKey: {} as CryptoKey | null,
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
    privateKey: testData.privateKey,
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
  updateRecurringHabitDayState: vi.fn(),
  updateRecurringHabitFromLatest: vi.fn(),
  updateRecurringHabitOrderBatch: vi.fn()
}));

describe("SchedulePage quick work panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testData.privateKey = {} as CryptoKey;
  });

  it("toggles the lightning quick panel without moving the active tab", async () => {
    const user = userEvent.setup();

    renderSchedulePage();

    const todoTab = await screen.findByRole("button", { name: "할 일" });
    const quickPanelButton = screen.getByRole("button", { name: /빠른 업무 패널 열기/ });

    expect(todoTab).toHaveAttribute("aria-pressed", "true");
    expect(quickPanelButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("지연 업무")).not.toBeInTheDocument();
    expect(subscribeRecurringHabits).not.toHaveBeenCalled();
    expect(subscribeRecurringHabitCheckIns).not.toHaveBeenCalled();

    await user.click(quickPanelButton);

    expect(screen.getByRole("button", { name: /빠른 업무 패널 닫기/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("지연 업무")).toBeInTheDocument();
    expect(screen.getByText("오늘 일정")).toBeInTheDocument();
    expect(screen.getByText("반복 업무")).toBeInTheDocument();
    expect(todoTab).toHaveAttribute("aria-pressed", "true");
    expect(subscribeRecurringHabits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(subscribeRecurringHabitCheckIns).mock.calls[0]?.[3]).toEqual({ date: expect.any(String) });

    await user.click(quickPanelButton);

    expect(screen.getByRole("button", { name: /빠른 업무 패널 열기/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("지연 업무")).not.toBeInTheDocument();
    expect(todoTab).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the quick panel with Escape and outside pointer input", async () => {
    const user = userEvent.setup();

    renderSchedulePage();

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
    const { container } = renderSchedulePage();

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

  it("keeps recurring management out of the overflow menu", async () => {
    const user = userEvent.setup();
    renderSchedulePage();

    await user.click(await screen.findByRole("button", { name: "일정관리 도구 열기" }));

    expect(screen.getByText("완료 내역")).toBeInTheDocument();
    expect(screen.queryByText("반복 업무 관리")).not.toBeInTheDocument();
    expect(screen.queryByText("반복 업무 추가")).not.toBeInTheDocument();
  });

  it("shows recurring work as a dedicated fourth tab and page", async () => {
    const user = userEvent.setup();
    renderSchedulePage("recurring");

    const recurringTab = await screen.findByRole("button", { name: "반복 업무" });

    expect(recurringTab).toHaveAttribute("aria-pressed", "true");
    expect(subscribeScheduleTasks).not.toHaveBeenCalled();
    expect(subscribeRecurringHabits).toHaveBeenCalledTimes(1);
    expect(subscribeRecurringHabitCheckIns).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "할 일" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "새 반복 업무" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /빠른 업무 패널/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "할 일" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "할 일" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "새 일정" })).toBeInTheDocument();
  });

  it("does not subscribe to schedule data while the encryption key is locked", async () => {
    testData.privateKey = null;

    renderSchedulePage();

    expect(await screen.findByText("잠금 해제")).toBeInTheDocument();
    expect(subscribeScheduleTasks).not.toHaveBeenCalled();
    expect(subscribeRecurringHabits).not.toHaveBeenCalled();
    expect(subscribeRecurringHabitCheckIns).not.toHaveBeenCalled();
  });
});
