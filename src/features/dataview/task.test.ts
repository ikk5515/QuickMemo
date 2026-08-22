import { describe, expect, it } from "vitest";
import { extractDataviewTasks, setDataviewTaskChecked } from "./task";

describe("extractDataviewTasks", () => {
  it("extracts ordered, unordered and quoted tasks with source lines", () => {
    expect(extractDataviewTasks([
      "- [ ] 첫 작업",
      "2. [x] 완료 작업",
      "> - [X] 인용 작업"
    ].join("\n"))).toEqual([
      { checked: false, line: 1, text: "첫 작업" },
      { checked: true, line: 2, text: "완료 작업" },
      { checked: true, line: 3, text: "인용 작업" }
    ]);
  });

  it("ignores task-looking input inside fenced code", () => {
    expect(extractDataviewTasks("```md\n- [ ] 코드\n```\n- [ ] 실제")).toEqual([
      { checked: false, line: 4, text: "실제" }
    ]);
  });

  it("changes only an exact task source line", () => {
    expect(setDataviewTaskChecked("본문\n- [ ] 실제\n끝", 2, true)).toBe("본문\n- [x] 실제\n끝");
    expect(setDataviewTaskChecked("본문\n일반", 2, true)).toBeNull();
    expect(setDataviewTaskChecked("- [x] 완료", 1, true)).toBe("- [x] 완료");
    expect(setDataviewTaskChecked("- [ ] 바뀐 작업", 1, true, { checked: false, text: "이전 작업" })).toBeNull();
  });
});
