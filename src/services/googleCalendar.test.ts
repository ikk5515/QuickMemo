import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginGoogleCalendarDeletionWorkflow,
  GoogleCalendarError,
  buildGoogleCalendarEvent,
  clearGoogleCalendarSession,
  deleteGoogleCalendarTask,
  endGoogleCalendarDeletionWorkflow,
  getGoogleCalendarConnectionStatus,
  getGoogleCalendarTaskAuthority,
  googleCalendarEventId,
  reportGoogleCalendarSync,
  renewGoogleCalendarDeletionWorkflow,
  startGoogleCalendarConnection,
  upsertGoogleCalendarTask
} from "./googleCalendar";
import type { GoogleCalendarTaskInput } from "./googleCalendar";

const firebaseMocks = vi.hoisted(() => {
  const userA = {
    getIdToken: vi.fn(async (forceRefresh = false) => forceRefresh ? "firebase-a-refreshed" : "firebase-a"),
    uid: "user-a"
  };
  const userB = {
    getIdToken: vi.fn(async (forceRefresh = false) => forceRefresh ? "firebase-b-refreshed" : "firebase-b"),
    uid: "user-b"
  };
  const auth: { currentUser: typeof userA | typeof userB | null } = { currentUser: userA };

  return { auth, userA, userB };
});

vi.mock("../lib/firebase", () => ({
  auth: firebaseMocks.auth
}));

const calendarApiBase = "https://www.googleapis.com/calendar/v3";
const generationA = "a".repeat(43);
const generationB = "b".repeat(43);

interface ScenarioOptions {
  authorityResponses?: ResponseFactory[];
  beginOperationResponses?: ResponseFactory[];
  deleteResponses?: ResponseFactory[];
  eventGetResponses?: ResponseFactory[];
  patchResponses?: ResponseFactory[];
  postResponses?: ResponseFactory[];
  statusGenerations?: string[];
  statusResponses?: ResponseFactory[];
  tokenGenerations?: string[];
  tokens?: string[];
  validateResponses?: ResponseFactory[];
}

type ResponseFactory = Response | (() => Response | Promise<Response>);

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) }
  });
}

function emptyResponse(status: number, headers?: HeadersInit) {
  return new Response(null, { status, headers });
}

async function resolveFactory(factory: ResponseFactory | undefined, fallback: () => Response) {
  if (!factory) {
    return fallback();
  }
  return typeof factory === "function" ? factory() : factory;
}

function installScenario(options: ScenarioOptions = {}) {
  const authorities = [...(options.authorityResponses ?? [])];
  const beginOperations = [...(options.beginOperationResponses ?? [])];
  const eventGets = [...(options.eventGetResponses ?? [])];
  const posts = [...(options.postResponses ?? [])];
  const patches = [...(options.patchResponses ?? [])];
  const deletes = [...(options.deleteResponses ?? [])];
  const statusGenerations = [...(options.statusGenerations ?? [generationA])];
  const statusResponses = [...(options.statusResponses ?? [])];
  const tokenGenerations = [...(options.tokenGenerations ?? [generationA])];
  const tokens = [...(options.tokens ?? ["google-token-a"])];
  const validations = [...(options.validateResponses ?? [])];
  const lastValue = <T,>(values: T[], fallback: T) => values.length > 1 ? values.shift() as T : values[0] ?? fallback;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);

    if (url === "/api/google-calendar-connection") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;

      if (body.action === "status") {
        const generation = lastValue(statusGenerations, generationA);
        return resolveFactory(statusResponses.shift(), () => jsonResponse({
          ok: true,
          configured: true,
          connected: true,
          needsReconnect: false,
          connectionGeneration: generation,
          email: "us***@example.com",
          lastSyncAt: null,
          lastSyncStatus: "idle",
          serverTime: "2026-07-22T04:00:00.000Z",
          syncedCount: 0,
          timeZone: "Asia/Seoul"
        }));
      }

      if (body.action === "begin-operation") {
        return resolveFactory(beginOperations.shift(), () => jsonResponse({
          ok: true,
          connectionGeneration: body.connectionGeneration ?? generationA,
          leaseId: "l".repeat(43)
        }));
      }

      if (body.action === "begin-deletion-workflow") {
        return jsonResponse({
          ok: true,
          connectionGeneration: body.connectionGeneration ?? generationA,
          leaseId: "w".repeat(43)
        });
      }

      if (body.action === "renew-deletion-workflow") {
        return jsonResponse({
          ok: true,
          connectionGeneration: body.connectionGeneration ?? generationA,
          leaseId: body.workflowLeaseId ?? "w".repeat(43)
        });
      }

      if (body.action === "end-operation" || body.action === "end-deletion-workflow") {
        return jsonResponse({ ok: true });
      }

      if (body.action === "access-token") {
        const token = lastValue(tokens, "google-token-a");
        const connectionGeneration = lastValue(tokenGenerations, generationA);
        return jsonResponse({
          ok: true,
          accessToken: token,
          connectionGeneration,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        });
      }

      if (body.action === "validate-generation") {
        return resolveFactory(validations.shift(), () => jsonResponse({ ok: true }));
      }

      if (body.action === "task-authority") {
        return resolveFactory(authorities.shift(), () => jsonResponse({ ok: true, state: "current" }));
      }

      return jsonResponse({ ok: true });
    }

    if (url.startsWith(calendarApiBase)) {
      if (init.signal?.aborted) {
        const error = new Error("The request was aborted.");
        error.name = "AbortError";
        throw error;
      }
      const method = init.method ?? "GET";

      if (method === "GET") {
        return resolveFactory(eventGets.shift(), () => emptyResponse(404));
      }
      if (method === "POST") {
        return resolveFactory(posts.shift(), () => jsonResponse({}, 201));
      }
      if (method === "PATCH") {
        return resolveFactory(patches.shift(), () => emptyResponse(204));
      }
      if (method === "DELETE") {
        return resolveFactory(deletes.shift(), () => emptyResponse(204));
      }
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function activeTask(overrides: Partial<GoogleCalendarTaskInput> = {}): GoogleCalendarTaskInput {
  return {
    id: "task-a",
    ownerUid: "user-a",
    title: "회의 준비",
    startDate: "2026-07-22",
    endDate: "2026-07-22",
    startTimeMinutes: null,
    endTimeMinutes: null,
    ...overrides
  };
}

function calendarCalls(fetchMock: ReturnType<typeof installScenario>) {
  return fetchMock.mock.calls
    .map(([input, init]) => ({ url: String(input), init: (init ?? {}) as RequestInit }))
    .filter(({ url }) => url.startsWith(calendarApiBase));
}

function backendActions(fetchMock: ReturnType<typeof installScenario>) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === "/api/google-calendar-connection")
    .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as Record<string, unknown> & {
      action?: string;
    });
}

