import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DailyNotesCalendar } from "./DailyNotesCalendar";

describe("DailyNotesCalendar", () => {
  it("uses an ARIA row grid with one keyboard tab stop", async () => {
    const onOpenDate = vi.fn();
    const { container } = render(
      <DailyNotesCalendar
        cursorMonth="2026-08"
        noteDates={new Set(["2026-08-22"])}
        onCursorMonthChange={vi.fn()}
        onOpenDate={onOpenDate}
      />
    );

    const grid = container.querySelector<HTMLElement>('[role="grid"]');
    expect(grid).toHaveAttribute("aria-colcount", "7");
    expect(grid?.querySelectorAll('[role="row"]')).toHaveLength(6);
    expect(grid?.querySelectorAll('[role="gridcell"]')).toHaveLength(42);

    const cells = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="gridcell"]'));
    const first = cells.find((cell) => cell.tabIndex === 0)!;
    const firstIndex = cells.indexOf(first);
    const second = cells[firstIndex + 1]!;
    expect(first).toBeTruthy();
    expect(second.tabIndex).toBe(-1);

    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() => expect(second.tabIndex).toBe(0));
    fireEvent.click(second);
    expect(onOpenDate).toHaveBeenCalledWith(second.dataset.date);
  });

  it("opens the ISO week under keyboard focus and the visible month when actions are enabled", async () => {
    const onOpenWeek = vi.fn();
    const onOpenMonth = vi.fn();
    const { container, getByRole } = render(
      <DailyNotesCalendar
        cursorMonth="2026-08"
        noteDates={new Set()}
        onCursorMonthChange={vi.fn()}
        onOpenDate={vi.fn()}
        onOpenMonth={onOpenMonth}
        onOpenWeek={onOpenWeek}
      />
    );

    expect(getByRole("navigation", { name: "주기 노트" })).toBeInTheDocument();
    const augustThird = container.querySelector<HTMLButtonElement>('[data-date="2026-08-03"]');
    expect(augustThird).not.toBeNull();
    fireEvent.focus(augustThird!);

    const weekAction = await waitFor(() =>
      getByRole("button", { name: "2026-W32 주간 노트 만들기" })
    );
    fireEvent.click(weekAction);
    fireEvent.click(getByRole("button", { name: "2026-08 월간 노트 만들기" }));
    expect(onOpenWeek).toHaveBeenCalledWith("2026-W32");
    expect(onOpenMonth).toHaveBeenCalledWith("2026-08");
  });

  it("keeps existing notes openable while creation waits for encrypted name readiness", () => {
    const onOpenDate = vi.fn();
    const { getByRole } = render(
      <DailyNotesCalendar
        createDisabled
        cursorMonth="2026-08"
        noteDates={new Set(["2026-08-22"])}
        onCursorMonthChange={vi.fn()}
        onOpenDate={onOpenDate}
        onOpenMonth={vi.fn()}
        onOpenWeek={vi.fn()}
      />
    );

    const existing = getByRole("gridcell", { name: /2026년 8월 22일, Daily Note 있음/u });
    const missing = getByRole("gridcell", { name: /2026년 8월 23일, Daily Note 만들기/u });
    expect(existing).toBeEnabled();
    expect(missing).toBeDisabled();
    fireEvent.click(existing);
    expect(onOpenDate).toHaveBeenCalledWith("2026-08-22");
    expect(getByRole("button", { name: /주간 노트 만들기/u })).toBeDisabled();
    expect(getByRole("button", { name: /월간 노트 만들기/u })).toBeDisabled();
  });

  it("keeps existing weekly and monthly notes openable while creation is disabled", async () => {
    const onOpenWeek = vi.fn();
    const onOpenMonth = vi.fn();
    const { container, getByRole } = render(
      <DailyNotesCalendar
        createDisabled
        cursorMonth="2026-08"
        monthNoteKeys={new Set(["2026-08"])}
        noteDates={new Set()}
        onCursorMonthChange={vi.fn()}
        onOpenDate={vi.fn()}
        onOpenMonth={onOpenMonth}
        onOpenWeek={onOpenWeek}
        weekNoteKeys={new Set(["2026-W32"])}
      />
    );
    fireEvent.focus(container.querySelector<HTMLButtonElement>('[data-date="2026-08-03"]')!);

    const week = await waitFor(() => getByRole("button", { name: "2026-W32 주간 노트 열기" }));
    const month = getByRole("button", { name: "2026-08 월간 노트 열기" });
    expect(week).toBeEnabled();
    expect(month).toBeEnabled();
    fireEvent.click(week);
    fireEvent.click(month);
    expect(onOpenWeek).toHaveBeenCalledWith("2026-W32");
    expect(onOpenMonth).toHaveBeenCalledWith("2026-08");
  });

  it("keeps the coarse-pointer calendar fluid instead of forcing seven 44px columns", () => {
    const styles = readFileSync(join(process.cwd(), "src/features/calendar/calendar.css"), "utf8");
    expect(styles).toContain("grid-template-columns: repeat(7, minmax(0, 1fr));");
    expect(styles).not.toContain("grid-template-columns: repeat(7, 44px);");
    expect(styles).toMatch(/\.qm-daily-calendar\s*\{[^}]*overflow: hidden;/u);
    expect(styles).toMatch(/\.qm-daily-calendar-period-actions button\s*\{[^}]*min-width: 0;/u);
  });
});
