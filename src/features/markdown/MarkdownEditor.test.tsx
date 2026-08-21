import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

afterEach(cleanup);

function ControlledEditor() {
  const [value, setValue] = useState("앞뒤");
  return (
    <MarkdownEditor
      defaultMode="source"
      label="테스트 노트"
      value={value}
      onChange={setValue}
    />
  );
}

describe("MarkdownEditor", () => {
  it("inserts and retains a literal tab instead of moving focus", () => {
    render(<ControlledEditor />);
    const textarea = screen.getByRole("textbox", { name: "테스트 노트 소스" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea).toHaveValue("앞\t뒤");
  });

  it("switches between source, live preview, and reading modes with accessible tabs", () => {
    render(<MarkdownEditor defaultMode="source" value="# 제목" onChange={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "라이브 프리뷰" }));
    expect(screen.getByLabelText("Markdown 노트 미리보기")).toHaveTextContent("제목");
    fireEvent.click(screen.getByRole("tab", { name: "읽기 보기" }));
    expect(screen.getByLabelText("Markdown 노트 읽기 보기")).toHaveTextContent("제목");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
