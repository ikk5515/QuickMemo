import { describe, expect, it } from "vitest";
import { groupChecklistItems, sortChecklistItems } from "./checklist";

const items = [
  { checked: false, id: "todo-10", text: "10" },
  { checked: true, id: "done-2", text: "2" },
  { checked: false, id: "todo-2", text: "2" },
  { checked: true, id: "done-1", text: "1" },
  { checked: false, id: "todo-1", text: "1" }
];

describe("checklist sorting", () => {
  it("keeps checked items above unchecked items and uses numeric natural order", () => {
    expect(sortChecklistItems(items).map((item) => item.id)).toEqual([
      "done-1",
      "done-2",
      "todo-1",
      "todo-2",
      "todo-10"
    ]);
  });

  it("sorts Korean text with locale-aware order", () => {
    expect(
      sortChecklistItems([
        { checked: false, id: "ga", text: "가" },
        { checked: false, id: "na", text: "나" },
        { checked: false, id: "da", text: "다" }
      ]).map((item) => item.text)
    ).toEqual(["가", "나", "다"]);
  });

  it("sorts English text with locale-aware order", () => {
    expect(
      sortChecklistItems([
        { checked: false, id: "b", text: "B" },
        { checked: false, id: "c", text: "c" },
        { checked: false, id: "a", text: "A" }
      ]).map((item) => item.text)
    ).toEqual(["A", "B", "c"]);
  });

  it("supports descending order inside each checked group without changing ids", () => {
    expect(sortChecklistItems(items, { direction: "desc" }).map((item) => item.id)).toEqual([
      "done-2",
      "done-1",
      "todo-10",
      "todo-2",
      "todo-1"
    ]);
  });

  it("keeps duplicate labels stable by original order", () => {
    const duplicateItems = [
      { checked: false, id: "a", text: "검토" },
      { checked: false, id: "b", text: "검토" },
      { checked: false, id: "c", text: "검토" }
    ];

    expect(sortChecklistItems(duplicateItems).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("groups checked and unchecked items without dropping empty lists", () => {
    const groups = groupChecklistItems(items);

    expect(groups.checkedItems.map((item) => item.id)).toEqual(["done-1", "done-2"]);
    expect(groups.uncheckedItems.map((item) => item.id)).toEqual(["todo-1", "todo-2", "todo-10"]);
    expect(groupChecklistItems([])).toEqual({ checkedItems: [], uncheckedItems: [] });
  });
});
