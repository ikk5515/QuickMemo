import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultOutline } from "./VaultOutline";

describe("VaultOutline", () => {
  it("renders heading hierarchy and navigates by line", () => {
    const onNavigate = vi.fn();
    const headings = [
      { level: 1, text: "설계", line: 2, slug: "설계" },
      { level: 3, text: "보안", line: 8, slug: "보안" }
    ];
    render(<VaultOutline headings={headings} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: /보안/ }));
    expect(onNavigate).toHaveBeenCalledWith(headings[1]);
    expect(screen.getByRole("navigation", { name: "현재 노트 목차" })).toBeInTheDocument();
  });

  it("shows an empty state without headings", () => {
    render(<VaultOutline headings={[]} onNavigate={() => undefined} />);
    expect(screen.getByText("이 노트에는 제목이 없습니다.")).toBeInTheDocument();
  });
});
