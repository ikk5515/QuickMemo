import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeRecurringHabitCheckIns, subscribeRecurringHabits } from "../services/recurringHabits";
import {
  beginGoogleCalendarDeletionWorkflow,
  deleteGoogleCalendarTask,
  disconnectGoogleCalendar,
  endGoogleCalendarDeletionWorkflow,
  getGoogleCalendarConnectionStatus,
  GoogleCalendarError,
  reconcileGoogleCalendarTask,
  reportGoogleCalendarSync,
  renewGoogleCalendarDeletionWorkflow,
  startGoogleCalendarConnection,
  upsertGoogleCalendarTask
} from "../services/googleCalendar";
import { inspectGoogleCalendarTaskAuthority } from "../services/googleCalendarTaskAuthority";
import {
  listGoogleCalendarTaskSyncReceipts,
  markScheduleTaskGoogleCalendarSynced,
  scheduleTaskNeedsGoogleCalendarRecovery
} from "../services/googleCalendarTaskSync";
import {
  beginGoogleCalendarTaskDeletion,
  cancelGoogleCalendarTaskDeletion,
  getGoogleCalendarTaskTombstone,
  listGoogleCalendarTaskTombstones
} from "../services/googleCalendarTaskTombstones";
import {
  createScheduleTask,
  deleteScheduleTask,
  getScheduleTask,
  subscribeScheduleTasks,
  updateScheduleTask,
  type ScheduleTaskSnapshot
} from "../services/scheduleTasks";
import SchedulePage from "./SchedulePage";

