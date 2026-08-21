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
});
