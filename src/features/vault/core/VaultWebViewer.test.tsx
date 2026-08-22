import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VaultWebViewer } from "./VaultWebViewer";

describe("VaultWebViewer", () => {
  it("loads only after confirmation in a capability-free frame", () => {
    render(<VaultWebViewer embeddedHosts={["example.com"]} initialUrl="https://example.com/page" />);
    expect(screen.queryByTitle("example.com 웹 뷰어")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const frame = screen.getByTitle("example.com 웹 뷰어");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("allow", expect.stringContaining("camera 'none'"));
    expect(frame).toHaveAttribute("loading", "lazy");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("src", "https://example.com/page");
    expect(screen.getByRole("link", { name: /새 탭/ })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("falls back to a noopener external tab when the host is not explicitly allowed", () => {
    render(<VaultWebViewer initialUrl="https://example.com/page" />);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: /안전한 새 탭에서 열기/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer"
    );
  });

  it("clears the frame when an unsafe URL is submitted", () => {
    render(<VaultWebViewer />);
    fireEvent.change(screen.getByLabelText("웹 주소"), { target: { value: "http://127.0.0.1/private" } });
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    expect(screen.getByRole("alert")).toHaveTextContent("로컬 네트워크");
    expect(document.querySelector("iframe")).toBeNull();
  });
});
