export type ChecklistSortDirection = "asc" | "desc";

export interface ChecklistSortableItem {
  checked: boolean;
  id: string;
  text: string;
}

export interface ChecklistSortOptions {
  checkedFirst?: boolean;
  direction?: ChecklistSortDirection;
  locale?: string;
  numeric?: boolean;
}

const defaultChecklistSortOptions: Required<ChecklistSortOptions> = {
  checkedFirst: true,
  direction: "asc",
  locale: "ko-KR",
  numeric: true
};

function checklistCollator(options: Required<ChecklistSortOptions>) {
  return new Intl.Collator(options.locale, {
    numeric: options.numeric,
    sensitivity: "base"
  });
}

export function sortChecklistItems<TItem extends ChecklistSortableItem>(
  items: TItem[],
  options: ChecklistSortOptions = {}
) {
  const sortOptions = { ...defaultChecklistSortOptions, ...options };
  const collator = checklistCollator(sortOptions);
  const directionMultiplier = sortOptions.direction === "desc" ? -1 : 1;

  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.checked !== right.item.checked) {
        return sortOptions.checkedFirst
          ? Number(right.item.checked) - Number(left.item.checked)
          : Number(left.item.checked) - Number(right.item.checked);
      }

      const textOrder = collator.compare(left.item.text.trim(), right.item.text.trim()) * directionMultiplier;

      if (textOrder !== 0) {
        return textOrder;
      }

      return left.index - right.index || left.item.id.localeCompare(right.item.id);
    })
    .map(({ item }) => item);
}

export function groupChecklistItems<TItem extends ChecklistSortableItem>(
  items: TItem[],
  options: Omit<ChecklistSortOptions, "checkedFirst"> = {}
) {
  const sortedItems = sortChecklistItems(items, { ...options, checkedFirst: true });

  return {
    checkedItems: sortedItems.filter((item) => item.checked),
    uncheckedItems: sortedItems.filter((item) => !item.checked)
  };
}
