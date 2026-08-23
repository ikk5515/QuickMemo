import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultPropertiesEditor } from "./VaultPropertiesEditor";

describe("VaultPropertiesEditor", () => {
  it("applies one property without replacing unrelated frontmatter", () => {
    const onChange = vi.fn();
    render(
      <VaultPropertiesEditor
        onChange={onChange}
        onError={() => undefined}
        properties={{ status: "todo" }}
        source={'---\nstatus: "todo"\nkeep: "yes"\n---\n본문'}
      />
    );

    fireEvent.change(screen.getByLabelText("status 속성 값"), { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    expect(onChange).toHaveBeenCalledWith('---\nstatus: "done"\nkeep: "yes"\n---\n본문');
  });

  it("adds and removes properties with accessible controls", () => {
    const onChange = vi.fn();
    const source = '---\nstatus: "todo"\n---\n본문';
    render(
      <VaultPropertiesEditor
        onChange={onChange}
        onError={() => undefined}
        properties={{ status: "todo" }}
        source={source}
      />
    );

    fireEvent.change(screen.getByLabelText("새 속성 이름"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("새 속성 값"), { target: { value: "me" } });
    fireEvent.click(screen.getByRole("button", { name: "속성 추가" }));
    expect(onChange).toHaveBeenCalledWith('---\nstatus: "todo"\nowner: "me"\n---\n본문');

    fireEvent.click(screen.getByRole("button", { name: "status 속성 삭제" }));
    expect(onChange).toHaveBeenCalledWith("---\n---\n본문");
  });

  it("edits checkbox, date, number and tag property types without flattening unrelated YAML", () => {
    const onChange = vi.fn();
    const source = '---\ndone: false\nkeep: { nested: true }\n---\n본문';
    render(
      <VaultPropertiesEditor
        onChange={onChange}
        onError={() => undefined}
        properties={{ done: false }}
        source={source}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "done 속성 값" }));
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(onChange).toHaveBeenCalledWith('---\ndone: true\nkeep: { nested: true }\n---\n본문');

    fireEvent.change(screen.getByLabelText("새 속성 이름"), { target: { value: "tags" } });
    fireEvent.change(screen.getByLabelText("새 속성 유형"), { target: { value: "tags" } });
    fireEvent.change(screen.getByLabelText("새 속성 값"), { target: { value: "#work, quickmemo" } });
    fireEvent.click(screen.getByRole("button", { name: "속성 추가" }));
    expect(onChange).toHaveBeenLastCalledWith('---\ndone: false\nkeep: { nested: true }\ntags: ["work", "quickmemo"]\n---\n본문');
  });
});
