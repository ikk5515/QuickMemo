import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedMarkdownMetadata, VaultIndexEntry } from "../knowledge";
import { BaseView } from "./BaseView";
import {
  materializeBaseWorkerRequest,
  type BaseMaterializationWorkerRequest,
  type BaseMaterializationWorkerResponse
} from "./materializationRuntime";

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
  label: status.upper()
properties:
  status:
    displayName: 상태
views:
  - type: table
    name: 표
    order: [file.name, status, formula.label]
    summaries:
      status: Unique
  - type: cards
    name: 카드
    order: [file.name, status]
  - type: list
    name: 목록
    order: [file.name, status]
`;

describe("BaseView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders an accessible table with property display names, formulas and summaries", () => {
    render(<BaseView entries={entries} metadataByEntryId={metadata} source={source} />);

    expect(screen.getByRole("table", { name: "표" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "상태" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "formula.label" })).toBeInTheDocument();
    expect(screen.getByText("TODO")).toBeInTheDocument();
    expect(screen.getByText("결과 2개")).toBeInTheDocument();
    expect(screen.getByLabelText("Base 요약")).toHaveTextContent("상태 · Unique");
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

  it("opens a resolved internal formula link without turning it into an external navigation", () => {
    const onOpenEntry = vi.fn();
    render(
      <BaseView
        entries={entries}
        metadataByEntryId={metadata}
        onOpenEntry={onOpenEntry}
        source={`
formulas:
  target: file("Work/Beta.md").asLink("연결된 Beta")
views:
  - type: table
    name: 링크
    filters: 'file.path == "Work/Alpha.md"'
    order: [file.name, formula.target]
`}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "연결된 Beta" }));
    expect(onOpenEntry).toHaveBeenCalledWith("beta");
    expect(screen.queryByRole("link", { name: "연결된 Beta" })).not.toBeInTheDocument();
  });

  it("reports invalid YAML without rendering unsafe content", () => {
    render(<BaseView entries={entries} metadataByEntryId={metadata} source={"views: *missing"} />);
    expect(screen.getByRole("heading", { name: "Base를 열 수 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("edits only YAML properties and preserves their current metadata types", async () => {
    const onEditProperty = vi.fn().mockResolvedValue(undefined);
    const typedMetadata = new Map<string, ParsedMarkdownMetadata>([
      ["alpha", {
        ...emptyMetadata("todo"),
        properties: {
          active: false,
          labels: ["one", "two"],
          score: 3,
          status: "todo"
        }
      }]
    ]);
    const typedSource = `
formulas:
  unsafe: score * 2
properties:
  active:
    displayName: 활성
  labels:
    displayName: 라벨
  score:
    displayName: 점수
views:
  - type: table
    name: 편집
    order: [file.name, active, labels, score, formula.unsafe]
