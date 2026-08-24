import "@testing-library/jest-dom/vitest";

// jsdom does not implement Range geometry. CodeMirror schedules a final
// measurement frame after document changes, so provide the browser contract
// instead of allowing an otherwise-clean test to fail after unmount.
if (typeof Range !== "undefined" && typeof Range.prototype.getClientRects !== "function") {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => []
  });
}
