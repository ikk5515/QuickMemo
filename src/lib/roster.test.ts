import { describe, expect, it } from "vitest";
import { findRosterByShortcut, initialsFromName, sortRoster } from "./roster";
import type { PublicRosterUser } from "../types";

const users: PublicRosterUser[] = [
  {
    uid: "b",
    displayName: "Beta",
    avatarText: "B",
    color: "#c75146",
    order: 2,
    quickKey: 2,
    loginEmail: "b@quickmemo.local",
    isActive: true,
    isAdmin: false
  },
  {
    uid: "a",
    displayName: "Alpha",
    avatarText: "A",
    color: "#2f7d70",
    order: 1,
    quickKey: 1,
    loginEmail: "a@quickmemo.local",
    isActive: true,
    isAdmin: true
  },
  {
    uid: "j",
    displayName: "Ten",
    avatarText: "T",
    color: "#3f6fb5",
    order: 3,
    quickKey: 10,
    loginEmail: "j@quickmemo.local",
    isActive: true,
    isAdmin: false
  }
];

describe("roster helpers", () => {
  it("sorts users by admin-controlled order", () => {
    expect(sortRoster(users).map((user) => user.uid)).toEqual(["a", "b", "j"]);
  });

  it("maps number keys to quick login users", () => {
    expect(findRosterByShortcut(users, "1")?.uid).toBe("a");
    expect(findRosterByShortcut(users, "0")?.uid).toBe("j");
    expect(findRosterByShortcut(users, "x")).toBeUndefined();
  });

  it("builds compact initials from names", () => {
    expect(initialsFromName("Kim Admin")).toBe("KA");
  });
});
