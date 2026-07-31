import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

afterEach(cleanup);

describe("AppErrorBoundary", () => {
  it("shows a secret-free fallback and can retry the failed subtree", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldFail = true;

    function ThrowingChild() {
      if (shouldFail) {
        throw new Error("sensitive@example.test secret-value");
      }
      return <p>복구 완료</p>;
    }

    render(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("화면을 불러오지 못했습니다");
    expect(alert).not.toHaveTextContent("sensitive@example.test");
    expect(alert).not.toHaveTextContent("secret-value");
    expect(screen.getByRole("button", { name: "페이지 새로고침" })).toBeInTheDocument();

    shouldFail = false;
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(screen.getByText("복구 완료")).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
