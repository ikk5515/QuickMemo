import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultLegacyNote } from "./VaultLegacyNote";

describe("VaultLegacyNote", () => {
  it("creates a copy of the chosen legacy panel without rewriting either original", () => {
    const createCopy = vi.fn();
    const first = "<h1>첫 원본</h1><p><strong>서식 보존</strong></p>";
    const second = "<h1>둘째 원본</h1><p>다른 원문</p>";
    const { container } = render(<>
      <VaultLegacyNote body={first} entryId="legacy-a" onCreateMarkdownCopy={createCopy} />
      <VaultLegacyNote body={second} entryId="legacy-b" onCreateMarkdownCopy={createCopy} />
    </>);
    const copies = screen.getAllByRole("button", { name: "Markdown 복사본 만들기" });
    fireEvent.click(copies[1]);
    expect(createCopy).toHaveBeenCalledExactlyOnceWith("legacy-b");
    expect(screen.getByRole("heading", { name: "첫 원본" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "둘째 원본" })).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("서식 보존");
    expect(container.querySelector("[contenteditable], textarea")).toBeNull();
  });
});
