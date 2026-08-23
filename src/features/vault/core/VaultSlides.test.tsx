import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VaultSlides } from "./VaultSlides";

describe("VaultSlides", () => {
  it("navigates by controls and keyboard while rendering sanitized Markdown AST", () => {
    const { container } = render(<VaultSlides source={"# 첫 장\n<script>bad()</script>\n---\n# 둘째 장"} title="발표" />);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다음 슬라이드" }));
    expect(screen.getByRole("heading", { name: "둘째 장" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("region", { name: "발표 슬라이드" }), { key: "Home" });
    expect(screen.getByRole("heading", { name: "첫 장" })).toBeInTheDocument();
  });
});