function quickMemoEvent(eventId: string, etag = '"etag-a"') {
  return {
    id: eventId,
    etag,
    status: "confirmed",
    extendedProperties: {
      private: {
        quickMemoEventId: eventId,
        quickMemoSource: "quickmemo-v1"
      }
    }
  };
}

function quickMemoEventWithRevision(eventId: string, revision: string, etag = '"etag-a"') {
  return {
    ...quickMemoEvent(eventId, etag),
    extendedProperties: {
      private: {
        ...quickMemoEvent(eventId).extendedProperties.private,
        quickMemoRevision: revision
      }
    }
  };
}

async function expectGoogleError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: "GoogleCalendarError",
    code
  } satisfies Partial<GoogleCalendarError>);
}

beforeEach(() => {
  vi.clearAllMocks();
  firebaseMocks.auth.currentUser = firebaseMocks.userA;
  clearGoogleCalendarSession();
});

afterEach(async () => {
  clearGoogleCalendarSession();
  await Promise.resolve();
  vi.unstubAllGlobals();
});

describe("Google Calendar event conversion", () => {
  it.each([
    {
      label: "a single all-day event",
      task: activeTask({ startDate: "2026-07-22", endDate: "2026-07-22" }),
      expectedStart: "2026-07-22",
      expectedEnd: "2026-07-23"
    },
    {
      label: "an inclusive multi-day event",
      task: activeTask({ startDate: "2026-07-22", endDate: "2026-07-25" }),
      expectedStart: "2026-07-22",
      expectedEnd: "2026-07-26"
    },
    {
      label: "the end of a year",
      task: activeTask({ startDate: "2026-12-31", endDate: "2026-12-31" }),
      expectedStart: "2026-12-31",
      expectedEnd: "2027-01-01"
    },
    {
      label: "a leap day",
      task: activeTask({ startDate: "2028-02-28", endDate: "2028-02-29" }),
      expectedStart: "2028-02-28",
      expectedEnd: "2028-03-01"
    }
  ])("converts $label to Google's exclusive all-day end boundary", ({ task, expectedStart, expectedEnd }) => {
    expect(buildGoogleCalendarEvent(task, "Asia/Seoul")).toEqual({
      summary: "회의 준비",
      start: { date: expectedStart },
      end: { date: expectedEnd },
      status: "confirmed",
      visibility: "private"
    });
  });

  it("uses a 30-minute end time when only a start time exists, including midnight rollover", () => {
    expect(buildGoogleCalendarEvent(activeTask({
      startDate: "2026-12-31",
      endDate: "2026-12-31",
      startTimeMinutes: 23 * 60 + 50,
      endTimeMinutes: null
    }), "Asia/Seoul")).toEqual({
      summary: "회의 준비",
      start: { dateTime: "2026-12-31T23:50:00", timeZone: "Asia/Seoul" },
      end: { dateTime: "2027-01-01T00:20:00", timeZone: "Asia/Seoul" },
      status: "confirmed",
      visibility: "private"
    });
  });

  it("ignores a stale later end date when a timed task has no end time", () => {
    expect(buildGoogleCalendarEvent(activeTask({
      startDate: "2026-07-22",
      endDate: "2026-07-25",
      startTimeMinutes: 9 * 60,
      endTimeMinutes: null
    }), "Asia/Seoul")).toEqual({
      summary: "회의 준비",
      start: { dateTime: "2026-07-22T09:00:00", timeZone: "Asia/Seoul" },
      end: { dateTime: "2026-07-22T09:30:00", timeZone: "Asia/Seoul" },
      status: "confirmed",
      visibility: "private"
    });
  });

  it("exports only title/date/time plus fixed private-event policy, never task details", () => {
    const task = {
      ...activeTask({ startTimeMinutes: 9 * 60, endTimeMinutes: 10 * 60 }),
      details: "Google로 전송하면 안 되는 상세 내용",
      checklist: ["비공개 체크리스트"],
      participantUids: ["another-user"]
    } as GoogleCalendarTaskInput;
    const event = buildGoogleCalendarEvent(task, "Asia/Seoul");

    expect(event).toEqual({
      summary: "회의 준비",
      start: { dateTime: "2026-07-22T09:00:00", timeZone: "Asia/Seoul" },
      end: { dateTime: "2026-07-22T10:00:00", timeZone: "Asia/Seoul" },
      status: "confirmed",
      visibility: "private"
    });
    expect(JSON.stringify(event)).not.toContain("상세 내용");
    expect(JSON.stringify(event)).not.toContain("체크리스트");
    expect(JSON.stringify(event)).not.toContain("another-user");
  });

  it("returns null for an undated task so the caller can remove an old Google event", () => {
    expect(buildGoogleCalendarEvent(activeTask({ startDate: null, endDate: null }), "Asia/Seoul")).toBeNull();
  });

  it("creates a stable owner-bound Google event id in the allowed alphabet", async () => {
    const first = await googleCalendarEventId("user-a", "task-a");

    await expect(googleCalendarEventId("user-a", "task-a")).resolves.toBe(first);
    await expect(googleCalendarEventId("user-b", "task-a")).resolves.not.toBe(first);
    await expect(googleCalendarEventId("user-a", "task-b")).resolves.not.toBe(first);
    expect(first).toMatch(/^qm[0-9a-f]{48}$/u);
  });
});

