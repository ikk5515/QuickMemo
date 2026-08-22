import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildDailyCalendarMonth,
  isoWeekKeyFromDateKey,
  localMonthKey,
  moveDailyMonth,
  normalizeDailyMonth,
  parseLocalDateKey
} from "./dailyNotes";
import "./calendar.css";

const koreanMonthFormatter = new Intl.DateTimeFormat("ko-KR", { month: "long", year: "numeric" });
const koreanDateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "long" });
const KOREAN_WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;

export interface DailyNotesCalendarProps {
  createDisabled?: boolean;
  cursorMonth: string;
  noteDates: ReadonlySet<string>;
  monthNoteKeys?: ReadonlySet<string>;
  onCursorMonthChange: (month: string) => void;
  onOpenDate: (dateKey: string) => void;
  onOpenMonth?: (monthKey: string) => void;
  onOpenWeek?: (weekKey: string) => void;
  weekNoteKeys?: ReadonlySet<string>;
}

const EMPTY_PERIOD_KEYS: ReadonlySet<string> = new Set();

function monthLabel(monthKey: string) {
  const normalized = normalizeDailyMonth(monthKey);
  const [year, month] = normalized.split("-").map(Number);
  return koreanMonthFormatter.format(new Date(year, month - 1, 1, 12));
}

function dateLabel(dateKey: string) {
  const date = parseLocalDateKey(dateKey);
  return date
    ? koreanDateFormatter.format(date)
    : dateKey;
}

export function DailyNotesCalendar({
  createDisabled = false,
  cursorMonth,
  monthNoteKeys = EMPTY_PERIOD_KEYS,
  noteDates,
  onCursorMonthChange,
  onOpenDate,
  onOpenMonth,
  onOpenWeek,
  weekNoteKeys = EMPTY_PERIOD_KEYS
}: DailyNotesCalendarProps) {
  const normalizedMonth = normalizeDailyMonth(cursorMonth);
  const weeks = useMemo(() => buildDailyCalendarMonth(normalizedMonth), [normalizedMonth]);
  const days = useMemo(() => weeks.flatMap((week) => week.days), [weeks]);
  const preferredFocusDate = days.find((day) => day.isToday)?.dateKey
    ?? days.find((day) => day.inMonth)?.dateKey
    ?? days[0]?.dateKey
    ?? "";
  const [focusedDate, setFocusedDate] = useState(preferredFocusDate);
  const dayButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const focusedWeekKey = isoWeekKeyFromDateKey(focusedDate);
  const hasFocusedWeekNote = focusedWeekKey ? weekNoteKeys.has(focusedWeekKey) : false;
  const hasVisibleMonthNote = monthNoteKeys.has(normalizedMonth);

  useEffect(() => {
    setFocusedDate(preferredFocusDate);
  }, [normalizedMonth, preferredFocusDate]);

  const focusDayAt = (index: number) => {
    const target = days[Math.max(0, Math.min(days.length - 1, index))];
    if (!target) return;
    setFocusedDate(target.dateKey);
    window.requestAnimationFrame?.(() => dayButtonsRef.current.get(target.dateKey)?.focus());
  };

  return (
    <section aria-label="Daily Notes 달력" className="qm-daily-calendar">
      <header>
        <span><CalendarDays aria-hidden="true" size={14} />{monthLabel(normalizedMonth)}</span>
        <div>
          <button
            aria-label="이전 달"
            onClick={() => onCursorMonthChange(moveDailyMonth(normalizedMonth, -1))}
            type="button"
          ><ChevronLeft size={14} /></button>
          <button
            onClick={() => onCursorMonthChange(localMonthKey(new Date()))}
            type="button"
          >오늘</button>
          <button
            aria-label="다음 달"
            onClick={() => onCursorMonthChange(moveDailyMonth(normalizedMonth, 1))}
            type="button"
          ><ChevronRight size={14} /></button>
        </div>
      </header>
      <div aria-hidden="true" className="qm-daily-calendar-weekdays">
        {KOREAN_WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div aria-colcount={7} aria-rowcount={weeks.length} className="qm-daily-calendar-grid" role="grid">
        {weeks.map((week, weekIndex) => (
          <div className="qm-daily-calendar-week" key={week.days[0]?.dateKey ?? weekIndex} role="row">
            {week.days.map((day, dayIndex) => {
              const hasNote = noteDates.has(day.dateKey);
              const absoluteIndex = weekIndex * 7 + dayIndex;
              return (
                <button
                  aria-current={day.isToday ? "date" : undefined}
                  aria-label={`${dateLabel(day.dateKey)}${hasNote ? ", Daily Note 있음" : ", Daily Note 만들기"}`}
                  className={[day.inMonth ? "" : "outside", day.isToday ? "today" : "", hasNote ? "has-note" : ""]
                    .filter(Boolean).join(" ")}
                  data-date={day.dateKey}
                  disabled={createDisabled && !hasNote}
                  key={day.dateKey}
                  onClick={() => onOpenDate(day.dateKey)}
                  onFocus={() => setFocusedDate(day.dateKey)}
                  onKeyDown={(event) => {
                    const targetIndex = event.key === "ArrowLeft" ? absoluteIndex - 1
                      : event.key === "ArrowRight" ? absoluteIndex + 1
                        : event.key === "ArrowUp" ? absoluteIndex - 7
                          : event.key === "ArrowDown" ? absoluteIndex + 7
                            : event.key === "Home" ? absoluteIndex - dayIndex
                              : event.key === "End" ? absoluteIndex + (6 - dayIndex)
                                : null;
                    if (targetIndex !== null) {
                      event.preventDefault();
                      focusDayAt(targetIndex);
                    }
                  }}
                  ref={(element) => {
                    if (element) dayButtonsRef.current.set(day.dateKey, element);
                    else dayButtonsRef.current.delete(day.dateKey);
                  }}
                  role="gridcell"
                  tabIndex={focusedDate === day.dateKey ? 0 : -1}
                  type="button"
                >
                  <span>{day.day}</span>
                  {hasNote ? <i aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {onOpenWeek || onOpenMonth ? (
        <nav aria-label="주기 노트" className="qm-daily-calendar-period-actions">
          {onOpenWeek && focusedWeekKey ? (
            <button
              aria-label={`${focusedWeekKey} 주간 노트 ${hasFocusedWeekNote ? "열기" : "만들기"}`}
              disabled={createDisabled && !hasFocusedWeekNote}
              onClick={() => onOpenWeek(focusedWeekKey)}
              type="button"
            >
              <strong>{focusedWeekKey}</strong>
              <span>주간 노트</span>
            </button>
          ) : null}
          {onOpenMonth ? (
            <button
              aria-label={`${normalizedMonth} 월간 노트 ${hasVisibleMonthNote ? "열기" : "만들기"}`}
              disabled={createDisabled && !hasVisibleMonthNote}
              onClick={() => onOpenMonth(normalizedMonth)}
              type="button"
            >
              <strong>{normalizedMonth}</strong>
              <span>월간 노트</span>
            </button>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
