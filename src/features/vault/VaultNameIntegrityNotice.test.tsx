import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VaultNameIntegrityNotice from "./VaultNameIntegrityNotice";

describe("VaultNameIntegrityNotice", () => {
  it("shows a repairable collision path and wires both explicit actions", () => {
    const onRepair = vi.fn();
    const onRetry = vi.fn();
    render(
      <VaultNameIntegrityNotice
        collisionLabels={["프로젝트/기록.md"]}
        failure={null}
        migrationStatus="blocked"
        online
        onRepair={onRepair}
        onRetry={onRetry}
        progress={null}
        repairBusy={false}
        repairCount={2}
      />
    );
    expect(screen.getByRole("alert", { name: "Vault 이름 무결성 준비" }))
      .toHaveTextContent("프로젝트/기록.md 외");
    fireEvent.click(screen.getByRole("button", { name: "충돌 이름 바꾸기" }));
    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    expect(onRepair).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("locks both actions while a collision repair is in progress", () => {
    render(
      <VaultNameIntegrityNotice
        collisionLabels={["기록.md"]}
        failure={null}
        migrationStatus="blocked"
        online
        onRepair={vi.fn()}
        onRetry={vi.fn()}
        progress={null}
        repairBusy
        repairCount={1}
      />
    );
    expect(screen.getByRole("alert")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "정리 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "다시 확인" })).toBeDisabled();
  });
});
