import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { exportMarkdownForDiscordAi } from "./export";
import { MarkdownMessageBatchDialog } from "./MarkdownMessageBatchDialog";

function messageBatch() {
  const delivery = exportMarkdownForDiscordAi("첫 문단 ".repeat(80), {
    maximumMessageCharacters: 100
  });
  if (delivery.kind !== "message-batch") throw new Error("fixture must produce a message batch");
  return delivery;
}

describe("MarkdownMessageBatchDialog", () => {
  it("copies exactly one bounded message per action and never exposes a joined copy action", async () => {
    const copyMessage = vi.fn(async () => undefined);
    const delivery = messageBatch();
    render(
      <MarkdownMessageBatchDialog
        copyMessage={copyMessage}
        delivery={delivery}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /전체.*복사/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `1/${delivery.messages.length} 메시지 복사` }));

    await waitFor(() => expect(copyMessage).toHaveBeenCalledTimes(1));
    expect(copyMessage).toHaveBeenCalledWith(delivery.messages[0].content);
    expect(copyMessage).not.toHaveBeenCalledWith(delivery.messages.map((message) => message.content).join("\n\n"));
    expect(screen.getByRole("status")).toHaveTextContent(`1/${delivery.messages.length} 메시지를 복사했습니다.`);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<MarkdownMessageBatchDialog delivery={messageBatch()} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Discord · AI 메시지 나누기" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
