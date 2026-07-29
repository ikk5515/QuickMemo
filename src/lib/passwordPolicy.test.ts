import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  minimumNewPasswordLength,
  newPasswordMeetsMinimum
} from "./passwordPolicy";

const adminFunctionsSource = readFileSync(
  join(process.cwd(), "src/services/adminFunctions.ts"),
  "utf8"
);

describe("managed account password policy", () => {
  it("requires at least eight Unicode characters for new or changed passwords", () => {
    expect(minimumNewPasswordLength).toBe(8);
    expect(newPasswordMeetsMinimum("1234567")).toBe(false);
    expect(newPasswordMeetsMinimum("12345678")).toBe(true);
    expect(newPasswordMeetsMinimum("암호🔐보안키값테")).toBe(true);
  });

  it("enforces the policy again at both managed account service entry points", () => {
    const firstAdmin = adminFunctionsSource.match(
      /export async function createFirstAdmin[\s\S]*?export async function createUser/u
    )?.[0] ?? "";
    const managedUser = adminFunctionsSource.match(
      /export async function createUser[\s\S]*?export async function updateUser/u
    )?.[0] ?? "";

    expect(firstAdmin).toContain("assertNewPasswordPolicy(payload.password)");
    expect(managedUser).toContain("assertNewPasswordPolicy(payload.password)");
  });
});
