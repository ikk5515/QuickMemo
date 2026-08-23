import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/features/kanban/kanban.css"), "utf8");

function ruleBodiesForSelector(css: string, selector: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((match) => match[1]
      .split(",")
      .some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]);
}

describe("Kanban responsive checkbox styles", () => {
  it("pins the native checkbox to an explicit desktop grid cell and minimum size", () => {
    expect(ruleBodiesForSelector(styles, ".qm-kanban-card")).toEqual(expect.arrayContaining([
      expect.stringMatching(/display:\s*grid;[\s\S]*grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto;/u)
    ]));
    expect(ruleBodiesForSelector(styles, '.qm-kanban-card > input[type="checkbox"]')).toEqual(expect.arrayContaining([
      expect.stringMatching(/grid-column:\s*2;[\s\S]*grid-row:\s*1;[\s\S]*height:\s*18px;[\s\S]*min-width:\s*18px;[\s\S]*width:\s*18px;/u)
    ]));
  });

  it("prevents WebKit from shrinking either mobile or coarse-pointer checkbox targets below 44px", () => {
    const touchCheckboxBodies = ruleBodiesForSelector(styles, '.qm-kanban-card > input[type="checkbox"]')
      .filter((body) => /min-width:\s*44px;/u.test(body));

    expect(touchCheckboxBodies).toHaveLength(2);
    for (const body of touchCheckboxBodies) {
      expect(body).toMatch(/height:\s*44px;/u);
      expect(body).toMatch(/min-width:\s*44px;/u);
      expect(body).toMatch(/width:\s*44px;/u);
    }
  });

  it("keeps nested checklist controls touch-sized too", () => {
    const touchCheckboxBodies = ruleBodiesForSelector(styles, '.qm-kanban-checklist-item > input[type="checkbox"]')
      .filter((body) => /min-width:\s*44px;/u.test(body));
    expect(touchCheckboxBodies).toHaveLength(2);
    for (const body of touchCheckboxBodies) expect(body).toMatch(/min-width:\s*44px;/u);
  });

  it("keeps import, export and confirmation controls touch-sized on mobile", () => {
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.qm-kanban-interop-toolbar button,[\s\S]*?\.qm-kanban-interop button,[\s\S]*?\.qm-kanban-interop textarea \{ min-height: 44px;/u);
    const confirmationBodies = ruleBodiesForSelector(styles, ".qm-kanban-import-confirm input")
      .filter((body) => /min-width:\s*44px;/u.test(body));
    expect(confirmationBodies).toHaveLength(2);
  });
});
