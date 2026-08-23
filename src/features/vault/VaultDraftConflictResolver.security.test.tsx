import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VaultDraftConflictResolver } from "./VaultDraftConflictResolver";

describe("VaultDraftConflictResolver security boundary", () => {
  it("renders authorized Markdown as text rather than executable HTML", () => {
    const payload = '<img src=x onerror="window.__mergeXss=1"><script>window.__mergeXss=2</script>';
    render(
      <VaultDraftConflictResolver
        baseMarkdown="base"
        localMarkdown={payload}
        onCancel={vi.fn()}
        onResolve={vi.fn()}
        remoteMarkdown="server"
      />
    );

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("does not contain HTML injection or plaintext logging sinks", () => {
    const source = readFileSync(resolve("src/features/vault/VaultDraftConflictResolver.tsx"), "utf8");
    const model = readFileSync(resolve("src/features/vault/markdownThreeWayMerge.ts"), "utf8");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toMatch(/console\.(?:log|warn|error|debug)/u);
    expect(model).not.toMatch(/console\.(?:log|warn|error|debug)/u);
    expect(source).not.toMatch(/localStorage|sessionStorage/u);
    expect(model).not.toMatch(/localStorage|sessionStorage/u);
  });

  it("accepts no entry, owner, key, ciphertext or revision identifier props", () => {
    const source = readFileSync(resolve("src/features/vault/VaultDraftConflictResolver.tsx"), "utf8");
    const props = source.slice(
      source.indexOf("export interface VaultDraftConflictResolverProps"),
      source.indexOf("function previewText")
    );
    expect(props).not.toMatch(/entryId|noteId|ownerUid|privateKey|wrappedKey|cipherText|revision/u);
  });

  it("never renders a manual plaintext buffer under a replacement document scope", async () => {
    const user = userEvent.setup();
    const rendered = render(
      <VaultDraftConflictResolver
        baseMarkdown="base-a"
        localMarkdown="PRIVATE-LOCAL-A"
        onCancel={vi.fn()}
        onResolve={vi.fn()}
        remoteMarkdown="PRIVATE-REMOTE-A"
      />
    );
    await user.click(screen.getByRole("radio", { name: "직접 편집" }));
    expect(screen.getByRole("textbox", { name: "직접 편집한 병합 내용" })).toHaveValue(
      "PRIVATE-LOCAL-A\nPRIVATE-REMOTE-A"
    );

    rendered.rerender(
      <VaultDraftConflictResolver
        baseMarkdown="base-b"
        localMarkdown="LOCAL-B"
        onCancel={vi.fn()}
        onResolve={vi.fn()}
        remoteMarkdown="REMOTE-B"
      />
    );

    expect(screen.queryByRole("textbox", { name: "직접 편집한 병합 내용" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/PRIVATE-/u)).not.toBeInTheDocument();
  });
});
