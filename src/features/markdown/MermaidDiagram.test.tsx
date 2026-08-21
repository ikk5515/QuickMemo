import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MermaidDiagram, sanitizeMermaidSvg } from "./MermaidDiagram";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn()
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks
}));

const createObjectUrl = vi.fn(() => "blob:quickmemo-mermaid");
const revokeObjectUrl = vi.fn();

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectUrl
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectUrl
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MermaidDiagram", () => {
  it("renders a sanitized SVG only through an isolated object URL", async () => {
    mermaidMocks.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>안전한 도식</text></svg>'
    });
    const { unmount } = render(<MermaidDiagram source="graph TD; A-->B" />);

    const image = await screen.findByRole("img", { name: "Mermaid 다이어그램" });
    expect(image).toHaveAttribute("src", "blob:quickmemo-mermaid");
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: "strict",
      startOnLoad: false,
      flowchart: { htmlLabels: false }
    }));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Mermaid 원본 보기")).toBeInTheDocument();

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:quickmemo-mermaid");
  });

  it("falls back to visible source after a generic render failure", async () => {
    mermaidMocks.render.mockRejectedValueOnce(new Error("contains private diagram source"));
    render(<MermaidDiagram source="not a diagram" />);

    expect(await screen.findByText("다이어그램을 표시할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("not a diagram")).toBeInTheDocument();
  });
});

describe("sanitizeMermaidSvg", () => {
  it("removes script-capable elements, handlers, remote resources, and unsafe CSS", () => {
    const sanitized = sanitizeMermaidSvg([
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
      "<script>alert(1)</script>",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>',
      '<image href="https://tracker.example/pixel.png"/>',
      '<a href="javascript:alert(1)"><text>보존할 라벨</text></a>',
      '<style>.bad{fill:url(https://tracker.example/a)}</style>',
      '<path onclick="alert(1)" style="fill:url(data:image/svg+xml,bad)"/>',
      '<use href="#local-marker"/>',
      "</svg>"
    ].join(""));

    expect(sanitized).toContain("보존할 라벨");
    expect(sanitized).toContain('href="#local-marker"');
    expect(sanitized).not.toMatch(/script|foreignObject|<image|onload|onclick/iu);
    expect(sanitized).not.toMatch(/javascript:|data:|https:\/\/tracker/iu);
  });

  it("rejects non-SVG and oversized renderer output", () => {
    expect(() => sanitizeMermaidSvg("<html></html>")).toThrow("invalid-mermaid-svg");
    expect(() => sanitizeMermaidSvg(`<svg>${"x".repeat(2_000_001)}</svg>`))
      .toThrow("invalid-mermaid-svg");
  });
});
