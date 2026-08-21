import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultGlobalGraphSettings, createDefaultLocalGraphSettings } from "./graphSettings";
import { GraphSettingsDrawer } from "./GraphSettingsDrawer";
import type { GraphViewSettings } from "./types";

function SettingsHarness({ initial }: { initial: GraphViewSettings }) {
  const [settings, setSettings] = useState(initial);
  return (
    <>
      <GraphSettingsDrawer onChange={setSettings} settings={settings} />
      <output data-testid="settings-json">{JSON.stringify(settings)}</output>
    </>
  );
}

describe("GraphSettingsDrawer", () => {
  it("shows Global controls without Local-only controls", () => {
    render(<SettingsHarness initial={createDefaultGlobalGraphSettings()} />);

    expect(screen.getByRole("complementary", { name: "전체 그래프 설정" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "고립된 노트" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "시간순 애니메이션" })).not.toBeChecked();
    expect(screen.queryByRole("slider", { name: "깊이" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "들어오는 링크" })).not.toBeInTheDocument();
  });

  it("shows Local direction, neighbor and depth controls without Global-only controls", () => {
    render(<SettingsHarness initial={createDefaultLocalGraphSettings()} />);

    expect(screen.getByRole("complementary", { name: "로컬 그래프 설정" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "깊이" })).toHaveValue("1");
    expect(screen.getByRole("checkbox", { name: "들어오는 링크" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "나가는 링크" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "인접 노드 사이의 링크" })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "고립된 노트" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "시간순 애니메이션" })).not.toBeInTheDocument();
  });

  it("updates filters, display ranges and restores scope defaults", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness initial={createDefaultGlobalGraphSettings()} />);

    await user.type(screen.getByRole("searchbox", { name: "파일 검색" }), "tag:#work");
    await user.click(screen.getByRole("checkbox", { name: "태그" }));
    await user.click(screen.getByRole("checkbox", { name: "화살표" }));
    await user.click(screen.getByRole("checkbox", { name: "시간순 애니메이션" }));
    expect(screen.getByTestId("settings-json")).toHaveTextContent('"query":"tag:#work"');
    expect(screen.getByTestId("settings-json")).toHaveTextContent('"showTags":true');
    expect(screen.getByTestId("settings-json")).toHaveTextContent('"arrows":true');
    expect(screen.getByTestId("settings-json")).toHaveTextContent('"animate":true');

    await user.click(screen.getByRole("button", { name: "기본 설정 복원" }));
    expect(screen.getByRole("searchbox", { name: "파일 검색" })).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "태그" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "화살표" })).not.toBeChecked();
  });

  it("adds, edits and keyboard-reorders color groups", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness initial={createDefaultGlobalGraphSettings()} />);

    await user.click(screen.getByRole("button", { name: "그룹 추가" }));
    await user.click(screen.getByRole("button", { name: "그룹 추가" }));
    const list = screen.getByRole("list", { name: "그래프 그룹" });
    const queryInputs = within(list).getAllByRole("textbox");
    await user.type(queryInputs[0], "tag:#research");
    await user.type(queryInputs[1], "tag:#work");

    await user.click(screen.getByRole("button", { name: "그룹 2 위로 이동" }));
    expect(within(list).getAllByRole("textbox").map((input) => (input as HTMLInputElement).value)).toEqual([
      "tag:#work",
      "tag:#research"
    ]);
    expect(screen.getByTestId("settings-json")).toHaveTextContent('"order":0');
    expect(screen.getByTestId("settings-json")).toHaveTextContent('"order":1');
  });

  it("reports collapsible section state for encrypted workspace persistence", async () => {
    const user = userEvent.setup();
    const onCollapsedSectionsChange = vi.fn();
    render(
      <GraphSettingsDrawer
        onChange={vi.fn()}
        onCollapsedSectionsChange={onCollapsedSectionsChange}
        settings={createDefaultGlobalGraphSettings()}
      />
    );

    await user.click(screen.getByRole("button", { name: "필터" }));
    expect(screen.getByRole("button", { name: "필터" })).toHaveAttribute("aria-expanded", "false");
    expect(onCollapsedSectionsChange).toHaveBeenLastCalledWith(["filters"]);
  });
});
