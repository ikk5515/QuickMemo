import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureErrorBoundary } from "./FeatureErrorBoundary";

function BrokenFeature(): never {
  throw new Error("private provider detail");
}

describe("FeatureErrorBoundary", () => {
  it("keeps a failed feature local without rendering exception details", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <main>
        <p>보존된 작업공간</p>
        <FeatureErrorBoundary fallback={<p role="alert">기능을 불러오지 못했습니다.</p>}>
          <BrokenFeature />
        </FeatureErrorBoundary>
      </main>
    );
    expect(screen.getByText("보존된 작업공간")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("기능을 불러오지 못했습니다.");
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