`;

    render(
      <BaseView
        entries={[entries[0]]}
        metadataByEntryId={typedMetadata}
        onEditProperty={onEditProperty}
        onOpenEntry={vi.fn()}
        source={typedSource}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha — 활성 속성" }));
    const labels = screen.getByRole("textbox", { name: "Alpha — 라벨 속성" });
    fireEvent.change(labels, { target: { value: "red, blue" } });
    expect(onEditProperty).not.toHaveBeenCalledWith("alpha", "labels", ["red", "blue"]);
    fireEvent.blur(labels);
    const score = screen.getByRole("spinbutton", { name: "Alpha — 점수 속성" });
    fireEvent.change(score, { target: { value: "42" } });
    expect(onEditProperty).not.toHaveBeenCalledWith("alpha", "score", 42);
    fireEvent.blur(score);

    await waitFor(() => {
      expect(onEditProperty).toHaveBeenCalledWith("alpha", "active", true);
      expect(onEditProperty).toHaveBeenCalledWith("alpha", "labels", ["red", "blue"]);
      expect(onEditProperty).toHaveBeenCalledWith("alpha", "score", 42);
    });
    expect(screen.queryByRole("textbox", { name: /formula\.unsafe/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument();
  });

  it("reports invalid typed edits without invoking the property callback", async () => {
    const onEditProperty = vi.fn();
    const numericMetadata = new Map<string, ParsedMarkdownMetadata>([
      ["alpha", { ...emptyMetadata("todo"), properties: { score: 3 } }]
    ]);
    render(
      <BaseView
        entries={[entries[0]]}
        metadataByEntryId={numericMetadata}
        onEditProperty={onEditProperty}
        source={"views:\n  - type: table\n    name: 편집\n    order: [file.name, score]"}
      />
    );

    const score = screen.getByRole("spinbutton", { name: "Alpha — score 속성" });
    fireEvent.change(score, { target: { value: "" } });
    fireEvent.blur(score);

    expect(await screen.findByRole("alert")).toHaveTextContent("유효한 숫자");
    expect(onEditProperty).not.toHaveBeenCalled();
  });

  it("does not expose property editors for entries being deleted", () => {
    const onEditProperty = vi.fn();
    render(
      <BaseView
        entries={[entries[0]]}
        metadataByEntryId={metadata}
        onEditProperty={onEditProperty}
        readOnlyEntryIds={new Set(["alpha"])}
        source={"views:\n  - type: table\n    name: 잠금\n    order: [file.name, status]"}
      />
    );

    expect(screen.queryByRole("textbox", { name: "Alpha — status 속성" })).not.toBeInTheDocument();
    expect(screen.getByText("todo")).toBeInTheDocument();
    expect(onEditProperty).not.toHaveBeenCalled();
  });

  it("drops a prior large-vault worker result before a changed ACL scope can paint", async () => {
    class DeferredWorker {
      static instances: DeferredWorker[] = [];
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<BaseMaterializationWorkerResponse>) => void) | null = null;
      request: BaseMaterializationWorkerRequest | null = null;

      constructor() {
        DeferredWorker.instances.push(this);
      }

      postMessage(request: BaseMaterializationWorkerRequest) {
        this.request = request;
      }

      terminate() {}

      respond() {
        if (!this.request) throw new Error("missing worker request");
        this.onmessage?.({ data: materializeBaseWorkerRequest(this.request) } as MessageEvent<BaseMaterializationWorkerResponse>);
      }
    }
    vi.stubGlobal("Worker", DeferredWorker);
    const largeEntries = Array.from({ length: 251 }, (_, index): VaultIndexEntry => ({
      id: `old-${index}`,
      kind: "markdown",
      path: index === 0 ? "00-Secret.md" : `Old/${index}.md`
    }));
    const largeMetadata = new Map(largeEntries.map((entry) => [entry.id, emptyMetadata("old")]));
    const baseSource = "views:\n  - type: table\n    name: 작업\n    order: [file.name, status]\n    limit: 1";
    const onOpenEntry = vi.fn();
    const rendered = render(
      <BaseView entries={largeEntries} metadataByEntryId={largeMetadata} onOpenEntry={onOpenEntry} source={baseSource} />
    );

    expect(screen.getByRole("status")).toHaveTextContent("계산하는 중");
    await waitFor(() => expect(DeferredWorker.instances).toHaveLength(1));
    await act(async () => DeferredWorker.instances[0].respond());
    expect(await screen.findByRole("button", { name: "00-Secret" })).toBeInTheDocument();

    const nextEntries = Array.from({ length: 251 }, (_, index): VaultIndexEntry => ({
      id: `new-${index}`,
      kind: "markdown",
      path: `Visible/${index}.md`
    }));
    const nextMetadata = new Map(nextEntries.map((entry) => [entry.id, emptyMetadata("new")]));
    rendered.rerender(
      <BaseView entries={nextEntries} metadataByEntryId={nextMetadata} onOpenEntry={onOpenEntry} source={baseSource} />
    );

    expect(screen.queryByRole("button", { name: "00-Secret" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("계산하는 중");
  });

  it("renders formula HTML, image, icon and link values without executable markup or tracking images", () => {
    const renderedSource = `
formulas:
  markup: 'html("<strong>Safe</strong><script>globalThis.baseAttack = true</script><a href=javascript:alert(1)>unsafe</a><a href=https://example.com/safe>safe link</a>")'
  externalImage: 'image("https://example.com/tracker.png")'
  glyph: 'icon("arrow-right")'
  iconLink: 'link("Target", icon("plus"))'
views:
  - type: table
    name: 안전 렌더
    limit: 1
    order: [file.name, formula.markup, formula.externalImage, formula.glyph, formula.iconLink]
`;
    const { container } = render(
      <BaseView entries={entries} metadataByEntryId={metadata} source={renderedSource} />
    );

    expect(screen.getByText("Safe").tagName).toBe("STRONG");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect((globalThis as { baseAttack?: boolean }).baseAttack).toBeUndefined();
    expect(container.querySelector(".qm-base-safe-html")?.textContent).toContain("unsafe");
    expect([...container.querySelectorAll("a")].some((anchor) => anchor.textContent === "unsafe")).toBe(false);
    const safeLink = screen.getByRole("link", { name: "safe link" });
    expect(safeLink).toHaveAttribute("href", "https://example.com/safe");
    expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");
    const externalImage = screen.getByRole("link", { name: "이미지 열기" });
    expect(externalImage).toHaveAttribute("href", "https://example.com/tracker.png");
    expect(screen.getByLabelText("아이콘 arrow-right")).toBeInTheDocument();
    expect(screen.getByLabelText("아이콘 plus")).toBeInTheDocument();
  });
});