describe("Google Calendar CRUD and conflict handling", () => {
  it("performs GET then POST with a deterministic id and privacy-minimized payload", async () => {
    const fetchMock = installScenario({
      eventGetResponses: [emptyResponse(404)],
      postResponses: [jsonResponse({}, 201)]
    });
    const task = {
      ...activeTask({ id: "task-create" }),
      details: "private details"
    } as GoogleCalendarTaskInput;
    const eventId = await googleCalendarEventId(task.ownerUid, task.id);

    await expect(upsertGoogleCalendarTask(task, "Asia/Seoul")).resolves.toEqual({
      eventId,
      outcome: "created"
    });

    const calls = calendarCalls(fetchMock);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "POST"]);
    const body = JSON.parse(String(calls[1].init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      id: eventId,
      summary: "회의 준비",
      start: { date: "2026-07-22" },
      end: { date: "2026-07-23" },
      status: "confirmed",
      visibility: "private",
      extendedProperties: {
        private: {
          quickMemoEventId: eventId,
          quickMemoSource: "quickmemo-v1"
        }
      }
    });
    expect(JSON.stringify(body)).not.toContain("private details");
    expect(JSON.stringify(body)).not.toContain(task.ownerUid);
    const actions = backendActions(fetchMock);
    expect(actions.map(({ action }) => action)).toEqual([
      "status",
      "begin-operation",
      "access-token",
      "validate-generation",
      "end-operation"
    ]);
    expect(actions.find(({ action }) => action === "access-token")).toMatchObject({
      connectionGeneration: generationA,
      operationLeaseId: "l".repeat(43)
    });
    expect(actions.find(({ action }) => action === "validate-generation")).toMatchObject({
      connectionGeneration: generationA,
      operationLeaseId: "l".repeat(43)
    });
  });

  it("waits for another tab's account operation lease before calling Google", async () => {
    const fetchMock = installScenario({
      beginOperationResponses: [
        jsonResponse({ ok: false, error: "google_operation_in_progress" }, 409),
        jsonResponse({
          ok: true,
          connectionGeneration: generationA,
          leaseId: "l".repeat(43)
        })
      ],
      eventGetResponses: [emptyResponse(404)],
      postResponses: [emptyResponse(201)]
    });

    await expect(upsertGoogleCalendarTask(
      activeTask({ id: "task-lease-conflict" }),
      "Asia/Seoul"
    )).resolves.toMatchObject({ outcome: "created" });
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "POST"]);
    expect(backendActions(fetchMock).filter(({ action }) => action === "begin-operation")).toHaveLength(2);
  });

  it("waits beyond one full Google request timeout for another tab to release its lease", async () => {
    vi.useFakeTimers();
    try {
      const conflicts = Array.from({ length: 25 }, () =>
        jsonResponse({ ok: false, error: "google_operation_in_progress" }, 409));
      const fetchMock = installScenario({
        beginOperationResponses: [
          ...conflicts,
          jsonResponse({
            ok: true,
            connectionGeneration: generationA,
            leaseId: "l".repeat(43)
          })
        ],
        eventGetResponses: [emptyResponse(404)],
        postResponses: [emptyResponse(201)]
      });
      const operation = upsertGoogleCalendarTask(
        activeTask({ id: "task-long-lease-conflict" }),
        "Asia/Seoul"
      );

      await vi.advanceTimersByTimeAsync(0);
      for (let second = 0; second < 25; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await expect(operation).resolves.toMatchObject({ outcome: "created" });
      expect(backendActions(fetchMock).filter(({ action }) => action === "begin-operation")).toHaveLength(26);
    } finally {
      vi.useRealTimers();
    }
  });

  it("performs GET then PATCH with If-Match only for its own marked event", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-update");
    const fetchMock = installScenario({
      eventGetResponses: [jsonResponse(quickMemoEvent(eventId, '"etag-update"'))],
      patchResponses: [emptyResponse(204)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({ id: "task-update", title: "수정된 제목" }), "Asia/Seoul"))
      .resolves.toEqual({ eventId, outcome: "updated" });

    const calls = calendarCalls(fetchMock);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(new Headers(calls[1].init.headers).get("if-match")).toBe('"etag-update"');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      summary: "수정된 제목",
      start: { date: "2026-07-22" },
      end: { date: "2026-07-23" },
      status: "confirmed",
      visibility: "private",
      extendedProperties: {
        private: {
          quickMemoEventId: eventId,
          quickMemoSource: "quickmemo-v1"
        }
      }
    });
  });

  it("skips an older QuickMemo revision instead of overwriting the newer Google event", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-stale-revision");
    const newerEvent = {
      ...quickMemoEvent(eventId, '"etag-newer"'),
      extendedProperties: {
        private: {
          ...quickMemoEvent(eventId).extendedProperties.private,
          quickMemoRevision: "001753142401.000000000"
        }
      }
    };
    const fetchMock = installScenario({ eventGetResponses: [jsonResponse(newerEvent)] });

    await expect(upsertGoogleCalendarTask(activeTask({
      id: "task-stale-revision",
      revision: "001753142400.999999999"
    }), "Asia/Seoul")).resolves.toEqual({ eventId, outcome: "skipped" });

    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
  });

  it("skips an already synchronized QuickMemo revision without another PATCH", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-current-revision");
    const revision = "001753142401.000000000";
    const currentEvent = {
      ...quickMemoEvent(eventId, '"etag-current"'),
      extendedProperties: {
        private: {
          ...quickMemoEvent(eventId).extendedProperties.private,
          quickMemoRevision: revision
        }
      }
    };
    const fetchMock = installScenario({ eventGetResponses: [jsonResponse(currentEvent)] });

    await expect(upsertGoogleCalendarTask(activeTask({
      id: "task-current-revision",
      revision
    }), "Asia/Seoul")).resolves.toEqual({ eventId, outcome: "skipped" });

    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
  });

  it("restores the QuickMemo marker when Google returns a stripped cancelled event", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-restore");
    const fetchMock = installScenario({
      eventGetResponses: [jsonResponse({ id: eventId, etag: '"etag-cancelled"', status: "cancelled" })],
      patchResponses: [emptyResponse(204)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({ id: "task-restore" }), "Asia/Seoul"))
      .resolves.toEqual({ eventId, outcome: "updated" });

    const calls = calendarCalls(fetchMock);
    expect(new Headers(calls[1].init.headers).get("if-match")).toBe('"etag-cancelled"');
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({
      status: "confirmed",
      extendedProperties: {
        private: {
          quickMemoEventId: eventId,
          quickMemoSource: "quickmemo-v1"
        }
      }
    });
  });

  it("restores a cancelled QuickMemo event even when its revision is already equal", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-restore-equal-revision");
    const revision = "001753142401.000000000";
    const fetchMock = installScenario({
      eventGetResponses: [jsonResponse({
        ...quickMemoEventWithRevision(eventId, revision, '"etag-cancelled-equal"'),
        status: "cancelled"
      })],
      patchResponses: [emptyResponse(204)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({
      id: "task-restore-equal-revision",
      revision
    }), "Asia/Seoul")).resolves.toEqual({ eventId, outcome: "updated" });

    const calls = calendarCalls(fetchMock);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "PATCH"]);
    expect(new Headers(calls[1].init.headers).get("if-match")).toBe('"etag-cancelled-equal"');
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({
      status: "confirmed",
      extendedProperties: {
        private: {
          quickMemoEventId: eventId,
          quickMemoRevision: revision,
          quickMemoSource: "quickmemo-v1"
        }
      }
    });
  });

  it("does not restore a cancelled event from a stale QuickMemo revision", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-cancelled-newer-revision");
    const fetchMock = installScenario({
      eventGetResponses: [jsonResponse({
        ...quickMemoEventWithRevision(
          eventId,
          "001753142402.000000000",
          '"etag-cancelled-newer"'
        ),
        status: "cancelled"
      })]
    });

    await expect(upsertGoogleCalendarTask(activeTask({
      id: "task-cancelled-newer-revision",
      revision: "001753142401.000000000"
    }), "Asia/Seoul")).resolves.toEqual({ eventId, outcome: "skipped" });
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
  });

  it("never overwrites a foreign private marker on a cancelled event", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-cancelled-foreign");
    const fetchMock = installScenario({
      eventGetResponses: [jsonResponse({
        id: eventId,
        etag: '"etag-cancelled-foreign"',
        status: "cancelled",
        extendedProperties: {
          private: {
            quickMemoEventId: "another-event",
            quickMemoSource: "quickmemo-v1"
          }
        }
      })]
    });

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ id: "task-cancelled-foreign" }), "Asia/Seoul"),
      "event_conflict"
    );
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
  });

  it("rejects an existing event whose QuickMemo marker does not match", async () => {
    const fetchMock = installScenario({
      eventGetResponses: [jsonResponse({
        status: "confirmed",
        extendedProperties: {
          private: { quickMemoEventId: "someone-else", quickMemoSource: "quickmemo-v1" }
        }
      })]
    });

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ id: "task-marker-conflict" }), "Asia/Seoul"),
      "event_conflict"
    );
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
  });

  it("recovers a POST 409 only when the raced event has the exact QuickMemo marker", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-race");
    const fetchMock = installScenario({
      eventGetResponses: [emptyResponse(404), jsonResponse(quickMemoEvent(eventId, '"etag-race"'))],
      postResponses: [emptyResponse(409)],
      patchResponses: [emptyResponse(204)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({ id: "task-race" }), "Asia/Seoul"))
      .resolves.toEqual({ eventId, outcome: "updated" });
    const calls = calendarCalls(fetchMock);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET", "PATCH"]);
    expect(new Headers(calls[3].init.headers).get("if-match")).toBe('"etag-race"');
  });

  it("does not claim a POST 409 event with a missing or foreign marker", async () => {
    const fetchMock = installScenario({
      eventGetResponses: [emptyResponse(404), jsonResponse({ status: "confirmed" })],
      postResponses: [emptyResponse(409)]
    });

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ id: "task-race-foreign" }), "Asia/Seoul"),
      "event_conflict"
    );
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("surfaces PATCH 412 as a non-retryable event conflict", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-precondition");
    installScenario({
      eventGetResponses: [jsonResponse(quickMemoEvent(eventId))],
      patchResponses: [emptyResponse(412)]
    });

    const promise = upsertGoogleCalendarTask(activeTask({ id: "task-precondition" }), "Asia/Seoul");
    await expect(promise).rejects.toMatchObject({
      code: "event_conflict",
      retryable: false
    });
  });

  it("re-reads and patches with the latest ETag after a valid revision PATCH conflict", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-precondition-retry");
    const fetchMock = installScenario({
      eventGetResponses: [
        jsonResponse(quickMemoEventWithRevision(eventId, "001753142400.000000000", '"etag-before"')),
        jsonResponse(quickMemoEventWithRevision(eventId, "001753142401.000000000", '"etag-latest"'))
      ],
      patchResponses: [emptyResponse(412), emptyResponse(204)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({
      id: "task-precondition-retry",
      revision: "001753142402.000000000"
    }), "Asia/Seoul")).resolves.toEqual({ eventId, outcome: "updated" });

    const calls = calendarCalls(fetchMock);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
    expect(new Headers(calls[1].init.headers).get("if-match")).toBe('"etag-before"');
    expect(new Headers(calls[3].init.headers).get("if-match")).toBe('"etag-latest"');
    expect(JSON.parse(String(calls[3].init.body))).toMatchObject({
      extendedProperties: {
        private: { quickMemoRevision: "001753142402.000000000" }
      }
    });
  });

  it("skips a conflicted PATCH when the re-read Google event has a newer revision", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-precondition-newer");
    const fetchMock = installScenario({
      eventGetResponses: [
        jsonResponse(quickMemoEventWithRevision(eventId, "001753142400.000000000", '"etag-before"')),
        jsonResponse(quickMemoEventWithRevision(eventId, "001753142403.000000000", '"etag-newer"'))
      ],
      patchResponses: [emptyResponse(412)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({
      id: "task-precondition-newer",
      revision: "001753142402.000000000"
    }), "Asia/Seoul")).resolves.toEqual({ eventId, outcome: "skipped" });

    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "PATCH", "GET"]);
  });

  it("rejects a conflicted PATCH when the re-read event no longer belongs to QuickMemo", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-precondition-foreign");
    const fetchMock = installScenario({
      eventGetResponses: [
        jsonResponse(quickMemoEventWithRevision(eventId, "001753142400.000000000", '"etag-before"')),
        jsonResponse({
          ...quickMemoEvent(eventId, '"etag-foreign"'),
          extendedProperties: {
            private: {
              quickMemoEventId: "another-event",
              quickMemoSource: "quickmemo-v1",
              quickMemoRevision: "001753142401.000000000"
            }
          }
        })
      ],
      patchResponses: [emptyResponse(412)]
    });

    await expectGoogleError(upsertGoogleCalendarTask(activeTask({
      id: "task-precondition-foreign",
      revision: "001753142402.000000000"
    }), "Asia/Seoul"), "event_conflict");

    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "PATCH", "GET"]);
  });

  it("refreshes a brokered access token once after a Google 401 and retries the same GET", async () => {
    const fetchMock = installScenario({
      eventGetResponses: [emptyResponse(401), emptyResponse(404)],
      postResponses: [emptyResponse(201)],
      tokens: ["google-token-old", "google-token-new"]
    });

    await expect(upsertGoogleCalendarTask(activeTask({ id: "task-401" }), "Asia/Seoul"))
      .resolves.toMatchObject({ outcome: "created" });

    expect(backendActions(fetchMock).filter(({ action }) => action === "access-token")).toHaveLength(2);
    const calls = calendarCalls(fetchMock);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "GET", "POST"]);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer google-token-old");
    expect(new Headers(calls[1].init.headers).get("authorization")).toBe("Bearer google-token-new");
  });

  it("requires reconnection when Google still returns 401 after one token refresh", async () => {
    const fetchMock = installScenario({
      eventGetResponses: [emptyResponse(401), emptyResponse(401)],
      tokens: ["google-token-old", "google-token-new"]
    });

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ id: "task-permanent-401" }), "Asia/Seoul"),
      "reauthorization_required"
    );

    expect(backendActions(fetchMock).filter(({ action }) => action === "access-token")).toHaveLength(2);
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "GET"]);
  });

  it("classifies a Google 403 quota reason as retryable rate limiting", async () => {
    installScenario({
      eventGetResponses: [jsonResponse({
        error: { errors: [{ reason: "userRateLimitExceeded" }] }
      }, 403, { "retry-after": "3" })]
    });

    await expect(upsertGoogleCalendarTask(activeTask({ id: "task-rate" }), "Asia/Seoul"))
      .rejects.toMatchObject({
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 3000
      });
  });

  it("treats a non-quota Google 403 as a non-retryable permission failure", async () => {
    installScenario({
      eventGetResponses: [jsonResponse({
        error: { errors: [{ reason: "insufficientPermissions" }] }
      }, 403)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({ id: "task-permission" }), "Asia/Seoul"))
      .rejects.toMatchObject({
        code: "permission_denied",
        retryable: false
      });
  });

  it("deletes the marked event with its ETag when an existing task loses its date", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-undated");
    const fetchMock = installScenario({
      eventGetResponses: [jsonResponse(quickMemoEvent(eventId, '"etag-delete"'))],
      deleteResponses: [emptyResponse(204)]
    });

    await expect(upsertGoogleCalendarTask(activeTask({
      id: "task-undated",
      startDate: null,
      endDate: null
    }), "Asia/Seoul")).resolves.toEqual({ eventId, outcome: "deleted", remoteWasPresent: true });

    const calls = calendarCalls(fetchMock);
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "DELETE"]);
    expect(new Headers(calls[1].init.headers).get("if-match")).toBe('"etag-delete"');
  });

  it("treats explicit delete of an already missing event as idempotent success", async () => {
    const fetchMock = installScenario({ eventGetResponses: [emptyResponse(404)] });

    await expect(deleteGoogleCalendarTask({ id: "task-missing", ownerUid: "user-a" }))
      .resolves.toMatchObject({ outcome: "deleted", remoteWasPresent: false });
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
  });

  it("confirms an ambiguous DELETE as success when the event is already gone", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-ambiguous-delete");
    const fetchMock = installScenario({
      eventGetResponses: [
        jsonResponse(quickMemoEvent(eventId, '"etag-ambiguous"')),
        emptyResponse(404)
      ],
      deleteResponses: [() => Promise.reject(new TypeError("response lost"))]
    });

    await expect(deleteGoogleCalendarTask({ id: "task-ambiguous-delete", ownerUid: "user-a" }))
      .resolves.toEqual({ eventId, outcome: "deleted", remoteWasPresent: true });
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("marks a DELETE as ambiguous when the response and all absence checks are lost", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-unknown-delete");
    const lostResponse = () => Promise.reject(new TypeError("network unavailable"));
    installScenario({
      eventGetResponses: [
        jsonResponse(quickMemoEvent(eventId, '"etag-unknown"')),
        lostResponse,
        lostResponse,
        lostResponse
      ],
      deleteResponses: [lostResponse]
    });

    await expect(deleteGoogleCalendarTask({ id: "task-unknown-delete", ownerUid: "user-a" }))
      .rejects.toMatchObject({
        code: "network_error",
        mutationMayHaveApplied: true,
        retryable: true
      });
  });

  it("preserves DELETE ambiguity when the absence check detects an account change", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-changed-delete");
    installScenario({
      deleteResponses: [() => Promise.reject(new TypeError("delete response lost"))],
      eventGetResponses: [jsonResponse(quickMemoEvent(eventId, '"etag-changed"'))],
      validateResponses: [
        jsonResponse({ ok: true }),
        jsonResponse({ error: "google_connection_changed" }, 409)
      ]
    });

    await expect(deleteGoogleCalendarTask({ id: "task-changed-delete", ownerUid: "user-a" }))
      .rejects.toMatchObject({
        code: "connection_changed",
        mutationMayHaveApplied: true
      });
  });
});

