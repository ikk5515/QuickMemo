import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultFormatConverter } from "./VaultFormatConverter";

describe("VaultFormatConverter", () => {
  it("requires loss acknowledgement and emits only a Markdown copy draft", async () => {
    const onCreateMarkdownCopy = vi.fn(async () => undefined);
    render(
      <VaultFormatConverter
        onCreateMarkdownCopy={onCreateMarkdownCopy}
        source={{
          body: "<p>본문</p><iframe src='https://example.com'></iframe>",
          contentFormat: "legacy-html-v1",
          folderId: null,
          id: "legacy",
          revision: 3,
          title: "원본"
        }}
      />
    );
    const create = screen.getByRole("button", { name: "Markdown 복사본 만들기" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Markdown 복사본 이름"), { target: { value: "원본 변환본" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(create);
    await waitFor(() => expect(onCreateMarkdownCopy).toHaveBeenCalledWith(expect.objectContaining({
      body: "본문",
      sourceEntryId: "legacy",
      sourceRevision: 3,
      title: "원본 변환본"
    })));
  });
});
