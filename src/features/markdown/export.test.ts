import { describe, expect, it } from "vitest";
import { exportMarkdown, exportMarkdownForDiscordAi, splitMarkdownForMessages } from "./export";

describe("Markdown interoperability exports", () => {
  it("keeps raw and Obsidian exports byte-for-byte, including CRLF and tabs", () => {
    const source = "# 제목\r\n\r\n\t[[Note]]";
    expect(exportMarkdown(source, { profile: "raw" }).content).toBe(source);
    expect(exportMarkdown(source, { profile: "obsidian" }).content).toBe(source);
  });

  it("converts wiki links to encoded relative GitHub links but leaves code untouched", () => {
    const source = [
      "[[Projects/My Note#Main Heading|프로젝트]]",
      "![[Assets/pic one.png]]",
      "`[[Inline Code]]`",
      "```md",
      "[[Fenced Code]]",
      "```"
    ].join("\n");
    const result = exportMarkdown(source, {
      profile: "github",
      sourcePath: "Notes/Today.md"
    });

    expect(result.content).toContain("[프로젝트](../Projects/My%20Note.md#main-heading)");
    expect(result.content).toContain("![pic one.png](../Assets/pic%20one.png)");
    expect(result.content).toContain("`[[Inline Code]]`");
    expect(result.content).toContain("[[Fenced Code]]");
  });

  it("warns when a Notion export cannot preserve an Obsidian block reference", () => {
    const result = exportMarkdown("[[Specs/Plan#^decision|결정]]", {
      profile: "notion",
      sourcePath: "Daily/Today.md"
    });
    expect(result.content).toBe("[결정](../Specs/Plan.md)");
    expect(result.warnings[0]).toContain("블록 참조");
  });

  it("creates bounded Discord/AI chunks and repairs fenced code around boundaries", () => {
    const source = `# 공유\n\n[[Long Note|긴 노트]]\n\n\`\`\`ts\n${"const value = 1;\n".repeat(30)}\`\`\``;
    const result = exportMarkdown(source, {
      profile: "discord-ai",
      maximumChunkCharacters: 180
    });

    expect(result.content).not.toContain("[[");
    expect(result.content).toContain("긴 노트");
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.every((chunk) => chunk.length <= 180)).toBe(true);
    expect(result.chunks.slice(0, -1).every((chunk) => {
      const fences = chunk.match(/```/g)?.length ?? 0;
      return fences % 2 === 0;
    })).toBe(true);
  });

  it("never truncates source characters when a continued code fence has a long info string", () => {
    const source = `\`\`\`lang-${"i".repeat(40)}\n${"x".repeat(600)}\n\`\`\``;
    const messages = splitMarkdownForMessages(source, 100);

    expect(messages.every((message) => message.length <= 100)).toBe(true);
    expect(messages.join("").split("x").length - 1).toBe(600);
  });

  it("represents multi-message Discord/AI output only as an explicit bounded delivery batch", () => {
    const source = `# 공유\n\n[[Long Note|긴 노트]]\n\n\`\`\`ts\n${"const value = 1;\n".repeat(30)}\`\`\``;
    const delivery = exportMarkdownForDiscordAi(source, { maximumMessageCharacters: 180 });

    expect(delivery.kind).toBe("message-batch");
    expect(delivery.singleMessageContent).toBeNull();
    expect(delivery.messages.length).toBeGreaterThan(1);
    expect(delivery.messages.every((message, index) => (
      message.content.length <= 180
      && message.index === index + 1
      && message.total === delivery.messages.length
    ))).toBe(true);
    expect(delivery).not.toHaveProperty("content");
    expect(delivery).not.toHaveProperty("chunks");
    expect(Object.isFrozen(delivery.messages)).toBe(true);
  });

  it("exposes a safe single-message value only when Discord/AI output fits one message", () => {
    const delivery = exportMarkdownForDiscordAi("[[Note|노트]]", { maximumMessageCharacters: 180 });

    expect(delivery.kind).toBe("single-message");
    expect(delivery.singleMessageContent).toBe("노트");
    expect(delivery.messages).toEqual([{ content: "노트", index: 1, total: 1 }]);
  });

  it("rejects chunk sizes too small to repair Markdown safely", () => {
    expect(() => splitMarkdownForMessages("text", 40)).toThrow(RangeError);
  });
});
