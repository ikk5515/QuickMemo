import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSelect } from "./AppSelect";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AppSelect", () => {
  it("keeps native select semantics, labeling, and change behavior", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <label>
        상태
        <AppSelect defaultValue="all" onChange={onChange}>
          <option value="all">전체</option>
          <option value="active">활성</option>
        </AppSelect>
      </label>
    );

    const select = screen.getByRole("combobox", { name: "상태" });

    expect(select).toHaveClass("app-select");
    await user.selectOptions(select, "active");
    expect(select).toHaveValue("active");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("forwards native state attributes, refs, and caller classes", () => {
    const ref = createRef<HTMLSelectElement>();

    render(
      <AppSelect
        aria-label="비활성 필터"
        aria-invalid="true"
        className="compact-select"
        disabled
        ref={ref}
      >
        <option>전체</option>
      </AppSelect>
    );

    const select = screen.getByRole("combobox", { name: "비활성 필터" });

    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveClass("app-select", "compact-select");
    expect(ref.current).toBe(select);
  });

  it("keeps the native wrapper and caller classes while unified styling is disabled", () => {
    vi.stubEnv("VITE_UNIFIED_SELECT_UI_ENABLED", "false");

    render(
      <AppSelect aria-label="기존 필터" className="legacy-page-select">
        <option>전체</option>
      </AppSelect>
    );

    const select = screen.getByRole("combobox", { name: "기존 필터" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveClass("legacy-page-select");
    expect(select).not.toHaveClass("app-select");
  });

  it("defaults unified styling on when the flag is omitted", () => {
    vi.stubEnv("VITE_UNIFIED_SELECT_UI_ENABLED", "");

    render(
      <AppSelect aria-label="통합 필터">
        <option>전체</option>
      </AppSelect>
    );

    expect(screen.getByRole("combobox", { name: "통합 필터" }))
      .toHaveClass("app-select");
  });
});