function schedulePageElement(routeView?: "recurring", initialEntry?: string) {
  return (
    <MemoryRouter initialEntries={[initialEntry ?? (routeView ? "/schedule/recurring" : "/schedule")]}>
      <Routes>
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/schedule/recurring" element={<SchedulePage routeView="recurring" />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderSchedulePage(routeView?: "recurring", initialEntry?: string) {
  return render(schedulePageElement(routeView, initialEntry));
}

function scheduleTaskSnapshot(): ScheduleTaskSnapshot {
  return {
    id: "matrix-task-a",
    ownerUid: "user-a",
    status: "active",
    dueDate: null,
    dueTimeMinutes: null,
    isImportant: true,
    isUrgent: true,
    encryptedTitle: { version: 1, algorithm: "AES-GCM", cipherText: "matrix-title", iv: "iv" },
    encryptedDetails: { version: 1, algorithm: "AES-GCM", cipherText: "matrix-details", iv: "iv" },
    wrappedKeys: {
      "user-a": { version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped" }
    },
    createdBy: "user-a",
    updatedBy: "user-a",
    updatedAt: { seconds: 1_753_142_400, nanoseconds: 0 } as ScheduleTaskSnapshot["updatedAt"]
  };
}

function datedScheduleTaskSnapshot(id: string, title: string, date = "2099-01-10"): ScheduleTaskSnapshot {
  return {
    ...scheduleTaskSnapshot(),
    id,
    dueDate: date,
    startDate: date,
    endDate: date,
    encryptedTitle: { version: 1, algorithm: "AES-GCM", cipherText: `plain:${title}`, iv: "iv" }
  };
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

const cryptoMocks = vi.hoisted(() => ({
  decryptText: vi.fn(async (payload: { cipherText: string }) => {
    if (payload.cipherText === "matrix-title") {
      return "matrix drag task";
    }
    if (payload.cipherText.startsWith("plain:")) {
      return payload.cipherText.slice("plain:".length);
    }
    return JSON.stringify({ checklist: [], description: "" });
  }),
  encryptText: vi.fn(async () => ({ version: 1, algorithm: "AES-GCM", cipherText: "encrypted", iv: "iv" })),
  generateNoteKey: vi.fn(async () => ({} as CryptoKey)),
  wrapNoteKey: vi.fn(async () => ({ version: 1, algorithm: "RSA-OAEP", wrappedKey: "wrapped" })),
  unwrapNoteKey: vi.fn(async () => ({} as CryptoKey))
}));

const googleCalendarTestData = vi.hoisted(() => ({
  disconnected: {
    configured: true,
    connected: false,
    hasStoredConnection: false,
    needsReconnect: false,
    connectionGeneration: null,
    email: null,
    lastSyncAt: null,
    lastSyncStatus: "idle" as const,
    syncedCount: 0,
    timeZone: null
  }
}));

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

vi.mock("../lib/crypto", async () => {
  const actual = await vi.importActual<typeof import("../lib/crypto")>("../lib/crypto");

  return {
    ...actual,
    decryptText: cryptoMocks.decryptText,
    encryptText: cryptoMocks.encryptText,
    generateNoteKey: cryptoMocks.generateNoteKey,
    wrapNoteKey: cryptoMocks.wrapNoteKey,
    unwrapNoteKey: cryptoMocks.unwrapNoteKey
  };
});

vi.mock("../lib/koreanHolidays", async () => {
  const actual = await vi.importActual<typeof import("../lib/koreanHolidays")>("../lib/koreanHolidays");

  return {
    ...actual,
    getKoreanHolidayMapForDates: vi.fn().mockResolvedValue({})
  };
});

vi.mock("../services/googleCalendar", () => {
  class GoogleCalendarError extends Error {
    code: string;
    mutationMayHaveApplied: boolean;
    retryable: boolean;
    retryAfterMs: number | null;

    constructor(
      code: string,
      message: string,
      retryable = false,
      retryAfterMs: number | null = null,
      mutationMayHaveApplied = false
    ) {
      super(message);
      this.code = code;
      this.mutationMayHaveApplied = mutationMayHaveApplied;
      this.retryable = retryable;
      this.retryAfterMs = retryAfterMs;
    }
  }

  return {
    GoogleCalendarError,
    beginGoogleCalendarDeletionWorkflow: vi.fn().mockResolvedValue({
      connectionGeneration: "generation-a",
      ownerUid: "user-a",
      workflowLeaseId: "w".repeat(43)
    }),
    clearGoogleCalendarSession: vi.fn(),
    deleteGoogleCalendarTask: vi.fn().mockResolvedValue({
      eventId: "event-a",
      outcome: "deleted",
      remoteWasPresent: true
    }),
    detectedGoogleCalendarTimeZone: vi.fn(() => "Asia/Seoul"),
    disconnectedGoogleCalendarStatus: googleCalendarTestData.disconnected,
    disconnectGoogleCalendar: vi.fn().mockResolvedValue(undefined),
    endGoogleCalendarDeletionWorkflow: vi.fn().mockResolvedValue(undefined),
    getGoogleCalendarConnectionStatus: vi.fn().mockResolvedValue(googleCalendarTestData.disconnected),
    googleCalendarErrorCode: vi.fn((error: { code?: string }) => error?.code ?? "unknown_error"),
    googleCalendarErrorMessage: vi.fn((error: { message?: string }) => error?.message ?? "동기화 오류"),
    reconcileGoogleCalendarTask: vi.fn(),
    reportGoogleCalendarSync: vi.fn().mockResolvedValue(undefined),
    renewGoogleCalendarDeletionWorkflow: vi.fn().mockResolvedValue(undefined),
    startGoogleCalendarConnection: vi.fn().mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      connectionAttemptId: "a".repeat(43)
    }),
    upsertGoogleCalendarTask: vi.fn().mockResolvedValue({ eventId: "event-a", outcome: "created" })
  };
});

vi.mock("../services/googleCalendarTaskAuthority", () => ({
  inspectGoogleCalendarTaskAuthority: vi.fn().mockResolvedValue("current")
}));

vi.mock("../services/googleCalendarTaskSync", () => ({
  googleCalendarTaskRevisionTimestamp: vi.fn((task: {
    calendarUpdatedAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  }) => task.calendarUpdatedAt ?? task.createdAt ?? task.updatedAt ?? null),
  listGoogleCalendarTaskSyncReceipts: vi.fn().mockResolvedValue([]),
  markScheduleTaskGoogleCalendarSynced: vi.fn().mockResolvedValue(undefined),
  scheduleTaskNeedsGoogleCalendarRecovery: vi.fn().mockReturnValue(false)
}));

vi.mock("../services/googleCalendarTaskTombstones", () => ({
  beginGoogleCalendarTaskDeletion: vi.fn().mockResolvedValue({
    connectionGeneration: null,
    createdAt: null,
    deletionAttemptId: "a".repeat(32),
    leaseExpiresAt: { seconds: 9_999_999_999, nanoseconds: 0 },
    ownerUid: "user-a",
    taskId: "matrix-task-a"
  }),
  cancelGoogleCalendarTaskDeletion: vi.fn().mockResolvedValue(true),
  getGoogleCalendarTaskTombstone: vi.fn().mockResolvedValue(null),
  listGoogleCalendarTaskTombstones: vi.fn().mockResolvedValue([])
}));

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
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(googleCalendarTestData.disconnected);
    vi.mocked(deleteGoogleCalendarTask).mockResolvedValue({
      eventId: "event-a",
      outcome: "deleted",
      remoteWasPresent: true
    });
    vi.mocked(disconnectGoogleCalendar).mockResolvedValue(undefined);
    vi.mocked(beginGoogleCalendarDeletionWorkflow).mockResolvedValue({
      connectionGeneration: "generation-a",
      ownerUid: "user-a",
      workflowLeaseId: "w".repeat(43)
    });
    vi.mocked(endGoogleCalendarDeletionWorkflow).mockResolvedValue(undefined);
    vi.mocked(renewGoogleCalendarDeletionWorkflow).mockResolvedValue(undefined);
    vi.mocked(upsertGoogleCalendarTask).mockResolvedValue({ eventId: "event-a", outcome: "created" });
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("current");
    vi.mocked(reconcileGoogleCalendarTask).mockImplementation(async (
      task,
      timeZone,
      signal,
      deletionWorkflow
    ) => {
      if (deletionWorkflow) {
        const result = await deleteGoogleCalendarTask(
          { id: task.id, ownerUid: task.ownerUid },
          signal,
          deletionWorkflow
        );

        return {
          authorityAfter: "deleted",
          authorityBefore: "deleted",
          result
        };
      }
      const authorityBefore = await inspectGoogleCalendarTaskAuthority(task);

      if (authorityBefore === "stale") {
        return {
          authorityAfter: "stale",
          authorityBefore,
          result: { eventId: null, outcome: "skipped" }
        };
      }
      const result = authorityBefore === "current"
        ? await upsertGoogleCalendarTask(task, timeZone, signal)
        : await deleteGoogleCalendarTask(
          { id: task.id, ownerUid: task.ownerUid },
          signal,
          deletionWorkflow
        );
      const authorityAfter = await inspectGoogleCalendarTaskAuthority(task);

      return { authorityAfter, authorityBefore, result };
    });
    vi.mocked(listGoogleCalendarTaskSyncReceipts).mockResolvedValue([]);
    vi.mocked(markScheduleTaskGoogleCalendarSynced).mockResolvedValue(undefined);
    vi.mocked(scheduleTaskNeedsGoogleCalendarRecovery).mockReturnValue(false);
    vi.mocked(beginGoogleCalendarTaskDeletion).mockImplementation(async (
      ownerUid,
      taskId,
      _updatedAt,
      connectionGeneration = null
    ) => ({
      connectionGeneration,
      createdAt: null as never,
      deletionAttemptId: "a".repeat(32),
      leaseExpiresAt: { seconds: 9_999_999_999, nanoseconds: 0 } as never,
      ownerUid,
      taskId
    }));
    vi.mocked(cancelGoogleCalendarTaskDeletion).mockResolvedValue(true);
    vi.mocked(getGoogleCalendarTaskTombstone).mockResolvedValue(null);
    vi.mocked(listGoogleCalendarTaskTombstones).mockResolvedValue([]);
    vi.mocked(reportGoogleCalendarSync).mockResolvedValue(undefined);
    vi.mocked(createScheduleTask).mockResolvedValue({ id: "new-task" } as Awaited<ReturnType<typeof createScheduleTask>>);
    vi.mocked(getScheduleTask).mockImplementation(async (taskId) => ({
      ...scheduleTaskSnapshot(),
      id: taskId
    }));
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

  it("does not expose Google Calendar sync from the recurring-only route", async () => {
    renderSchedulePage("recurring");

    expect(await screen.findByRole("button", { name: "새 반복 업무" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Google Calendar 동기화/u })).not.toBeInTheDocument();
    expect(getGoogleCalendarConnectionStatus).not.toHaveBeenCalled();
  });

  it("does not subscribe to schedule data while the encryption key is locked", async () => {
    testData.privateKey = null;

    renderSchedulePage();

    expect(await screen.findByText("잠금 해제")).toBeInTheDocument();
    expect(subscribeScheduleTasks).not.toHaveBeenCalled();
    expect(subscribeRecurringHabits).not.toHaveBeenCalled();
    expect(subscribeRecurringHabitCheckIns).not.toHaveBeenCalled();
  });

  it("does not reopen a previously open Calendar dialog after lock state changes", async () => {
    const user = userEvent.setup();
    const view = renderSchedulePage();

    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    expect(await screen.findByRole("dialog", { name: "Google Calendar 동기화" })).toBeInTheDocument();

    testData.privateKey = null;
    view.rerender(schedulePageElement());
    expect(await screen.findByText("잠금 해제")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Google Calendar 동기화" })).not.toBeInTheDocument());

    testData.privateKey = {} as CryptoKey;
    view.rerender(schedulePageElement());
    expect(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Google Calendar 동기화" })).not.toBeInTheDocument();
  });

  it("drags task content into another matrix section and updates its priority", async () => {
    const matrixTask = scheduleTaskSnapshot();

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([matrixTask]);
      return vi.fn();
    });

    renderSchedulePage(undefined, "/schedule?view=matrix");

    const taskTitle = await screen.findByText("matrix drag task");
    const taskRow = taskTitle.closest<HTMLElement>(".matrix-task-row");
    const dragHandle = taskRow?.querySelector<HTMLButtonElement>(".task-drag-handle");
    const urgentSection = screen.getByRole("heading", { name: testData.matrixLabels.urgent }).closest<HTMLElement>(
      ".matrix-section"
    );

    expect(taskRow).not.toBeNull();
    expect(urgentSection).not.toBeNull();
    expect(dragHandle).toHaveAttribute("tabindex", "0");

    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      if (this === taskRow) {
        return testRect(0, 0, 240, 60);
      }

      if (this === urgentSection) {
        return testRect(300, 0, 240, 220);
      }

      return testRect(0, 0, 0, 0);
    });

    fireEvent.pointerDown(taskTitle, { button: 0, clientX: 10, clientY: 10, isPrimary: true, pointerId: 1 });
    fireEvent.pointerMove(document, { button: 0, clientX: 20, clientY: 10, isPrimary: true, pointerId: 1 });

    await waitFor(() => expect(document.querySelector(".matrix-drag-overlay")).toBeInTheDocument());

    fireEvent.pointerMove(document, { button: 0, clientX: 360, clientY: 40, isPrimary: true, pointerId: 1 });
    await waitFor(() => expect(urgentSection).toHaveClass("drag-over"));

    fireEvent.pointerUp(document, { button: 0, clientX: 360, clientY: 40, isPrimary: true, pointerId: 1 });

    await waitFor(() =>
      expect(updateScheduleTask).toHaveBeenCalledWith("matrix-task-a", "user-a", {
        isImportant: false,
        isUrgent: true
      })
    );

    // dnd-kit removes its document-level click guard shortly after the pointer sensor detaches.
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    rectSpy.mockRestore();
  });

  it("syncs the new date when matrix drag moves an undated task into today's section", async () => {
    const matrixTask = scheduleTaskSnapshot();
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([matrixTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(datedScheduleTaskSnapshot(
      "matrix-task-a",
      "matrix drag task",
      today
    ));

    renderSchedulePage(undefined, "/schedule?view=matrix");
    const taskTitle = await screen.findByText("matrix drag task");
    const taskRow = taskTitle.closest<HTMLElement>(".matrix-task-row");
    const todaySection = screen.getByRole("heading", {
      name: testData.matrixLabels.todayOverdue
    }).closest<HTMLElement>(".matrix-section");
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      if (this === taskRow) {
        return testRect(0, 0, 240, 60);
      }
      if (this === todaySection) {
        return testRect(300, 0, 240, 220);
      }
      return testRect(0, 0, 0, 0);
    });

    fireEvent.pointerDown(taskTitle, { button: 0, clientX: 10, clientY: 10, isPrimary: true, pointerId: 1 });
    fireEvent.pointerMove(document, { button: 0, clientX: 20, clientY: 10, isPrimary: true, pointerId: 1 });
    await waitFor(() => expect(document.querySelector(".matrix-drag-overlay")).toBeInTheDocument());
    fireEvent.pointerMove(document, { button: 0, clientX: 360, clientY: 40, isPrimary: true, pointerId: 1 });
    fireEvent.pointerUp(document, { button: 0, clientX: 360, clientY: 40, isPrimary: true, pointerId: 1 });

    await waitFor(() => expect(updateScheduleTask).toHaveBeenCalledWith("matrix-task-a", "user-a", {
      dueDate: today,
      endDate: today,
      isImportant: true,
      isUrgent: true,
      sortOrder: null,
      startDate: today
    }, {
      expectedUpdatedAt: expect.objectContaining({ nanoseconds: 0, seconds: 1_753_142_400 })
    }));
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "matrix-task-a", startDate: today, endDate: today }),
      "Asia/Seoul",
      undefined
    ));

    // dnd-kit removes its document-level click guard shortly after the pointer sensor detaches.
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    rectSpy.mockRestore();
  });

  it("uses an accessible confirmation dialog before deleting from read or edit", async () => {
    const user = userEvent.setup();

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });

    renderSchedulePage();

    const taskTitle = await screen.findByText("matrix drag task");
    const taskOpenButton = taskTitle.closest<HTMLButtonElement>(".task-open-button");

    expect(taskOpenButton).not.toBeNull();
    await user.click(taskOpenButton!);

    const readDialog = await screen.findByRole("dialog", { name: "matrix drag task" });
    const readDeleteButton = within(readDialog).getByRole("button", { name: "삭제" });

    await user.click(readDeleteButton);

    let deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    const cancelButton = within(deleteDialog).getByRole("button", { name: "취소" });

    expect(within(deleteDialog).getByText("matrix drag task")).toBeInTheDocument();
    expect(within(deleteDialog).getByText("삭제한 일정과 체크리스트는 복구할 수 없습니다.")).toBeInTheDocument();
    expect(cancelButton).toHaveFocus();
    expect(readDialog.closest(".schedule-detail-backdrop")).toHaveAttribute("inert");
    expect(deleteScheduleTask).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(readDialog).toBeInTheDocument();
    expect(deleteScheduleTask).not.toHaveBeenCalled();
    await waitFor(() => expect(readDeleteButton).toHaveFocus());

    await user.click(readDeleteButton);
    deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "취소" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(readDialog).toBeInTheDocument();
    expect(deleteScheduleTask).not.toHaveBeenCalled();

    await user.click(within(readDialog).getByRole("button", { name: "수정" }));

    const editDialog = screen.getByRole("dialog");
    await user.click(within(editDialog).getByRole("button", { name: "삭제" }));

    deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(deleteScheduleTask).toHaveBeenCalledOnce());
    expect(deleteScheduleTask).toHaveBeenCalledWith("matrix-task-a");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the Google Calendar popup with a clear synced state and privacy explanation", async () => {
    const user = userEvent.setup();
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: "2026-07-22T09:00:00.000Z",
      lastSyncStatus: "synced",
      syncedCount: 4,
      timeZone: "Asia/Seoul"
    });

    renderSchedulePage();

    const trigger = await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });

    expect(within(dialog).getAllByText("동기화 완료").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("te***@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText(/비밀번호는 QuickMemo에 입력하지 않습니다/)).toBeInTheDocument();
    expect(within(dialog).getByText(/상세 내용과 체크리스트는 전송하지 않습니다/)).toBeInTheDocument();
  });

  it("explains how to recover when the browser blocks the Google login popup", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(within(dialog).getByRole("button", { name: "Google 계정 연결" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent("팝업이 차단되었습니다");
    expect(startGoogleCalendarConnection).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("syncs eligible existing schedules from the popup", async () => {
    const user = userEvent.setup();
    const datedTask = {
      ...scheduleTaskSnapshot(),
      dueDate: "2099-01-10",
      startDate: "2099-01-10",
      endDate: "2099-01-10"
    };
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    const syncButton = await within(dialog).findByRole("button", { name: "기존 일정 동기화" });

    await waitFor(() => expect(syncButton).toBeEnabled());
    await user.click(syncButton);

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "matrix drag task",
      startDate: "2099-01-10",
      endDate: "2099-01-10",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", expect.any(AbortSignal), undefined, expect.objectContaining({
      connected: true,
      connectionGeneration: "generation-a"
    })));
    await waitFor(() => expect(reportGoogleCalendarSync).toHaveBeenCalledWith({
      status: "synced",
      syncedCount: 1
    }));
  });

  it("stops a bulk sync after the first systemic outage instead of calling every task", async () => {
    const user = userEvent.setup();
    const firstTask = datedScheduleTaskSnapshot("matrix-task-a", "첫 일정");
    const secondTask = datedScheduleTaskSnapshot("matrix-task-b", "둘째 일정", "2099-01-11");

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([firstTask, secondTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(upsertGoogleCalendarTask).mockRejectedValueOnce(new GoogleCalendarError(
      "network_error",
      "Google Calendar 네트워크가 응답하지 않습니다."
    ));

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(await within(dialog).findByRole("button", { name: "기존 일정 동기화" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(1));
    expect(upsertGoogleCalendarTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "matrix-task-a" }),
      "Asia/Seoul",
      expect.any(AbortSignal),
      undefined,
      expect.objectContaining({
        connected: true,
        connectionGeneration: "generation-a"
      })
    );
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "matrix-task-b" }),
      expect.anything(),
      expect.anything()
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("2개는 반영하지 못했습니다");
  });

  it("restores the latest dated event before reporting a bounded reconciliation conflict", async () => {
    const user = userEvent.setup();
    const latestTask = datedScheduleTaskSnapshot("matrix-task-a", "경합 중 최신 일정", "2099-01-12");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task")]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(latestTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority)
      .mockResolvedValueOnce("current")
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("current")
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("deleted")
      .mockResolvedValueOnce("current");

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(await within(dialog).findByRole("button", { name: "기존 일정 동기화" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(3));
    expect(deleteGoogleCalendarTask).toHaveBeenCalledOnce();
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[2]);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/다른 창에서 계속 변경/);
  });

  it("restores a still-dated event when authority verification fails after cleanup", async () => {
    const user = userEvent.setup();
    const latestTask = datedScheduleTaskSnapshot("matrix-task-a", "판정 실패 복구 일정", "2099-01-12");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task")]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(latestTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority)
      .mockResolvedValueOnce("deleted")
      .mockRejectedValueOnce(new Error("authority unavailable"));

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(await within(dialog).findByRole("button", { name: "기존 일정 동기화" }));

    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledOnce());
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "판정 실패 복구 일정",
      startDate: "2099-01-12",
      endDate: "2099-01-12",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined, undefined, expect.objectContaining({
      connected: true,
      connectionGeneration: "generation-a"
    })));
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/authority unavailable/);
  });

  it("automatically sends a newly created dated schedule after the QuickMemo save", async () => {
    const user = userEvent.setup();
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValueOnce(
      datedScheduleTaskSnapshot("new-task", "새 동기화 일정", "2026-07-22")
    );

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });

    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "새 동기화 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "new-task",
      ownerUid: "user-a",
      title: "새 동기화 일정",
      startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined));
    expect(vi.mocked(createScheduleTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
    expect(reconcileGoogleCalendarTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new-task", revision: "001753142400.000000000" }),
      "Asia/Seoul",
      undefined,
      undefined,
      expect.objectContaining({
        connected: true,
        connectionGeneration: "generation-a"
      })
    );
  });

  it("closes creation after Firestore saves while Google Calendar continues in the background", async () => {
    const user = userEvent.setup();
    let resolveGoogleSync!: (result: Awaited<ReturnType<typeof upsertGoogleCalendarTask>>) => void;
    const googleSync = new Promise<Awaited<ReturnType<typeof upsertGoogleCalendarTask>>>((resolve) => {
      resolveGoogleSync = resolve;
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(
      datedScheduleTaskSnapshot("new-task", "백그라운드 동기화 일정", "2026-07-22")
    );
    vi.mocked(upsertGoogleCalendarTask).mockImplementationOnce(() => googleSync);

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });

    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "백그라운드 동기화 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(createScheduleTask).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 일정 추가" })).not.toBeInTheDocument());
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledOnce());
    const pendingTrigger = screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 중" });

    await user.click(pendingTrigger);
    expect(await screen.findByText("일정 변경사항 1개를 Google Calendar에 동기화하는 중입니다.")).toBeInTheDocument();
    resolveGoogleSync({ eventId: "event-a", outcome: "created" });

    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTitle("Google Calendar · 동기화 완료")).toBeInTheDocument());
  });

  it("coalesces queued changes for the same task to the newest background sync", async () => {
    const user = userEvent.setup();
    let resolveFirstGoogleSync!: (result: Awaited<ReturnType<typeof upsertGoogleCalendarTask>>) => void;
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(createScheduleTask).mockResolvedValue({ id: "same-task" } as Awaited<ReturnType<typeof createScheduleTask>>);
    vi.mocked(getScheduleTask)
      .mockResolvedValueOnce(datedScheduleTaskSnapshot("same-task", "첫 변경", "2026-07-22"))
      .mockResolvedValue(datedScheduleTaskSnapshot("same-task", "최신 변경", "2026-07-24"));
    vi.mocked(upsertGoogleCalendarTask).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstGoogleSync = resolve;
    }));

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });

    for (const title of ["첫 변경", "중간 변경", "최신 변경"]) {
      await user.click(screen.getByRole("button", { name: "새 일정" }));
      const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
      await user.type(within(createDialog).getByPlaceholderText("일정 제목"), title);
      await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 일정 추가" })).not.toBeInTheDocument());
    }

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(1));
    resolveFirstGoogleSync({ eventId: "event-a", outcome: "updated" });
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(2));
    expect(upsertGoogleCalendarTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "same-task", title: "최신 변경" }),
      "Asia/Seoul",
      undefined
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(2);
  });

  it("keeps each task failure visible until that same task later succeeds", async () => {
    const user = userEvent.setup();
    let rejectTaskA!: (reason: unknown) => void;
    let taskAAttempt = 0;
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced" as const,
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    };
    const createIds = ["task-a", "task-b", "task-b", "task-a"];

    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(connectedStatus);
    vi.mocked(createScheduleTask).mockImplementation(async () => ({
      id: createIds.shift() ?? "unexpected-task"
    } as Awaited<ReturnType<typeof createScheduleTask>>));
    vi.mocked(getScheduleTask).mockImplementation(async (taskId) =>
      datedScheduleTaskSnapshot(taskId, taskId === "task-a" ? "업무 A" : "업무 B", "2026-07-22"));
    vi.mocked(upsertGoogleCalendarTask).mockImplementation(async (task) => {
      if (task.id === "task-a" && taskAAttempt++ === 0) {
        return new Promise<Awaited<ReturnType<typeof upsertGoogleCalendarTask>>>((_resolve, reject) => {
          rejectTaskA = reject;
        });
      }
      return { eventId: `event-${task.id}`, outcome: "updated" };
    });

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });

    const create = async (title: string) => {
      await user.click(screen.getByRole("button", { name: "새 일정" }));
      const dialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
      await user.type(within(dialog).getByPlaceholderText("일정 제목"), title);
      await user.click(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 일정 추가" })).not.toBeInTheDocument());
    };

    await create("업무 A 첫 저장");
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-a" }),
      "Asia/Seoul",
      undefined
    ));
    await create("업무 B 첫 저장");
    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "task-b",
      "user-a",
      "generation-a",
      expect.any(Object)
    ));
    rejectTaskA(new GoogleCalendarError("calendar_request_failed", "업무 A 동기화 실패"));
    expect(await screen.findByText(/업무 A 동기화 실패/u)).toBeInTheDocument();
    expect(reportGoogleCalendarSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed"
    }));
    vi.mocked(reportGoogleCalendarSync).mockClear();

    await create("업무 B 재저장");
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" })).toBeInTheDocument();
    expect(screen.getByText(/업무 A 동기화 실패/u)).toBeInTheDocument();
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "synced"
    }));

    await create("업무 A 재저장");
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument());
    expect(screen.queryByText(/업무 A 동기화 실패/u)).not.toBeInTheDocument();
    expect(reportGoogleCalendarSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "synced"
    }));
  });

  it("invalidates an in-flight task sync when the Google connection is removed", async () => {
    const user = userEvent.setup();
    let resolveGoogleSync!: (result: Awaited<ReturnType<typeof upsertGoogleCalendarTask>>) => void;
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced" as const,
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    };

    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(connectedStatus);
    vi.mocked(getScheduleTask).mockResolvedValue(
      datedScheduleTaskSnapshot("new-task", "연결 해제 중 일정", "2026-07-22")
    );
    vi.mocked(upsertGoogleCalendarTask).mockImplementationOnce(() => new Promise((resolve) => {
      resolveGoogleSync = resolve;
    }));

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });

    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "연결 해제 중 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 중" }));
    const syncDialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });

    await user.click(within(syncDialog).getByRole("button", { name: "연결 해제" }));
    const confirmation = screen.getByRole("alertdialog", { name: "이 Google 계정 연결을 해제할까요?" });
    await user.click(within(confirmation).getByRole("button", { name: "연결 해제" }));

    await waitFor(() => expect(disconnectGoogleCalendar).toHaveBeenCalledOnce());
    await within(syncDialog).findByText("연결된 계정 없음");
    expect(within(syncDialog).queryByText(/일정 변경사항 1개를/u)).not.toBeInTheDocument();
    vi.mocked(reportGoogleCalendarSync).mockClear();

    resolveGoogleSync({ eventId: "event-a", outcome: "updated" });
    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalled());
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "synced"
    }));
    expect(within(syncDialog).getAllByText("미동기화").length).toBeGreaterThan(0);
  });

  it("does not let an unrelated successful bulk sync hide a task failure", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced" as const,
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    };

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedScheduleTaskSnapshot("matrix-task-a", "기존 일정")]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(connectedStatus);
    vi.mocked(createScheduleTask).mockResolvedValue({ id: "task-a" } as Awaited<ReturnType<typeof createScheduleTask>>);
    vi.mocked(getScheduleTask).mockImplementation(async (taskId) =>
      datedScheduleTaskSnapshot(taskId, taskId === "task-a" ? "업무 A" : "기존 일정"));
    vi.mocked(upsertGoogleCalendarTask)
      .mockRejectedValueOnce(new GoogleCalendarError("calendar_request_failed", "업무 A 동기화 실패"))
      .mockResolvedValue({ eventId: "event-a", outcome: "updated" });

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "업무 A");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    expect(await screen.findByText(/업무 A 동기화 실패/u)).toBeInTheDocument();
    await waitFor(() => expect(reportGoogleCalendarSync).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed"
    })));
    vi.mocked(reportGoogleCalendarSync).mockClear();

    await user.click(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" }));
    const syncDialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(await within(syncDialog).findByRole("button", { name: "기존 일정 동기화" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(syncDialog).getByRole("button", { name: "기존 일정 동기화" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" })).toBeInTheDocument();
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "synced"
    }));
  });

  it("keeps a failed bulk task visible across another task success until that task is retried", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced" as const,
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    };

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedScheduleTaskSnapshot("bulk-task-a", "기존 업무 A")]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(connectedStatus);
    vi.mocked(createScheduleTask).mockResolvedValue({ id: "task-b" } as Awaited<ReturnType<typeof createScheduleTask>>);
    vi.mocked(getScheduleTask).mockImplementation(async (taskId) =>
      datedScheduleTaskSnapshot(taskId, taskId === "task-b" ? "신규 업무 B" : "기존 업무 A"));
    vi.mocked(upsertGoogleCalendarTask)
      .mockRejectedValueOnce(new GoogleCalendarError("event_conflict", "기존 업무 A 동기화 실패"))
      .mockResolvedValue({ eventId: "event-a", outcome: "updated" });

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" }));
    let syncDialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(within(syncDialog).getByRole("button", { name: "기존 일정 동기화" }));

    expect(await within(syncDialog).findByText(/기존 업무 A 동기화 실패/u)).toBeInTheDocument();
    await user.click(within(syncDialog).getByRole("button", { name: "Google Calendar 동기화 창 닫기" }));
    vi.mocked(reportGoogleCalendarSync).mockClear();

    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "신규 업무 B");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "task-b",
      "user-a",
      "generation-a",
      expect.any(Object)
    ));
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" })).toBeInTheDocument();
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "synced" }));

    await user.click(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" }));
    syncDialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(within(syncDialog).getByRole("button", { name: "기존 일정 동기화" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument());
    expect(reportGoogleCalendarSync).toHaveBeenCalledWith(expect.objectContaining({ status: "synced" }));
  });

  it("lets Firestore Rules reject a stale receipt without a redundant task read", async () => {
    const user = userEvent.setup();
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(
      datedScheduleTaskSnapshot("new-task", "영수증 충돌 일정", "2026-07-22")
    );
    vi.mocked(markScheduleTaskGoogleCalendarSynced).mockRejectedValueOnce(
      new Error("stale receipt denied")
    );

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });

    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "영수증 충돌 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    expect(await screen.findByText(/^Google 일정은 반영했지만 동기화 상태를 저장하지 못했습니다/u))
      .toBeInTheDocument();
    expect(screen.queryByText(/Google Calendar에는 반영하지 못했습니다.*Google 일정은 반영했지만/u))
      .not.toBeInTheDocument();
    expect(getScheduleTask).toHaveBeenCalledTimes(1);
    expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "new-task",
      "user-a",
      "generation-a",
      { seconds: 1_753_142_400, nanoseconds: 0 }
    );
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" })).toBeInTheDocument();
  });

  it("removes a just-synced event when the task is deleted concurrently", async () => {
    const user = userEvent.setup();
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValueOnce(
      datedScheduleTaskSnapshot("new-task", "동시 삭제 일정", "2026-07-22")
    ).mockResolvedValueOnce(null);
    vi.mocked(reconcileGoogleCalendarTask)
      .mockImplementationOnce(async (task, timeZone, signal) => ({
        authorityAfter: "deleted",
        authorityBefore: "current",
        result: await upsertGoogleCalendarTask(task, timeZone, signal)
      }))
      .mockImplementationOnce(async (task, _timeZone, signal) => ({
        authorityAfter: "deleted",
        authorityBefore: "deleted",
        result: await deleteGoogleCalendarTask({ id: task.id, ownerUid: task.ownerUid }, signal)
      }));

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });

    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "동시 삭제 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledWith(
      { id: "new-task", ownerUid: "user-a" },
      undefined
    ));
    expect(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0]);
  });

  it("restores the latest dated event when an authority-based delete becomes stale", async () => {
    const user = userEvent.setup();
    const latestTask = datedScheduleTaskSnapshot("new-task", "동시 복구 일정", "2099-01-12");
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(latestTask);
    vi.mocked(reconcileGoogleCalendarTask)
      .mockImplementationOnce(async (task, _timeZone, signal) => ({
        authorityAfter: "current",
        authorityBefore: "deleted",
        result: await deleteGoogleCalendarTask({ id: task.id, ownerUid: task.ownerUid }, signal)
      }))
      .mockImplementationOnce(async (task, timeZone, signal) => ({
        authorityAfter: "current",
        authorityBefore: "current",
        result: await upsertGoogleCalendarTask(task, timeZone, signal)
      }));

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });

    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "동시 복구 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledWith({
      id: "new-task",
      ownerUid: "user-a"
    }, undefined));
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "new-task",
      ownerUid: "user-a",
      title: "동시 복구 일정",
      startDate: "2099-01-12",
      endDate: "2099-01-12",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined));
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
  });

  it("refreshes a stale disconnected state before saving and syncs the new dated schedule", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle" as const,
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    };
    vi.mocked(getGoogleCalendarConnectionStatus)
      .mockResolvedValueOnce(googleCalendarTestData.disconnected)
      .mockResolvedValue(connectedStatus);
    vi.mocked(getScheduleTask).mockResolvedValueOnce(
      datedScheduleTaskSnapshot("new-task", "다른 탭 연결 반영 일정", "2026-07-22")
    );

    renderSchedulePage();

    await waitFor(() => expect(getGoogleCalendarConnectionStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 미동기화" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "다른 탭 연결 반영 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "new-task",
      ownerUid: "user-a",
      title: "다른 탭 연결 반영 일정",
      startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined));
    expect(getGoogleCalendarConnectionStatus).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createScheduleTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
  });

  it("keeps the QuickMemo save and clearly warns when Google needs reconnection", async () => {
    const user = userEvent.setup();
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: false,
      hasStoredConnection: true,
      needsReconnect: true,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: "2026-07-22T09:00:00.000Z",
      lastSyncStatus: "failed",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 실패" });
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });

    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "재연결 필요 일정");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(createScheduleTask).toHaveBeenCalledOnce());
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(await screen.findByText(/Google Calendar 계정을 다시 연결해야 동기화됩니다/)).toBeInTheDocument();
  });

  it("keeps the QuickMemo task when Google deletion fails", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(deleteGoogleCalendarTask).mockRejectedValueOnce(new Error("Google API 오류"));

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledWith(
      { id: "matrix-task-a", ownerUid: "user-a" },
      undefined,
      expect.objectContaining({
        connectionGeneration: "generation-a",
        workflowLeaseId: "w".repeat(43)
      })
    ));
    expect(deleteScheduleTask).not.toHaveBeenCalled();
    expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "matrix-task-a",
      "a".repeat(32)
    );
    expect(await within(deleteDialog).findByText(/QuickMemo 일정은 유지했습니다/)).toBeInTheDocument();
  });

  it("restores Google before clearing protection when protected deletion becomes stale", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(datedTask);
    vi.mocked(reconcileGoogleCalendarTask).mockImplementationOnce(async (
      task,
      _timeZone,
      signal,
      deletionWorkflow
    ) => ({
      authorityAfter: "current",
      authorityBefore: "deleted",
      result: await deleteGoogleCalendarTask(
        { id: task.id, ownerUid: task.ownerUid },
        signal,
        deletionWorkflow
      )
    }));

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "matrix drag task",
      startDate: "2099-01-10",
      endDate: "2099-01-10",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined, expect.objectContaining({
      connectionGeneration: "generation-a",
      workflowLeaseId: "w".repeat(43)
    })));
    expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "matrix-task-a",
      "a".repeat(32)
    );
    expect(deleteScheduleTask).not.toHaveBeenCalled();
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
    expect(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(cancelGoogleCalendarTaskDeletion).mock.invocationCallOrder[0]);
    expect(await within(deleteDialog).findByText(/QuickMemo 일정은 유지했습니다/)).toBeInTheDocument();
  });

  it("keeps and reports deletion protection when a failed Google delete cannot clear it", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(deleteGoogleCalendarTask).mockRejectedValueOnce(new Error("Google API 오류"));
    vi.mocked(cancelGoogleCalendarTaskDeletion).mockResolvedValueOnce(false);

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    expect(await within(deleteDialog).findByText(/삭제 보호 상태를 정리하지 못했습니다/)).toBeInTheDocument();
    expect(deleteScheduleTask).not.toHaveBeenCalled();
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
  });

  it("keeps the tombstone when a sent Google delete has an unknowable outcome", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(deleteGoogleCalendarTask).mockRejectedValueOnce(new GoogleCalendarError(
      "network_error",
      "Google 응답을 확인하지 못했습니다.",
      true,
      null,
      true
    ));

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    expect(await within(deleteDialog).findByText(/Google의 삭제 결과를 확인할 수 없어 삭제 보호 상태를 유지했습니다/)).toBeInTheDocument();
    expect(deleteScheduleTask).not.toHaveBeenCalled();
    expect(cancelGoogleCalendarTaskDeletion).not.toHaveBeenCalled();
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(endGoogleCalendarDeletionWorkflow).toHaveBeenCalled();
  });

  it("restores Google and keeps the QuickMemo task when the workflow expires before local deletion", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(datedTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("deleted");
    vi.mocked(renewGoogleCalendarDeletionWorkflow).mockRejectedValueOnce(new GoogleCalendarError(
      "connection_changed",
      "삭제 보호 시간이 만료되었습니다."
    ));

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task"))
      .closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" }))
      .getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "matrix-task-a", startDate: "2099-01-10" }),
      "Asia/Seoul",
      undefined,
      expect.objectContaining({
        connectionGeneration: "generation-a",
        workflowLeaseId: "w".repeat(43)
      })
    ));
    expect(deleteScheduleTask).not.toHaveBeenCalled();
    expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "matrix-task-a",
      "a".repeat(32)
    );
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(renewGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0]);
    expect(vi.mocked(renewGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
    expect(await within(deleteDialog).findByText(/일정을 삭제하지 못했습니다/)).toBeInTheDocument();
  });

  it("protects the revision and verifies Google deletion around the connected QuickMemo delete", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      serverTime: "2026-07-22T04:00:00.000Z",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(deleteScheduleTask).toHaveBeenCalledWith("matrix-task-a"));
    expect(beginGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "matrix-task-a",
      expect.objectContaining({ seconds: 1_753_142_400, nanoseconds: 0 }),
      "generation-a",
      "2026-07-22T04:00:00.000Z"
    );
    expect(beginGoogleCalendarDeletionWorkflow).toHaveBeenCalledWith(
      "user-a",
      "generation-a",
      undefined,
      expect.objectContaining({
        connected: true,
        connectionGeneration: "generation-a"
      })
    );
    expect(reconcileGoogleCalendarTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "matrix-task-a" }),
      "Asia/Seoul",
      undefined,
      {
        connectionGeneration: "generation-a",
        ownerUid: "user-a",
        workflowLeaseId: "w".repeat(43)
      },
      expect.objectContaining({
        connected: true,
        connectionGeneration: "generation-a"
      })
    );
    expect(deleteGoogleCalendarTask).toHaveBeenCalledTimes(2);
    expect(deleteGoogleCalendarTask).toHaveBeenNthCalledWith(
      1,
      { id: "matrix-task-a", ownerUid: "user-a" },
      undefined,
      {
        connectionGeneration: "generation-a",
        ownerUid: "user-a",
        workflowLeaseId: "w".repeat(43)
      }
    );
    expect(deleteGoogleCalendarTask).toHaveBeenNthCalledWith(
      2,
      { id: "matrix-task-a", ownerUid: "user-a" },
      undefined,
      {
        connectionGeneration: "generation-a",
        ownerUid: "user-a",
        workflowLeaseId: "w".repeat(43)
      }
    );
    expect(renewGoogleCalendarDeletionWorkflow).toHaveBeenCalledWith({
      connectionGeneration: "generation-a",
      ownerUid: "user-a",
      workflowLeaseId: "w".repeat(43)
    });
    expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "matrix-task-a",
      "a".repeat(32)
    );
    expect(vi.mocked(beginGoogleCalendarTaskDeletion).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(beginGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0]);
    expect(vi.mocked(beginGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0]);
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(renewGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0]);
    expect(vi.mocked(renewGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteScheduleTask).mock.invocationCallOrder[0]);
    expect(vi.mocked(deleteScheduleTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[1]);
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(cancelGoogleCalendarTaskDeletion).mock.invocationCallOrder[0]);
    expect(vi.mocked(cancelGoogleCalendarTaskDeletion).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(endGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0]);
  });

  it("closes deletion after the protected local delete while final Google verification continues", async () => {
    const user = userEvent.setup();
    let resolveFinalVerification!: (result: Awaited<ReturnType<typeof deleteGoogleCalendarTask>>) => void;
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("deleted");
    vi.mocked(deleteGoogleCalendarTask)
      .mockResolvedValueOnce({ eventId: "event-a", outcome: "deleted", remoteWasPresent: true })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFinalVerification = resolve;
      }));

    renderSchedulePage();
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" });
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(deleteScheduleTask).toHaveBeenCalledWith("matrix-task-a"));
    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).not.toBeInTheDocument();
    expect(screen.getByText("일정을 삭제했습니다. Google Calendar 상태를 안전하게 마무리하고 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 중" })).toBeInTheDocument();
    expect(cancelGoogleCalendarTaskDeletion).not.toHaveBeenCalled();
    expect(vi.mocked(renewGoogleCalendarDeletionWorkflow).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteScheduleTask).mock.invocationCallOrder[0]);

    resolveFinalVerification({ eventId: "event-a", outcome: "deleted", remoteWasPresent: false });
    await waitFor(() => expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledOnce());
    await waitFor(() => expect(endGoogleCalendarDeletionWorkflow).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument());
  });

  it("treats an already-cleared deletion tombstone as successful cleanup", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(cancelGoogleCalendarTaskDeletion).mockResolvedValueOnce(false);
    vi.mocked(getGoogleCalendarTaskTombstone).mockResolvedValueOnce(null);

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(getGoogleCalendarTaskTombstone).toHaveBeenCalledWith("user-a", "matrix-task-a"));
    await waitFor(() => expect(screen.getByText("일정을 삭제했습니다.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument();
  });

  it.each([
    ["a".repeat(32), "삭제 보호 상태가 아직 남아 있습니다"],
    ["b".repeat(32), "더 최신 삭제 보호 작업이 진행 중입니다"]
  ])("fails closed when tombstone cleanup leaves attempt %s", async (remainingAttemptId, warning) => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(cancelGoogleCalendarTaskDeletion).mockResolvedValueOnce(false);
    vi.mocked(getGoogleCalendarTaskTombstone).mockResolvedValueOnce({
      connectionGeneration: "generation-a",
      createdAt: { seconds: 1_753_142_400, nanoseconds: 0 } as never,
      deletionAttemptId: remainingAttemptId,
      leaseExpiresAt: { seconds: 9_999_999_999, nanoseconds: 0 } as never,
      ownerUid: "user-a",
      taskId: "matrix-task-a"
    });

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).getByRole("button", { name: "일정 삭제" }));

    expect((await screen.findAllByText(new RegExp(warning, "u"))).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" })).toBeInTheDocument();
  });

  it("refreshes a stale disconnected state and deletes from Google before the local task", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced" as const,
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    };
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus)
      .mockResolvedValueOnce(googleCalendarTestData.disconnected)
      .mockResolvedValue(connectedStatus);

    renderSchedulePage();

    await waitFor(() => expect(getGoogleCalendarConnectionStatus).toHaveBeenCalledTimes(1));
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(deleteScheduleTask).toHaveBeenCalledWith("matrix-task-a"));
    expect(getGoogleCalendarConnectionStatus).toHaveBeenCalledTimes(2);
    expect(deleteGoogleCalendarTask).toHaveBeenCalledWith(
      { id: "matrix-task-a", ownerUid: "user-a" },
      undefined,
      expect.objectContaining({
        connectionGeneration: "generation-a",
        workflowLeaseId: "w".repeat(43)
      })
    );
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteScheduleTask).mock.invocationCallOrder[0]);
  });

  it("keeps both copies when connection status cannot be verified before deletion", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockRejectedValue(new Error("status unavailable"));

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    expect(await within(deleteDialog).findByText(/연결 상태를 확인하지 못해 QuickMemo 일정은 유지했습니다/)).toBeInTheDocument();
    expect(beginGoogleCalendarTaskDeletion).not.toHaveBeenCalled();
    expect(deleteGoogleCalendarTask).not.toHaveBeenCalled();
    expect(deleteScheduleTask).not.toHaveBeenCalled();
  });

  it("does not recreate the Google event when a failed local delete finds no remaining task", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(deleteScheduleTask).mockRejectedValueOnce(new Error("다른 탭에서 이미 삭제됨"));
    vi.mocked(getScheduleTask).mockResolvedValueOnce(null);
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("deleted");

    renderSchedulePage();

    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(getScheduleTask).toHaveBeenCalledWith("matrix-task-a"));
    expect(deleteGoogleCalendarTask).toHaveBeenCalledWith(
      { id: "matrix-task-a", ownerUid: "user-a" },
      undefined,
      expect.objectContaining({
        connectionGeneration: "generation-a",
        workflowLeaseId: "w".repeat(43)
      })
    );
    expect(deleteScheduleTask).toHaveBeenCalledWith("matrix-task-a");
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(deleteDialog).toBeInTheDocument();
  });

  it("cancels an in-progress existing schedule sync without starting the next task", async () => {
    const user = userEvent.setup();
    const firstTask = {
      ...scheduleTaskSnapshot(),
      dueDate: "2099-01-10",
      startDate: "2099-01-10",
      endDate: "2099-01-10"
    };
    const secondTask = {
      ...scheduleTaskSnapshot(),
      id: "matrix-task-b",
      dueDate: "2099-01-11",
      startDate: "2099-01-11",
      endDate: "2099-01-11"
    };
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([firstTask, secondTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    let operationSignal: AbortSignal | undefined;
    vi.mocked(upsertGoogleCalendarTask).mockImplementationOnce((_task, _timeZone, signal) => {
      operationSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject({ code: "sync_cancelled", message: "기존 일정 동기화를 취소했습니다." });
        }, { once: true });
      });
    });

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(await within(dialog).findByRole("button", { name: "기존 일정 동기화" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(1));
    await user.click(within(dialog).getByRole("button", { name: "동기화 취소" }));

    await waitFor(() => expect(operationSignal?.aborted).toBe(true));
    await waitFor(() => expect(within(dialog).getByText("기존 일정 동기화를 중단했습니다.")).toBeInTheDocument());
    expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(1);
  });

  it("cancels immediately while the existing-sync connection check is still pending", async () => {
    const user = userEvent.setup();
    const datedTask = {
      ...scheduleTaskSnapshot(),
      dueDate: "2099-01-10",
      startDate: "2099-01-10",
      endDate: "2099-01-10"
    };
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle" as const,
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    };
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(connectedStatus);

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    const syncButton = await within(dialog).findByRole("button", { name: "기존 일정 동기화" });
    let statusSignal: AbortSignal | undefined;

    vi.mocked(getGoogleCalendarConnectionStatus).mockImplementationOnce((signal) => {
      statusSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject({
          code: "sync_cancelled",
          message: "기존 일정 동기화를 취소했습니다."
        }), { once: true });
      });
    });
    await user.click(syncButton);
    await user.click(within(dialog).getByRole("button", { name: "동기화 취소" }));

    await waitFor(() => expect(statusSignal?.aborted).toBe(true));
    await waitFor(() => expect(within(dialog).getByText("기존 일정 동기화를 중단했습니다.")).toBeInTheDocument());
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
  });

  it("keeps an earlier bulk-sync failure visible when the user cancels a later task", async () => {
    const user = userEvent.setup();
    const tasks = [
      {
        ...scheduleTaskSnapshot(),
        dueDate: "2099-01-10",
        startDate: "2099-01-10",
        endDate: "2099-01-10"
      },
      {
        ...scheduleTaskSnapshot(),
        id: "matrix-task-b",
        dueDate: "2099-01-11",
        startDate: "2099-01-11",
        endDate: "2099-01-11"
      }
    ];
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext(tasks);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    let operationSignal: AbortSignal | undefined;
    vi.mocked(upsertGoogleCalendarTask)
      .mockRejectedValueOnce({ code: "event_conflict", message: "Google 일정 충돌" })
      .mockImplementationOnce((_task, _timeZone, signal) => {
        operationSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject({ code: "sync_cancelled", message: "기존 일정 동기화를 취소했습니다." });
          }, { once: true });
        });
      });

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(await within(dialog).findByRole("button", { name: "기존 일정 동기화" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledTimes(2));
    await user.click(within(dialog).getByRole("button", { name: "동기화 취소" }));

    await waitFor(() => expect(operationSignal?.aborted).toBe(true));
    const failure = await within(dialog).findByRole("alert");
    expect(failure).toHaveTextContent("1개는 반영하지 못한 상태에서 동기화를 중단했습니다");
    expect(failure).toHaveTextContent("Google 일정 충돌");
    expect(within(dialog).getAllByText("동기화 실패").length).toBeGreaterThan(0);
    expect(reportGoogleCalendarSync).toHaveBeenCalledWith({
      failureCode: "event_conflict",
      status: "failed",
      syncedCount: 0
    });
  });

  it("refreshes an open sync dialog when another tab changes the connection", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      connectionAttemptId: "a".repeat(43),
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced" as const,
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    };
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(connectedStatus);

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 완료" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await waitFor(() => expect(within(dialog).getByText("te***@example.com")).toBeInTheDocument());
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue(googleCalendarTestData.disconnected);

    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(within(dialog).getByText("연결된 계정 없음")).toBeInTheDocument());
    expect(within(dialog).getByText("미동기화")).toBeInTheDocument();
  });

  it("accepts a completed OAuth attempt after its popup follows the return link to schedule", async () => {
    const user = userEvent.setup();
    const connectionAttemptId = "a".repeat(43);
    const connectedStatus = {
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-new",
      connectionAttemptId,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle" as const,
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    };
    vi.mocked(getGoogleCalendarConnectionStatus)
      .mockResolvedValueOnce(googleCalendarTestData.disconnected)
      .mockResolvedValueOnce(googleCalendarTestData.disconnected)
      .mockResolvedValue(connectedStatus);
    vi.mocked(startGoogleCalendarConnection).mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      connectionAttemptId
    });
    const popupState = {
      closed: false,
      close: vi.fn(() => {
        popupState.closed = true;
      }),
      location: {
        href: "about:blank",
        replace: vi.fn(() => {
          popupState.location.href = `${window.location.origin}/schedule`;
        })
      },
      opener: window
    };
    const popup = popupState as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popup);

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(await within(dialog).findByRole("button", { name: "Google 계정 연결" }));

    await waitFor(() => expect(within(dialog).getByText("te***@example.com")).toBeInTheDocument(), { timeout: 2500 });
    expect(popup.close).toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "기존 일정 동기화" })).toBeInTheDocument();
    openSpy.mockRestore();
  });

  it("shows Google authorization cancellation as a neutral notice", async () => {
    const user = userEvent.setup();
    const popupState = {
      closed: false,
      close: vi.fn(() => {
        popupState.closed = true;
      }),
      location: {
        href: "about:blank",
        replace: vi.fn(() => {
          popupState.location.href = `${window.location.origin}/api/google-calendar-auth?result=cancelled`;
        })
      },
      opener: window
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popupState as unknown as Window);

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(within(dialog).getByRole("button", { name: "Google 계정 연결" }));

    expect(await within(dialog).findByText(
      "Google Calendar 연결을 취소했습니다. 기존 일정은 변경되지 않았습니다.",
      {},
      { timeout: 2500 }
    )).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("미동기화").length).toBeGreaterThan(0);
    openSpy.mockRestore();
  });

  it("shows a manually closed Google login popup as a neutral notice", async () => {
    const user = userEvent.setup();
    const popupState = {
      closed: false,
      close: vi.fn(() => {
        popupState.closed = true;
      }),
      location: {
        href: "about:blank",
        replace: vi.fn(() => {
          popupState.closed = true;
        })
      },
      opener: window
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(popupState as unknown as Window);

    renderSchedulePage();
    await user.click(await screen.findByRole("button", { name: "Google Calendar 동기화: 미동기화" }));
    const dialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await user.click(within(dialog).getByRole("button", { name: "Google 계정 연결" }));

    expect(await within(dialog).findByText(
      "Google 로그인 창이 닫혔습니다. 연결하려면 다시 시도해주세요.",
      {},
      { timeout: 2500 }
    )).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    openSpy.mockRestore();
  });

  it("syncs the latest title and date after a normal task edit", async () => {
    const user = userEvent.setup();
    const originalTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    const latestTask = datedScheduleTaskSnapshot("matrix-task-a", "수정된 일정", "2099-01-12");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([originalTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(latestTask);

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog");
    const titleInput = within(editDialog).getByRole("textbox", { name: "제목" });

    await user.clear(titleInput);
    await user.type(titleInput, "수정된 일정");
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "수정된 일정",
      startDate: "2099-01-12",
      endDate: "2099-01-12",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined));
    expect(vi.mocked(updateScheduleTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
  });

  it("does not call Google or re-encrypt the title for a local-only details edit", async () => {
    const user = userEvent.setup();
    const task = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([task]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog");
    const description = within(editDialog).getByRole("textbox", { name: "설명" });

    await user.type(description, "로컬 상세 내용");
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(updateScheduleTask).toHaveBeenCalledWith(
      "matrix-task-a",
      "user-a",
      expect.not.objectContaining({ encryptedTitle: expect.anything() }),
      {
        expectedUpdatedAt: expect.objectContaining({ nanoseconds: 0, seconds: 1_753_142_400 }),
        googleCalendarChanged: false
      }
    ));
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(deleteGoogleCalendarTask).not.toHaveBeenCalled();
  });

  it("keeps the modal open and blocks an edit whose source revision is unresolved", async () => {
    const user = userEvent.setup();
    const task = { ...scheduleTaskSnapshot(), updatedAt: undefined };

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([task]);
      return vi.fn();
    });

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task"))
      .closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" }))
      .getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog", { name: "matrix drag task 수정" });

    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    expect(await within(editDialog).findByRole("alert")).toHaveTextContent("최신 상태를 확인할 수 없습니다");
    expect(updateScheduleTask).not.toHaveBeenCalled();
    expect(reconcileGoogleCalendarTask).not.toHaveBeenCalled();
    expect(editDialog).toBeInTheDocument();
  });

  it("binds an open edit draft to its original revision and preserves it across a live update", async () => {
    const user = userEvent.setup();
    const originalTask = scheduleTaskSnapshot();
    const changedTask: ScheduleTaskSnapshot = {
      ...originalTask,
      dueDate: "2099-01-12",
      startDate: "2099-01-12",
      endDate: "2099-01-12",
      updatedAt: { seconds: 1_753_142_460, nanoseconds: 9 } as ScheduleTaskSnapshot["updatedAt"]
    };
    let emitTasks!: (tasks: ScheduleTaskSnapshot[]) => void;

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      emitTasks = onNext;
      onNext([originalTask]);
      return vi.fn();
    });
    vi.mocked(updateScheduleTask).mockRejectedValueOnce(
      new Error("일정이 다른 곳에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.")
    );

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task"))
      .closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" }))
      .getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog", { name: "matrix drag task 수정" });
    const description = within(editDialog).getByRole("textbox", { name: "설명" });

    await user.type(description, "보존할 편집 내용");
    act(() => emitTasks([changedTask]));
    await waitFor(() => expect(description).toHaveValue("보존할 편집 내용"));
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(updateScheduleTask).toHaveBeenCalledWith(
      "matrix-task-a",
      "user-a",
      expect.objectContaining({
        dueDate: null,
        endDate: null,
        startDate: null
      }),
      {
        expectedUpdatedAt: expect.objectContaining({ nanoseconds: 0, seconds: 1_753_142_400 }),
        googleCalendarChanged: true
      }
    ));
    expect(await within(editDialog).findByRole("alert")).toHaveTextContent("다른 곳에서 변경되었습니다");
    expect(reconcileGoogleCalendarTask).not.toHaveBeenCalled();
    expect(editDialog).toBeInTheDocument();
  });

  it("saves a removed date before deleting the Google event once", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("undated");

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog");
    await user.click(within(editDialog).getByRole("button", { name: "시작일 지우기" }));
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(updateScheduleTask).toHaveBeenCalledWith(
      "matrix-task-a",
      "user-a",
      expect.objectContaining({
        dueDate: null,
        endDate: null,
        startDate: null
      }),
      {
        expectedUpdatedAt: expect.objectContaining({ nanoseconds: 0, seconds: 1_753_142_400 }),
        googleCalendarChanged: true
      }
    ));
    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateScheduleTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0]);
  });

  it("keeps a removed-date reconciliation sticky across a queued edit", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    const undatedTask: ScheduleTaskSnapshot = {
      ...datedTask,
      dueDate: null,
      endDate: null,
      startDate: null,
      encryptedTitle: {
        version: 1,
        algorithm: "AES-GCM",
        cipherText: "plain:날짜 제거된 일정",
        iv: "iv"
      }
    };
    let emitTasks!: (tasks: ScheduleTaskSnapshot[]) => void;
    let rejectFirstDelete!: (reason: unknown) => void;

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      emitTasks = onNext;
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(undatedTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("undated");
    vi.mocked(deleteGoogleCalendarTask)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirstDelete = reject;
      }))
      .mockResolvedValue({ eventId: "event-a", outcome: "deleted", remoteWasPresent: true });

    renderSchedulePage();
    let taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    let editDialog = screen.getByRole("dialog");
    await user.click(within(editDialog).getByRole("button", { name: "시작일 지우기" }));
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledTimes(1));

    act(() => emitTasks([undatedTask]));
    taskOpenButton = (await screen.findByText("날짜 제거된 일정")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "날짜 제거된 일정" })).getByRole("button", { name: "수정" }));
    editDialog = screen.getByRole("dialog");
    const titleInput = within(editDialog).getByRole("textbox", { name: "제목" });

    await user.clear(titleInput);
    await user.type(titleInput, "날짜 제거 후 수정");
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(updateScheduleTask).toHaveBeenCalledTimes(2));
    expect(deleteGoogleCalendarTask).toHaveBeenCalledTimes(1);

    rejectFirstDelete(new GoogleCalendarError("calendar_request_failed", "첫 삭제 실패"));
    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledTimes(2));
    expect(reconcileGoogleCalendarTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "matrix-task-a", startDate: null }),
      "Asia/Seoul",
      undefined,
      undefined,
      expect.objectContaining({ connectionGeneration: "generation-a" })
    );
  });

  it("restores a date another tab adds after the post-save Google deletion", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    const latestTask = datedScheduleTaskSnapshot("matrix-task-a", "다른 창 최신 일정", "2099-01-12");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(latestTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority)
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("current")
      .mockResolvedValueOnce("current");

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog");
    await user.click(within(editDialog).getByRole("button", { name: "시작일 지우기" }));
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    expect(deleteGoogleCalendarTask).not.toHaveBeenCalled();
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "다른 창 최신 일정",
      startDate: "2099-01-12",
      endDate: "2099-01-12",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined));
    expect(vi.mocked(updateScheduleTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0]);
  });

  it("does not touch Google when saving a removed date fails in Firestore", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(updateScheduleTask).mockRejectedValueOnce(new Error("firestore save failed"));

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog");
    await user.click(within(editDialog).getByRole("button", { name: "시작일 지우기" }));
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    expect(await within(editDialog).findByRole("alert")).toHaveTextContent(/firestore save failed/);
    expect(deleteGoogleCalendarTask).not.toHaveBeenCalled();
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
  });

  it("prevents a double save while the Firestore update is pending", async () => {
    const user = userEvent.setup();
    let resolveUpdate!: () => void;
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(updateScheduleTask).mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    }));

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog");
    const saveButton = within(editDialog).getByRole("button", { name: "저장" });

    await user.dblClick(saveButton);

    await waitFor(() => expect(updateScheduleTask).toHaveBeenCalledTimes(1));
    expect(within(editDialog).getByRole("button", { name: "저장 중" })).toBeDisabled();
    resolveUpdate();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("recovers a post-connection task without a durable receipt and records the exact revision", async () => {
    const generation = "g".repeat(43);
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "자동 복구 일정");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(scheduleTaskNeedsGoogleCalendarRecovery).mockReturnValue(true);

    renderSchedulePage();

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "자동 복구 일정",
      startDate: "2099-01-10",
      endDate: "2099-01-10",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", expect.any(AbortSignal)));
    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "matrix-task-a",
      "user-a",
      generation,
      expect.objectContaining({ seconds: 1_753_142_400, nanoseconds: 0 })
    ));
    expect(listGoogleCalendarTaskSyncReceipts).toHaveBeenCalledWith("user-a");
    expect(reportGoogleCalendarSync).toHaveBeenCalledWith({ status: "synced", syncedCount: 1 });
  });

  it("resumes durable recovery immediately when the browser comes back online", async () => {
    const generation = "g".repeat(43);
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(listGoogleCalendarTaskSyncReceipts)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([]);

    renderSchedulePage();

    await waitFor(() => expect(listGoogleCalendarTaskSyncReceipts).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listGoogleCalendarTaskTombstones).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(listGoogleCalendarTaskSyncReceipts).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("keeps a failed recovery task visible across another task success until recovery succeeds", async () => {
    const user = userEvent.setup();
    const generation = "g".repeat(43);
    const recoveryTask = datedScheduleTaskSnapshot("recovery-task-a", "복구 업무 A");

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([recoveryTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(scheduleTaskNeedsGoogleCalendarRecovery).mockReturnValue(true);
    vi.mocked(createScheduleTask).mockResolvedValue({ id: "task-b" } as Awaited<ReturnType<typeof createScheduleTask>>);
    vi.mocked(getScheduleTask).mockImplementation(async (taskId) =>
      taskId === recoveryTask.id
        ? recoveryTask
        : datedScheduleTaskSnapshot(taskId, "신규 업무 B"));
    let recoveryAttempts = 0;
    vi.mocked(upsertGoogleCalendarTask).mockImplementation(async (task) => {
      if (task.id === recoveryTask.id && recoveryAttempts++ === 0) {
        throw new GoogleCalendarError("event_conflict", "복구 업무 A 동기화 실패");
      }
      return { eventId: "event-a", outcome: "updated" };
    });

    renderSchedulePage();

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: recoveryTask.id }),
      "Asia/Seoul",
      expect.any(AbortSignal)
    ));
    await screen.findByRole("button", { name: "Google Calendar 동기화: 동기화 실패" });
    await user.click(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" }));
    const recoveryFailureDialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    expect(await within(recoveryFailureDialog).findByText(/복구 업무 A 동기화 실패/u)).toBeInTheDocument();
    await user.click(within(recoveryFailureDialog).getByRole("button", { name: "Google Calendar 동기화 창 닫기" }));
    vi.mocked(reportGoogleCalendarSync).mockClear();
    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "신규 업무 B");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "task-b",
      "user-a",
      generation,
      expect.any(Object)
    ));
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" })).toBeInTheDocument();
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "synced" }));

    fireEvent(window, new Event("online"));
    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      recoveryTask.id,
      "user-a",
      generation,
      expect.any(Object)
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument());
  });

  it("keeps an unresolved recovery-state read visible until that generation is verified", async () => {
    const user = userEvent.setup();
    const generation = "g".repeat(43);

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(createScheduleTask).mockResolvedValue({ id: "task-b" } as Awaited<ReturnType<typeof createScheduleTask>>);
    vi.mocked(getScheduleTask).mockImplementation(async (taskId) =>
      datedScheduleTaskSnapshot(taskId, "신규 업무 B"));
    vi.mocked(listGoogleCalendarTaskSyncReceipts)
      .mockRejectedValueOnce(new Error("receipt state unavailable"))
      .mockResolvedValue([]);

    renderSchedulePage();

    await waitFor(() => expect(listGoogleCalendarTaskSyncReceipts).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument();
    vi.mocked(reportGoogleCalendarSync).mockClear();

    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "신규 업무 B");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "task-b",
      "user-a",
      generation,
      expect.any(Object)
    ));
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 실패" })).toBeInTheDocument();
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "synced" }));

    fireEvent(window, new Event("online"));
    await waitFor(() => expect(listGoogleCalendarTaskSyncReceipts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument());
  });

  it("drops an unresolved recovery sentinel when another tab replaces the Google connection", async () => {
    const user = userEvent.setup();
    const oldGeneration = "o".repeat(43);
    const newGeneration = "n".repeat(43);
    const connectedStatus = (connectionGeneration: string) => ({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced" as const,
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });

    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus)
      .mockResolvedValueOnce(connectedStatus(oldGeneration))
      .mockResolvedValue(connectedStatus(newGeneration));
    vi.mocked(listGoogleCalendarTaskSyncReceipts)
      .mockRejectedValueOnce(new Error("old generation state unavailable"))
      .mockResolvedValue([]);
    vi.mocked(createScheduleTask).mockResolvedValue({ id: "task-b" } as Awaited<ReturnType<typeof createScheduleTask>>);
    vi.mocked(getScheduleTask).mockImplementation(async (taskId) =>
      datedScheduleTaskSnapshot(taskId, "신규 업무 B"));

    renderSchedulePage();

    await waitFor(() => expect(listGoogleCalendarTaskSyncReceipts).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" }));
    const syncDialog = await screen.findByRole("dialog", { name: "Google Calendar 동기화" });
    await waitFor(() => expect(getGoogleCalendarConnectionStatus).toHaveBeenCalledTimes(2));
    await user.click(within(syncDialog).getByRole("button", { name: "Google Calendar 동기화 창 닫기" }));
    vi.mocked(reportGoogleCalendarSync).mockClear();

    await user.click(screen.getByRole("button", { name: "새 일정" }));
    const createDialog = await screen.findByRole("dialog", { name: "새 일정 추가" });
    await user.type(within(createDialog).getByPlaceholderText("일정 제목"), "신규 업무 B");
    await user.click(createDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);

    await waitFor(() => expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "task-b",
      "user-a",
      newGeneration,
      expect.any(Object)
    ));
    expect(screen.getByRole("button", { name: "Google Calendar 동기화: 동기화 완료" })).toBeInTheDocument();
    expect(reportGoogleCalendarSync).toHaveBeenCalledWith(expect.objectContaining({ status: "synced" }));
  });

  it("loads receipts and deletion protection in parallel and stays fail closed if either read fails", async () => {
    const generation = "g".repeat(43);
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "병렬 복구 확인 일정");
    let rejectReceipts!: (reason: unknown) => void;
    let resolveTombstones!: (value: Awaited<ReturnType<typeof listGoogleCalendarTaskTombstones>>) => void;
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(scheduleTaskNeedsGoogleCalendarRecovery).mockReturnValue(true);
    vi.mocked(listGoogleCalendarTaskSyncReceipts).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectReceipts = reject;
    }));
    vi.mocked(listGoogleCalendarTaskTombstones).mockImplementationOnce(() => new Promise((resolve) => {
      resolveTombstones = resolve;
    }));

    renderSchedulePage();

    await waitFor(() => expect(listGoogleCalendarTaskSyncReceipts).toHaveBeenCalledOnce());
    expect(listGoogleCalendarTaskTombstones).toHaveBeenCalledOnce();
    rejectReceipts(new Error("receipt state unavailable"));
    resolveTombstones([]);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(deleteGoogleCalendarTask).not.toHaveBeenCalled();
    expect(markScheduleTaskGoogleCalendarSynced).not.toHaveBeenCalled();
  });

  it("waits for deletion protection state before recovering a dated task", async () => {
    const generation = "g".repeat(43);
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "보호 상태 재시도 일정");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(scheduleTaskNeedsGoogleCalendarRecovery).mockReturnValue(true);
    vi.mocked(listGoogleCalendarTaskTombstones)
      .mockRejectedValueOnce(new Error("temporary tombstone read failure"))
      .mockResolvedValue([]);

    renderSchedulePage();

    await waitFor(() => expect(listGoogleCalendarTaskTombstones).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(deleteGoogleCalendarTask).not.toHaveBeenCalled();
    expect(markScheduleTaskGoogleCalendarSynced).not.toHaveBeenCalled();
    expect(reportGoogleCalendarSync).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    fireEvent(window, new Event("online"));

    await waitFor(() => expect(listGoogleCalendarTaskTombstones).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "보호 상태 재시도 일정",
      startDate: "2099-01-10",
      endDate: "2099-01-10",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", expect.any(AbortSignal)));
  });

  it("does not cancel or recreate an existing task while another tab's deletion lease is active", async () => {
    const generation = "g".repeat(43);
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "삭제 진행 일정");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(listGoogleCalendarTaskTombstones).mockResolvedValue([{
      connectionGeneration: generation,
      createdAt: { seconds: 1_753_142_400, nanoseconds: 0 } as never,
      deletionAttemptId: "d".repeat(32),
      leaseExpiresAt: { seconds: 9_999_999_999, nanoseconds: 0 } as never,
      ownerUid: "user-a",
      taskId: "matrix-task-a"
    }]);
    vi.mocked(getScheduleTask).mockResolvedValue(datedTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("deleted");

    const view = renderSchedulePage();

    await waitFor(() => expect(inspectGoogleCalendarTaskAuthority).toHaveBeenCalled());
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(cancelGoogleCalendarTaskDeletion).not.toHaveBeenCalled();
    view.unmount();
  });

  it("restores an expired matching deletion tombstone and clears only its attempt", async () => {
    const generation = "g".repeat(43);
    const attemptId = "d".repeat(32);
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "중단 삭제 복구 일정");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(listGoogleCalendarTaskTombstones).mockResolvedValue([{
      connectionGeneration: generation,
      createdAt: { seconds: 1_753_142_400, nanoseconds: 0 } as never,
      deletionAttemptId: attemptId,
      leaseExpiresAt: { seconds: 1_753_142_401, nanoseconds: 0 } as never,
      ownerUid: "user-a",
      taskId: "matrix-task-a"
    }]);
    vi.mocked(getScheduleTask).mockResolvedValue(datedTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("current");

    renderSchedulePage();

    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalled());
    await waitFor(() => expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "matrix-task-a",
      attemptId
    ));
    expect(vi.mocked(markScheduleTaskGoogleCalendarSynced).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(cancelGoogleCalendarTaskDeletion).mock.invocationCallOrder[0]);
  });

  it("finishes an interrupted local deletion before clearing its matching tombstone", async () => {
    const generation = "g".repeat(43);
    const attemptId = "e".repeat(32);
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      connectedAt: "2025-07-21T23:59:59.000Z",
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: generation,
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(listGoogleCalendarTaskTombstones).mockResolvedValue([{
      connectionGeneration: generation,
      createdAt: { seconds: 1_753_142_400, nanoseconds: 0 } as never,
      deletionAttemptId: attemptId,
      leaseExpiresAt: { seconds: 1_753_142_401, nanoseconds: 0 } as never,
      ownerUid: "user-a",
      taskId: "deleted-task"
    }]);
    vi.mocked(getScheduleTask).mockResolvedValue(null);

    renderSchedulePage();

    await waitFor(() => expect(deleteGoogleCalendarTask).toHaveBeenCalledWith(
      { id: "deleted-task", ownerUid: "user-a" },
      expect.any(AbortSignal)
    ));
    await waitFor(() => expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "deleted-task",
      attemptId
    ));
    expect(vi.mocked(deleteGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(cancelGoogleCalendarTaskDeletion).mock.invocationCallOrder[0]);
  });

  it("does not create a previously absent Google event when the protected local delete fails", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(deleteGoogleCalendarTask).mockResolvedValue({
      eventId: "event-a",
      outcome: "deleted",
      remoteWasPresent: false
    });
    vi.mocked(deleteScheduleTask).mockRejectedValueOnce(new Error("local delete failed"));
    vi.mocked(getScheduleTask).mockResolvedValue(datedTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("deleted");

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalled());
    expect(upsertGoogleCalendarTask).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).toBeInTheDocument();
  });

  it("retains the deletion tombstone when the post-delete Google verification fails", async () => {
    const user = userEvent.setup();
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([scheduleTaskSnapshot()]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(deleteGoogleCalendarTask)
      .mockResolvedValueOnce({ eventId: "event-a", outcome: "deleted", remoteWasPresent: true })
      .mockRejectedValueOnce(new GoogleCalendarError(
        "connection_changed",
        "연결된 Google 계정이 변경되었습니다."
      ));
    vi.mocked(inspectGoogleCalendarTaskAuthority).mockResolvedValue("deleted");

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" })).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(deleteScheduleTask).toHaveBeenCalledWith("matrix-task-a"));
    await waitFor(() => expect(screen.getByText(/삭제 보호 상태를 유지하고 연결이 복구되면 다시 확인합니다/)).toBeInTheDocument());
    expect(cancelGoogleCalendarTaskDeletion).not.toHaveBeenCalled();
  });

  it("restores the latest Google event when the protected local delete fails", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    const latestTask = datedScheduleTaskSnapshot("matrix-task-a", "삭제 실패 후 최신 일정", "2099-01-12");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(deleteScheduleTask).mockRejectedValueOnce(new Error("local delete failed"));
    vi.mocked(getScheduleTask).mockResolvedValue(latestTask);
    vi.mocked(inspectGoogleCalendarTaskAuthority)
      .mockResolvedValueOnce("deleted")
      .mockResolvedValueOnce("current")
      .mockResolvedValueOnce("current");

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "삭제" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "이 일정을 삭제할까요?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "일정 삭제" }));

    await waitFor(() => expect(cancelGoogleCalendarTaskDeletion).toHaveBeenCalledWith(
      "user-a",
      "matrix-task-a",
      "a".repeat(32)
    ));
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "matrix-task-a",
      ownerUid: "user-a",
      title: "삭제 실패 후 최신 일정",
      startDate: "2099-01-12",
      endDate: "2099-01-12",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined, expect.objectContaining({
      connectionGeneration: "generation-a",
      workflowLeaseId: "w".repeat(43)
    })));
    expect(vi.mocked(upsertGoogleCalendarTask).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(cancelGoogleCalendarTaskDeletion).mock.invocationCallOrder[0]);
    expect(deleteDialog).toBeInTheDocument();
  });

  it("prevents a duplicate action from creating the same copied task twice", async () => {
    const user = userEvent.setup();
    const datedTask = datedScheduleTaskSnapshot("matrix-task-a", "matrix drag task");
    const copiedTask = datedScheduleTaskSnapshot("copied-task", "matrix drag task");
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([datedTask]);
      return vi.fn();
    });
    vi.mocked(getGoogleCalendarConnectionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      hasStoredConnection: true,
      needsReconnect: false,
      connectionGeneration: "generation-a",
      email: "te***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "synced",
      syncedCount: 1,
      timeZone: "Asia/Seoul"
    });
    vi.mocked(getScheduleTask).mockResolvedValue(copiedTask);
    let resolveCreate!: (value: Awaited<ReturnType<typeof createScheduleTask>>) => void;
    vi.mocked(createScheduleTask).mockImplementationOnce(() => new Promise<Awaited<ReturnType<typeof createScheduleTask>>>((resolve) => {
      resolveCreate = resolve;
    }));

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    const readDialog = await screen.findByRole("dialog", { name: "matrix drag task" });
    const duplicateButton = within(readDialog).getByRole("button", { name: "복사" });

    await user.dblClick(duplicateButton);

    await waitFor(() => expect(createScheduleTask).toHaveBeenCalledTimes(1));
    expect(within(readDialog).getByRole("button", { name: "복사 중" })).toBeDisabled();
    resolveCreate({ id: "copied-task" } as Awaited<ReturnType<typeof createScheduleTask>>);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "matrix drag task" })).not.toBeInTheDocument());
    await waitFor(() => expect(upsertGoogleCalendarTask).toHaveBeenCalledWith({
      id: "copied-task",
      ownerUid: "user-a",
      title: "matrix drag task",
      startDate: "2099-01-10",
      endDate: "2099-01-10",
      startTimeMinutes: null,
      endTimeMinutes: null,
      revision: "001753142400.000000000"
    }, "Asia/Seoul", undefined));
    expect(markScheduleTaskGoogleCalendarSynced).toHaveBeenCalledWith(
      "copied-task",
      "user-a",
      "generation-a",
      expect.objectContaining({ seconds: 1_753_142_400, nanoseconds: 0 })
    );
  });

  it("normalizes a legacy multi-day point task to one date before saving", async () => {
    const user = userEvent.setup();
    const pointTask = {
      ...scheduleTaskSnapshot(),
      dueDate: "2099-01-10",
      dueTimeMinutes: 9 * 60,
      startDate: "2099-01-10",
      endDate: "2099-01-12",
      startTimeMinutes: 9 * 60,
      endTimeMinutes: null
    };
    vi.mocked(subscribeScheduleTasks).mockImplementationOnce((_uid, onNext) => {
      onNext([pointTask]);
      return vi.fn();
    });

    renderSchedulePage();
    const taskOpenButton = (await screen.findByText("matrix drag task")).closest<HTMLButtonElement>(".task-open-button");
    await user.click(taskOpenButton!);
    await user.click(within(await screen.findByRole("dialog", { name: "matrix drag task" })).getByRole("button", { name: "수정" }));
    const editDialog = screen.getByRole("dialog");

    expect(within(editDialog).queryByText("종료일")).not.toBeInTheDocument();
    await user.click(within(editDialog).getByRole("button", { name: "저장" }));

    await waitFor(() => expect(updateScheduleTask).toHaveBeenCalledWith(
      "matrix-task-a",
      "user-a",
      expect.objectContaining({
        dueDate: "2099-01-10",
        endDate: "2099-01-10",
        endTimeMinutes: null,
        startDate: "2099-01-10",
        startTimeMinutes: 9 * 60
      }),
      {
        expectedUpdatedAt: expect.objectContaining({ nanoseconds: 0, seconds: 1_753_142_400 }),
        googleCalendarChanged: true
      }
    ));
  });
});

function testRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}
