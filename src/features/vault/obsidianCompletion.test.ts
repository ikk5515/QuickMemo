import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { completeObsidianMarkdown, type ObsidianMarkdownCompletionData } from "./obsidianCompletion";

const completionData: ObsidianMarkdownCompletionData = {
  currentBlocks: ["current-block"],
  currentHeadings: ["현재 제목"],
  currentNotePath: "현재 노트",
  notes: [
    {
      aliases: ["QM", "퀵메모"],
      blocks: ["overview"],
      headings: ["설계", "보안"],
      path: "Projects/QuickMemo.md"
    },
    { path: "회의록.md" }
  ],
  tags: ["#project/quickmemo", "업무", "업무", "123"]
};

function complete(doc: string, explicit = false) {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  return completeObsidianMarkdown(new CompletionContext(state, doc.length, explicit), completionData);
}

describe("completeObsidianMarkdown", () => {
  it("suggests vault paths without .md and aliases that insert an aliased wikilink", () => {
    const result = complete("[[Q");

    expect(result?.from).toBe(2);
    expect(result?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ apply: "Projects/QuickMemo]]", label: "Projects/QuickMemo" }),
        expect.objectContaining({ apply: "Projects/QuickMemo|QM]]", label: "QM" })
      ])
    );
  });

  it("does not duplicate closing brackets that already follow the cursor", () => {
    const doc = "[[Qui]]";
    const state = EditorState.create({ doc, selection: { anchor: 5 }, extensions: [markdown()] });
    const result = completeObsidianMarkdown(new CompletionContext(state, 5, false), completionData);

    expect(result?.options).toContainEqual(expect.objectContaining({ apply: "Projects/QuickMemo" }));
  });

  it("suggests supplied headings and block ids for a resolved note", () => {
    const headings = complete("[[Projects/QuickMemo#보");
    const blocks = complete("[[QM#^over");

    expect(headings?.from).toBe("[[Projects/QuickMemo#".length);
    expect(headings?.options).toContainEqual(expect.objectContaining({ apply: "보안]]", label: "보안" }));
    expect(blocks?.from).toBe("[[QM#^".length);
    expect(blocks?.options).toContainEqual(expect.objectContaining({ apply: "overview]]", displayLabel: "^overview", label: "overview" }));
  });

  it("uses the supplied current-note headings and blocks for fragment-only links", () => {
    expect(complete("[[#현")?.options).toContainEqual(expect.objectContaining({ label: "현재 제목" }));
    expect(complete("[[#^cur")?.options).toContainEqual(expect.objectContaining({ displayLabel: "^current-block", label: "current-block" }));
  });

  it("suggests normalized tags while excluding invalid numeric-only tags", () => {
    const result = complete("연결 #pro");

    expect(result?.from).toBe("연결 #".length);
    expect(result?.options).toContainEqual(
      expect.objectContaining({ apply: "project/quickmemo", displayLabel: "#project/quickmemo", label: "project/quickmemo" })
    );
    expect(result?.options).not.toContainEqual(expect.objectContaining({ label: "123" }));
    expect(result?.options.filter((option) => option.label === "업무")).toHaveLength(1);
    expect(complete("#")?.options.length).toBe(2);
  });

  it("does not complete tags inside inline or fenced code", () => {
    expect(complete("`#pro")).toBeNull();
    expect(complete("```\n#pro")).toBeNull();
  });

  it("does not treat a hashtag embedded in a word as a tag trigger", () => {
    expect(complete("plain#pro")).toBeNull();
  });

  it("does not fall back to tag suggestions inside an unresolved wikilink fragment", () => {
    const state = EditorState.create({ doc: "[[#pro", extensions: [markdown()] });
    const result = completeObsidianMarkdown(
      new CompletionContext(state, state.doc.length, false),
      { tags: ["project/quickmemo"] }
    );

    expect(result).toBeNull();
  });

  it("offers slash commands at the start of a Markdown line without vault data", () => {
    const state = EditorState.create({ doc: "  /hea", extensions: [markdown()] });
    const result = completeObsidianMarkdown(
      new CompletionContext(state, state.doc.length, false),
      undefined
    );

    expect(result?.from).toBe(2);
    expect(result?.options).toContainEqual(expect.objectContaining({
      apply: "# ",
      detail: "제목 1",
      label: "/heading-1"
    }));
  });

  it("does not offer slash commands in prose or code", () => {
    expect(complete("문장 /hea")).toBeNull();
    expect(complete("`/hea")).toBeNull();
  });
});
