import { describe, expect, it } from "vitest";
import {
  applyTemplateInsertion,
  renderSafeTemplate,
  safeTemplatePromptNames
} from "./templateEngine";

describe("renderSafeTemplate", () => {
  const context = { now: new Date(2026, 7, 22, 5, 4, 9), title: "회의록" };

  it("expands only the documented deterministic tokens", () => {
    expect(renderSafeTemplate(
      "# {{title}}\n{{date}} {{time}} {{date:YYYY/MM/DD HH:mm:ss}} {{time:HH.mm.ss}}|",
      context
    )).toEqual({
      text: "# 회의록\n2026-08-22 05:04 2026/08/22 05:04:09 05.04.09|",
      warnings: []
    });
  });

  it("applies the same strict format whitelist to custom date and time tokens", () => {
    const result = renderSafeTemplate("{{time:HH:mm}} {{time:<script>}}", context);

    expect(result.text).toBe("05:04 {{time:<script>}}");
    expect(result.warnings.join(" ")).toContain("날짜·시간 형식");
  });

  it("does not execute or discard script-like syntax", () => {
    const result = renderSafeTemplate("<% fetch('https://example.com') %> {{js:alert(1)}}", context);
    expect(result.text).toContain("fetch");
    expect(result.text).toContain("{{js:alert(1)}}");
    expect(result.warnings.join(" ")).toContain("실행하지");
  });

  it("fills the current path and explicitly approved prompt values", () => {
    const result = renderSafeTemplate(
      "{{path}}\n참석자: {{prompt:참석자}}\n안건: {{prompt:안건}}",
      { ...context, inputs: { "참석자": "김민수", "안건": "릴리스" }, path: "Meetings/회의록.md" }
    );
    expect(result).toEqual({
      text: "Meetings/회의록.md\n참석자: 김민수\n안건: 릴리스",
      warnings: []
    });
    expect(safeTemplatePromptNames("{{prompt:참석자}} {{ prompt:참석자 }} {{prompt:안건}}"))
      .toEqual(["참석자", "안건"]);
  });

  it("keeps unapproved prompt and unavailable path tokens intact", () => {
    const result = renderSafeTemplate("{{path}} {{prompt:비밀}}", context);
    expect(result.text).toBe("{{path}} {{prompt:비밀}}");
    expect(result.warnings.join(" ")).toContain("원문");
  });

  it("expands a caller-provided selection and records the first cursor position", () => {
    const result = renderSafeTemplate(
      "앞 {{selection}} {{cursor}}뒤{{cursor}}",
      { ...context, selection: "선택 문장" }
    );

    expect(result).toEqual({
      cursorOffset: "앞 선택 문장 ".length,
      text: "앞 선택 문장 뒤",
      warnings: []
    });
  });

  it("keeps selection literal when the editor did not provide one", () => {
    const result = renderSafeTemplate("{{selection}}", context);
    expect(result.text).toBe("{{selection}}");
    expect(result.warnings.join(" ")).toContain("선택한 텍스트가 없어");
  });

  it("replaces the selected range and restores the requested cursor", () => {
    const rendered = renderSafeTemplate("A{{cursor}}B", context);
    expect(applyTemplateInsertion("012345", 2, 4, rendered)).toEqual({
      cursor: 3,
      text: "01AB45"
    });
    expect(applyTemplateInsertion("메모", 99, 1, { text: "!" })).toEqual({
      cursor: 3,
      text: "메모!"
    });
  });

  it("rejects oversized templates", () => {
    expect(() => renderSafeTemplate("a".repeat(500_001), context)).toThrow("500,000");
  });
});
