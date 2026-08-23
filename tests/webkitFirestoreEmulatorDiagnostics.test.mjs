import { describe, expect, it } from "vitest";
import {
  allowExpectedWebKitFirestoreEmulatorUnloadErrors,
  isExpectedFirestoreEmulatorTransportConsoleError,
  isExpectedWebKitFirestoreEmulatorUnloadPageError
} from "./e2e/helpers.mjs";

describe("WebKit Firestore emulator unload diagnostics", () => {
  it.each(["Listen", "Write"])("accepts only an exact localhost %s WebChannel unload", (method) => {
    expect(isExpectedWebKitFirestoreEmulatorUnloadPageError(
      `/127.0.0.1:8080/google.firestore.v1.Firestore/${method}/channel?VER=8&AID=5 due to access control checks.`
    )).toBe(true);
  });

  it.each([
    "/firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?VER=8 due to access control checks.",
    "/127.0.0.1:8080/google.firestore.v1.Firestore/RunQuery/channel?VER=8 due to access control checks.",
    "/127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?VER=8 PERMISSION_DENIED.",
    "/127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel due to access control checks.",
    "/127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?VER=8 due to access control checks. extra"
  ])("rejects production, non-channel, permission, and altered page errors: %s", (message) => {
    expect(isExpectedWebKitFirestoreEmulatorUnloadPageError(message)).toBe(false);
  });

  it.each(["batchGet", "commit"])("accepts only an exact localhost emulator REST %s page unload", (operation) => {
    expect(isExpectedWebKitFirestoreEmulatorUnloadPageError(
      `/127.0.0.1:8080/v1/projects/quickmemo-share-api-test/databases/(default)/documents:${operation}?key=fake-emulator-api-key due to access control checks.`
    )).toBe(true);
  });

  it.each([
    "/firestore.googleapis.com/v1/projects/quickmemo/databases/(default)/documents:commit?key=fake-emulator-api-key due to access control checks.",
    "/127.0.0.1:8080/v1/projects/quickmemo/databases/(default)/documents:commit?key=production-key due to access control checks.",
    "/127.0.0.1:8080/v1/projects/quickmemo/databases/(default)/documents:runQuery?key=fake-emulator-api-key due to access control checks.",
    "/127.0.0.1:8080/v1/projects/quickmemo/databases/(default)/documents:commit?key=fake-emulator-api-key&unexpected=true due to access control checks.",
    "/127.0.0.1:8080/v1/projects/quickmemo/databases/(default)/documents:commit?key=fake-emulator-api-key due to access control checks. extra"
  ])("rejects production, real-key, other-operation, and altered REST page errors: %s", (message) => {
    expect(isExpectedWebKitFirestoreEmulatorUnloadPageError(message)).toBe(false);
  });

  it("requires both the localhost emulator URL and the exact transient console message", () => {
    const expected = {
      location: "http://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?VER=8",
      text: "Failed to load resource: The network connection was lost."
    };
    expect(isExpectedFirestoreEmulatorTransportConsoleError(expected)).toBe(true);
    expect(isExpectedFirestoreEmulatorTransportConsoleError({
      ...expected,
      location: "https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?VER=8"
    })).toBe(false);
    expect(isExpectedFirestoreEmulatorTransportConsoleError({
      ...expected,
      location: "https://example.com/127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?VER=8"
    })).toBe(false);
    expect(isExpectedFirestoreEmulatorTransportConsoleError({
      ...expected,
      text: "PERMISSION_DENIED"
    })).toBe(false);
  });

  it.each(["batchGet", "commit"])("accepts only an exact localhost emulator REST %s abort", (operation) => {
    const expected = {
      location: `http://127.0.0.1:8080/v1/projects/quickmemo-share-api-test/databases/(default)/documents:${operation}?key=fake-emulator-api-key`,
      text: "Failed to load resource: The network connection was lost."
    };
    expect(isExpectedFirestoreEmulatorTransportConsoleError(expected)).toBe(true);
    expect(isExpectedFirestoreEmulatorTransportConsoleError({
      ...expected,
      location: expected.location.replace("127.0.0.1:8080", "firestore.googleapis.com")
    })).toBe(false);
    expect(isExpectedFirestoreEmulatorTransportConsoleError({
      ...expected,
      location: expected.location.replace("fake-emulator-api-key", "production-key")
    })).toBe(false);
    expect(isExpectedFirestoreEmulatorTransportConsoleError({
      ...expected,
      location: expected.location.replace(`documents:${operation}`, "documents:runQuery")
    })).toBe(false);
    expect(isExpectedFirestoreEmulatorTransportConsoleError({
      ...expected,
      location: `${expected.location}&unexpected=true`
    })).toBe(false);
  });

  it("classifies WebKit's location-less companion only beside an exact emulator commit", () => {
    const companion = { location: "", text: "The network connection was lost." };
    const commit = {
      location: "http://127.0.0.1:8080/v1/projects/quickmemo-share-api-test/databases/(default)/documents:commit?key=fake-emulator-api-key",
      text: "Failed to load resource: The network connection was lost."
    };
    const diagnostics = {
      consoleErrors: [companion, commit],
      expectedTransientFirestoreTransportErrors: new Set(),
      expectedPageErrors: new Set(),
      pageErrors: []
    };
    allowExpectedWebKitFirestoreEmulatorUnloadErrors(diagnostics);
    expect(diagnostics.expectedTransientFirestoreTransportErrors).toEqual(new Set([commit, companion]));

    const isolated = {
      ...diagnostics,
      consoleErrors: [companion],
      expectedTransientFirestoreTransportErrors: new Set()
    };
    allowExpectedWebKitFirestoreEmulatorUnloadErrors(isolated);
    expect(isolated.expectedTransientFirestoreTransportErrors).toEqual(new Set());
  });
});