describe("Google Calendar account and operation race guards", () => {
  it("accepts only the official Google authorization host with a correlated attempt id", async () => {
    const connectionAttemptId = "a".repeat(43);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=safe",
        connectionAttemptId
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(startGoogleCalendarConnection("Asia/Seoul")).resolves.toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=safe",
      connectionAttemptId
    });
    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toBe("/api/google-calendar-auth");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      action: "start",
      browserTimeZone: "Asia/Seoul"
    });
  });

  it("blocks an authorization URL outside Google's exact login host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      authorizationUrl: "https://accounts.google.com.attacker.example/o/oauth2/v2/auth",
      connectionAttemptId: "a".repeat(43)
    })));

    await expectGoogleError(startGoogleCalendarConnection("Asia/Seoul"), "invalid_auth_response");
  });

  it("rejects another QuickMemo user's task before any token or Google request", async () => {
    const fetchMock = installScenario();

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ ownerUid: "user-b" }), "Asia/Seoul"),
      "permission_denied"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firebaseMocks.userA.getIdToken).not.toHaveBeenCalled();
  });

  it("asks the authenticated backend for server-clock task authority", async () => {
    const fetchMock = installScenario({
      authorityResponses: [jsonResponse({ ok: true, state: "stale" })]
    });

    await expect(getGoogleCalendarTaskAuthority({
      id: "task-a",
      ownerUid: "user-a",
      revision: "001753142400.000000007"
    })).resolves.toBe("stale");
    expect(backendActions(fetchMock).find(({ action }) => action === "task-authority")).toEqual({
      action: "task-authority",
      taskId: "task-a",
      revision: "001753142400.000000007"
    });
  });

  it("fails closed for malformed or cross-user authority responses", async () => {
    installScenario({
      authorityResponses: [jsonResponse({ ok: true, state: "unexpected" })]
    });

    await expectGoogleError(getGoogleCalendarTaskAuthority({
      id: "task-a",
      ownerUid: "user-a",
      revision: null
    }), "invalid_auth_response");

    const fetchMock = installScenario();
    await expectGoogleError(getGoogleCalendarTaskAuthority({
      id: "task-a",
      ownerUid: "user-b",
      revision: null
    }), "permission_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a malformed stored connection generation as requiring reconnection", async () => {
    installScenario({ statusGenerations: ["legacy-generation"] });

    await expect(getGoogleCalendarConnectionStatus()).resolves.toMatchObject({
      connected: false,
      connectionGeneration: null,
      hasStoredConnection: true,
      lastSyncStatus: "failed",
      needsReconnect: true
    });
  });

  it("preserves the authenticated backend time used for Firestore deletion leases", async () => {
    installScenario();

    await expect(getGoogleCalendarConnectionStatus()).resolves.toMatchObject({
      serverTime: "2026-07-22T04:00:00.000Z"
    });
  });

  it("holds and releases a server workflow lease around a composite task deletion", async () => {
    const fetchMock = installScenario();

    const workflow = await beginGoogleCalendarDeletionWorkflow("user-a", generationA);
    await renewGoogleCalendarDeletionWorkflow(workflow);
    await endGoogleCalendarDeletionWorkflow(workflow);

    expect(workflow).toEqual({
      connectionGeneration: generationA,
      ownerUid: "user-a",
      workflowLeaseId: "w".repeat(43)
    });
    expect(backendActions(fetchMock).filter(({ action }) =>
      action === "begin-deletion-workflow"
        || action === "renew-deletion-workflow"
        || action === "end-deletion-workflow"
    ).map(({ action }) => action)).toEqual([
      "begin-deletion-workflow",
      "renew-deletion-workflow",
      "end-deletion-workflow"
    ]);
  });

  it("binds a task delete operation to the active server workflow lease", async () => {
    const fetchMock = installScenario({ eventGetResponses: [emptyResponse(404)] });
    const workflow = await beginGoogleCalendarDeletionWorkflow("user-a", generationA);

    await expect(deleteGoogleCalendarTask(
      { id: "task-workflow-delete", ownerUid: "user-a" },
      undefined,
      workflow
    )).resolves.toMatchObject({ outcome: "deleted", remoteWasPresent: false });

    const beginOperation = backendActions(fetchMock).find(({ action }) => action === "begin-operation");
    expect(beginOperation).toMatchObject({
      connectionGeneration: generationA,
      deletionWorkflowLeaseId: "w".repeat(43)
    });
  });

  it("binds a deletion rollback upsert to the same server workflow lease", async () => {
    const fetchMock = installScenario({ eventGetResponses: [emptyResponse(404)] });
    const workflow = await beginGoogleCalendarDeletionWorkflow("user-a", generationA);

    await expect(upsertGoogleCalendarTask(
      activeTask({ id: "task-workflow-restore" }),
      "Asia/Seoul",
      undefined,
      workflow
    )).resolves.toMatchObject({ outcome: "created" });

    const beginOperation = backendActions(fetchMock).find(({ action }) => action === "begin-operation");
    expect(beginOperation).toMatchObject({
      connectionGeneration: generationA,
      deletionWorkflowLeaseId: "w".repeat(43)
    });
  });

  it("does not retry a stale unbound mutation after another tab starts task deletion", async () => {
    const fetchMock = installScenario({
      beginOperationResponses: [jsonResponse({
        error: "google_deletion_workflow_in_progress"
      }, 409)]
    });

    await expect(upsertGoogleCalendarTask(
      activeTask({ id: "task-stale-during-delete" }),
      "Asia/Seoul"
    )).rejects.toMatchObject({
      code: "deletion_in_progress",
      retryable: false
    });
    expect(backendActions(fetchMock).filter(({ action }) => action === "begin-operation"))
      .toHaveLength(1);
    expect(calendarCalls(fetchMock)).toHaveLength(0);
  });

  it("serializes status reads so a caller never receives an older overlapping response", async () => {
    let resolveFirstStatus: ((response: Response) => void) | undefined;
    const firstStatus = new Promise<Response>((resolve) => {
      resolveFirstStatus = resolve;
    });
    const statusResponse = (connectionGeneration: string) => jsonResponse({
      ok: true,
      configured: true,
      connected: true,
      needsReconnect: false,
      connectionGeneration,
      email: "us***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    });
    const fetchMock = installScenario({
      statusGenerations: [generationA, generationB],
      statusResponses: [() => firstStatus, statusResponse(generationB)]
    });

    const firstRequest = getGoogleCalendarConnectionStatus();
    await vi.waitFor(() => expect(
      backendActions(fetchMock).filter(({ action }) => action === "status")
    ).toHaveLength(1));
    const secondRequest = getGoogleCalendarConnectionStatus();
    await Promise.resolve();
    expect(backendActions(fetchMock).filter(({ action }) => action === "status")).toHaveLength(1);

    resolveFirstStatus?.(statusResponse(generationA));
    await expect(firstRequest).resolves.toMatchObject({ connectionGeneration: generationA });
    await expect(secondRequest).resolves.toMatchObject({
      connected: true,
      connectionGeneration: generationB
    });

    await reportGoogleCalendarSync({ status: "synced", syncedCount: 1 });
    const report = backendActions(fetchMock).find(({ action }) => action === "report");
    expect(report?.connectionGeneration).toBe(generationB);
    expect(report).not.toHaveProperty("reportSequence");
  });

  it("cancels a queued status read immediately without breaking serialization", async () => {
    let resolveFirstStatus: ((response: Response) => void) | undefined;
    const firstStatus = new Promise<Response>((resolve) => {
      resolveFirstStatus = resolve;
    });
    const fetchMock = installScenario({
      statusResponses: [() => firstStatus]
    });
    const firstRequest = getGoogleCalendarConnectionStatus();

    await vi.waitFor(() => expect(
      backendActions(fetchMock).filter(({ action }) => action === "status")
    ).toHaveLength(1));
    const controller = new AbortController();
    const cancelledRequest = getGoogleCalendarConnectionStatus(controller.signal);

    controller.abort();
    await expectGoogleError(cancelledRequest, "sync_cancelled");
    expect(backendActions(fetchMock).filter(({ action }) => action === "status")).toHaveLength(1);

    resolveFirstStatus?.(jsonResponse({
      ok: true,
      configured: true,
      connected: true,
      needsReconnect: false,
      connectionGeneration: generationA,
      email: "us***@example.com",
      lastSyncAt: null,
      lastSyncStatus: "idle",
      syncedCount: 0,
      timeZone: "Asia/Seoul"
    }));
    await expect(firstRequest).resolves.toMatchObject({ connectionGeneration: generationA });
  });

  it("rejects an access token issued for a different connection generation", async () => {
    const fetchMock = installScenario({ tokenGenerations: [generationB] });

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ id: "task-token-generation" }), "Asia/Seoul"),
      "connection_changed"
    );
    expect(calendarCalls(fetchMock)).toHaveLength(0);
  });

  it("revalidates a cached token generation before a Google mutation", async () => {
    const fetchMock = installScenario({
      eventGetResponses: [emptyResponse(404)],
      validateResponses: [jsonResponse({ error: "google_connection_changed" }, 409)]
    });

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ id: "task-generation-before-write" }), "Asia/Seoul"),
      "connection_changed"
    );

    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
    expect(backendActions(fetchMock).filter(({ action }) => action === "validate-generation")).toHaveLength(1);
  });

  it("maps an aborted bulk-sync request to sync_cancelled before any Google mutation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = installScenario();

    await expectGoogleError(
      upsertGoogleCalendarTask(activeTask({ id: "task-aborted" }), "Asia/Seoul", controller.signal),
      "sync_cancelled"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(firebaseMocks.userA.getIdToken).not.toHaveBeenCalled();
  });

  it("aborts an in-flight backend status request when bulk sync is cancelled", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;

      if (!signal) {
        reject(new Error("Expected a backend AbortSignal"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const operation = upsertGoogleCalendarTask(
      activeTask({ id: "task-aborted-backend" }),
      "Asia/Seoul",
      controller.signal
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/google-calendar-connection");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(requestInit?.signal?.aborted).toBe(false);

    controller.abort();
    await expectGoogleError(operation, "sync_cancelled");
  });

  it("fails a stalled backend request with a retryable timeout instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      }));
      vi.stubGlobal("fetch", fetchMock);

      const operation = getGoogleCalendarConnectionStatus();
      const rejection = expect(operation).rejects.toMatchObject({
        name: "GoogleCalendarError",
        code: "network_error",
        retryable: true
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a stalled Google Calendar request with a retryable timeout instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = installScenario({
        eventGetResponses: [() => new Promise<Response>((_resolve, reject) => {
          const calendarCall = calendarCalls(fetchMock).at(-1);

          calendarCall?.init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })]
      });
      const operation = upsertGoogleCalendarTask(
        activeTask({ id: "task-google-timeout" }),
        "Asia/Seoul"
      );
      const rejection = expect(operation).rejects.toMatchObject({
        name: "GoogleCalendarError",
        code: "network_error",
        retryable: true
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(calendarCalls(fetchMock)).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the Google timeout active until a stalled response body finishes", async () => {
    vi.useFakeTimers();
    try {
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const fetchMock = installScenario({
        eventGetResponses: [() => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })]
      });
      const operation = upsertGoogleCalendarTask(
        activeTask({ id: "task-google-body-timeout" }),
        "Asia/Seoul"
      );
      const rejection = expect(operation).rejects.toMatchObject({
        name: "GoogleCalendarError",
        code: "network_error",
        retryable: true
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(calendarCalls(fetchMock)).toHaveLength(1));
      const signal = calendarCalls(fetchMock)[0].init.signal;
      signal?.addEventListener("abort", () => {
        bodyController?.error(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight Google request when the Calendar session is invalidated", async () => {
    let googleSignal: AbortSignal | undefined;
    const fetchMock = installScenario({
      eventGetResponses: [() => new Promise<Response>((_resolve, reject) => {
        googleSignal = calendarCalls(fetchMock).at(-1)?.init.signal ?? undefined;
        googleSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      })]
    });
    const operation = upsertGoogleCalendarTask(
      activeTask({ id: "task-session-invalidated" }),
      "Asia/Seoul"
    );

    await vi.waitFor(() => expect(calendarCalls(fetchMock)).toHaveLength(1));
    clearGoogleCalendarSession();

    await expectGoogleError(operation, "connection_changed");
    expect(googleSignal?.aborted).toBe(true);
  });

  it("serializes writes for different events under one QuickMemo account lease", async () => {
    const secondEventId = await googleCalendarEventId("user-a", "task-queued-b");
    let resolveFirstGet: ((response: Response) => void) | undefined;
    const firstGet = new Promise<Response>((resolve) => {
      resolveFirstGet = resolve;
    });
    const fetchMock = installScenario({
      eventGetResponses: [
        () => firstGet,
        jsonResponse(quickMemoEvent(secondEventId, '"etag-second"'))
      ],
      postResponses: [emptyResponse(201)],
      patchResponses: [emptyResponse(204)]
    });

    const first = upsertGoogleCalendarTask(activeTask({ id: "task-queued-a", title: "첫 번째 제목" }), "Asia/Seoul");
    await vi.waitFor(() => expect(calendarCalls(fetchMock)).toHaveLength(1));
    const second = upsertGoogleCalendarTask(activeTask({ id: "task-queued-b", title: "두 번째 제목" }), "Asia/Seoul");
    await Promise.resolve();
    expect(calendarCalls(fetchMock)).toHaveLength(1);

    resolveFirstGet?.(emptyResponse(404));
    await expect(first).resolves.toMatchObject({ outcome: "created" });
    await expect(second).resolves.toMatchObject({ outcome: "updated" });
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "POST", "GET", "PATCH"]);
  });

  it("invalidates a queued write when the connection generation changes before it runs", async () => {
    const eventId = await googleCalendarEventId("user-a", "task-generation-queue");
    let resolveFirstGet: ((response: Response) => void) | undefined;
    const firstGet = new Promise<Response>((resolve) => {
      resolveFirstGet = resolve;
    });
    const fetchMock = installScenario({
      statusGenerations: [generationA, generationB],
      eventGetResponses: [() => firstGet],
      postResponses: [emptyResponse(201)]
    });

    const first = upsertGoogleCalendarTask(activeTask({ id: "task-generation-queue" }), "Asia/Seoul");
    await vi.waitFor(() => expect(calendarCalls(fetchMock)).toHaveLength(1));
    const second = upsertGoogleCalendarTask(activeTask({ id: "task-generation-queue" }), "Asia/Seoul");
    resolveFirstGet?.(emptyResponse(404));

    await expect(first).resolves.toEqual({ eventId, outcome: "created" });
    await expectGoogleError(second, "connection_changed");
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET", "POST"]);
  });

  it("blocks a late Google write when the signed-in QuickMemo UID changes during a request", async () => {
    let resolveGet: ((response: Response) => void) | undefined;
    const pendingGet = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });
    const fetchMock = installScenario({ eventGetResponses: [() => pendingGet] });
    const operation = upsertGoogleCalendarTask(activeTask({ id: "task-user-switch" }), "Asia/Seoul");

    await vi.waitFor(() => expect(calendarCalls(fetchMock)).toHaveLength(1));
    firebaseMocks.auth.currentUser = firebaseMocks.userB;
    resolveGet?.(emptyResponse(404));

    await expectGoogleError(operation, "login_required");
    expect(calendarCalls(fetchMock).map(({ init }) => init.method)).toEqual(["GET"]);
  });
});
