import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const adminFunctionsSource = readFileSync(join(process.cwd(), "src/services/adminFunctions.ts"), "utf8");

describe("first admin setup auth isolation", () => {
  it("creates the first admin through an isolated Firebase app instead of the primary auth instance", () => {
    const createFirstAdminSource = adminFunctionsSource.slice(
      adminFunctionsSource.indexOf("export async function createFirstAdmin"),
      adminFunctionsSource.indexOf("export async function createUser")
    );

    expect(createFirstAdminSource).toContain("createSecondaryAuthUser");
    expect(createFirstAdminSource).toContain("created.db");
    expect(createFirstAdminSource).toContain("created.cleanup");
    expect(createFirstAdminSource).not.toContain("createUserWithEmailAndPassword(auth");
  });
});
