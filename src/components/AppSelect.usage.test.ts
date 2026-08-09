import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const selectCallSites = [
  ["src/components/AppShell.tsx", 3],
  ["src/pages/AdminPage.tsx", 3],
  ["src/pages/LibraryPage.tsx", 6],
  ["src/pages/NotesPage.tsx", 3],
  ["src/pages/SchedulePage.tsx", 8]
] as const;

function source(filePath: string) {
  return readFileSync(join(process.cwd(), filePath), "utf8");
}

describe("AppSelect adoption", () => {
  it.each(selectCallSites)("%s routes all %i native select call sites through AppSelect", (filePath, expectedCount) => {
    const fileSource = source(filePath);

    expect(fileSource.match(/<AppSelect\b/g) ?? []).toHaveLength(expectedCount);
    expect(fileSource).not.toMatch(/<select\b/);
  });

  it("leaves the NotesPage datalist controls native and unchanged in scope", () => {
    const notesSource = source("src/pages/NotesPage.tsx");

    expect(notesSource.match(/<datalist\b/g) ?? []).toHaveLength(2);
    expect(notesSource.match(/\blist=\{listId\}/g) ?? []).toHaveLength(2);
  });

  it("defines shared theme and interaction states without replacing native select semantics", () => {
    const componentSource = source("src/components/AppSelect.tsx");
    const stylesSource = source("src/styles.css");

    expect(componentSource).toMatch(/<select\b/);
    expect(componentSource).not.toMatch(/\brole=/);
    expect(stylesSource).toContain(".app-select:not(:disabled):hover");
    expect(stylesSource).toContain(".app-select:focus-visible");
    expect(stylesSource).toContain(".app-select:disabled");
    expect(stylesSource).toContain('.app-select[aria-busy="true"]');
    expect(stylesSource).toContain('.app-select[aria-invalid="true"]');
    expect(stylesSource).toMatch(/html\[data-theme="dark"\] select,[\s\S]*background: var\(--color-input-bg\);/);
  });
});
