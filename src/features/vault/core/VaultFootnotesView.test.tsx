import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultFootnotesView } from "./VaultFootnotesView";

describe("VaultFootnotesView", () => {
  it("shows reference counts and navigates to the definition", () => {
    const onNavigate = vi.fn();
    render(<VaultFootnotesView onNavigate={onNavigate} source={"본문[^a] 또[^a]\n\n[^a]: 설명"} />);
    expect(screen.getByText("2개 참조")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "3번째 줄로 이동" }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ label: "a", definitionLine: 3 }));
  });
});
