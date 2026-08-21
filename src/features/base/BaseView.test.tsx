import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParsedMarkdownMetadata, VaultIndexEntry } from "../knowledge";
import { BaseView } from "./BaseView";

const entries: VaultIndexEntry[] = [
  { id: "alpha", kind: "markdown", path: "Work/Alpha.md", content: "Alpha" },
  { id: "beta", kind: "markdown", path: "Work/Beta.md", content: "Beta" }
];
const emptyMetadata = (status: string): ParsedMarkdownMetadata => ({
  aliases: [],
  blocks: [],
  headings: [],
  links: [],
  properties: { status },
  tags: ["project"]
});
const metadata = new Map([
  ["alpha", emptyMetadata("todo")],
  ["beta", emptyMetadata("done")]
]);
const source = `
formulas:
  unsafe: status.toUpperCase()
properties:
  status:
    displayName: 상태
views:
  - type: table
    name: 표
    order: [file.name, status, formula.unsafe]
  - type: cards
    name: 카드
    order: [file.name, status]
  - type: list
    name: 목록
    order: [file.name, status]
`;

describe("BaseView", () => {
  it("renders an accessible table with property display names and inert formula warnings", () => {
    render(<BaseView entries={entries} metadataByEntryId={metadata} source={source} />);

    expect(screen.getByRole("table", { name: "표" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "상태" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "formula.unsafe" })).toBeInTheDocument();
    expect(screen.getByText("결과 2개")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/호환성 안내/));
    expect(screen.getByText(/보안을 위해 실행하지 않습니다/)).toBeInTheDocument();
  });

  it("switches between cards and list views and opens a note from keyboard-accessible controls", () => {
    const onOpenEntry = vi.fn();
    render(
      <BaseView
        entries={entries}
        metadataByEntryId={metadata}
        onOpenEntry={onOpenEntry}
        source={source}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Base 보기" }), { target: { value: "카드" } });
    const cards = screen.getByRole("list", { name: "카드 카드" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(cards).getByRole("button", { name: "Alpha" }));
    expect(onOpenEntry).toHaveBeenCalledWith("alpha");

    fireEvent.change(screen.getByRole("combobox", { name: "Base 보기" }), { target: { value: "목록" } });
    expect(screen.getByRole("list", { name: "목록 목록" })).toBeInTheDocument();
  });

  it("reports invalid YAML without rendering unsafe content", () => {
    render(<BaseView entries={entries} metadataByEntryId={metadata} source={"views: *missing"} />);
    expect(screen.getByRole("heading", { name: "Base를 열 수 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
