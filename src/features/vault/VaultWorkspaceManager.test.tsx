import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  captureVaultWorkspaceLayout,
  createDefaultVaultWorkspaceState,
  type PersistedVaultBookmark
} from "./workspaceState";
import { VaultWorkspaceManager } from "./VaultWorkspaceManager";

const bookmarks: PersistedVaultBookmark[] = [
  { kind: "entry", id: "entry-a", entryId: "allowed", label: "중요 노트", path: "Project/중요.md", createdAt: 1 },
  { kind: "entry", id: "entry-revoked", entryId: "revoked", label: "철회된 비밀 제목", path: "Private/철회된-비밀.md", createdAt: 2 },
  { kind: "search", id: "search-a", label: "프로젝트 검색", query: "tag:project", createdAt: 3 },
  {
    kind: "graph",
    id: "graph-a",
    label: "프로젝트 그래프",
    createdAt: 4,
    settings: createDefaultVaultWorkspaceState().globalGraph.settings,
    viewport: { centerX: 0, centerY: 0, zoom: 1 }
  }
];

function renderManager(overrides: Partial<React.ComponentProps<typeof VaultWorkspaceManager>> = {}) {
  const props: React.ComponentProps<typeof VaultWorkspaceManager> = {
    activeEntryId: "allowed",
    bookmarks,
    canBookmarkGraph: true,
    canBookmarkSearch: true,
    entries: [{ id: "allowed", title: "현재 제목", path: "Project/현재.md" }],
    namedWorkspaces: [{
      id: "workspace-a",
      label: "집필 작업",
      createdAt: 1,
      updatedAt: 1,
      snapshot: captureVaultWorkspaceLayout(createDefaultVaultWorkspaceState())
    }],
    onAddBookmark: vi.fn(),
    onCaptureWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onOpenBookmark: vi.fn(),
    onRemoveBookmark: vi.fn(),
    onRenameWorkspace: vi.fn(),
    onRestoreWorkspace: vi.fn(),
    ...overrides
  };
  return { props, ...render(<VaultWorkspaceManager {...props} />) };
}

describe("VaultWorkspaceManager", () => {
  it("redacts persisted labels and paths for ACL-missing entry bookmarks", () => {
    renderManager();

    expect(screen.getByText("사용할 수 없는 항목")).toBeInTheDocument();
    expect(screen.getByText("권한이 없거나 삭제된 항목")).toBeInTheDocument();
    expect(screen.queryByText("철회된 비밀 제목")).not.toBeInTheDocument();
    expect(screen.queryByText("Private/철회된-비밀.md")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "사용할 수 없는 항목 북마크 열기" })).toBeDisabled();
    expect(screen.getByText("Project/현재.md")).toBeInTheDocument();
  });

  it("adds each current view type and opens or removes a bookmark", () => {
    const { props } = renderManager();
    fireEvent.change(screen.getByLabelText("새 북마크 이름"), { target: { value: "  자주 보기  " } });
    fireEvent.click(screen.getByRole("button", { name: "노트" }));
    expect(props.onAddBookmark).toHaveBeenCalledWith("entry", "자주 보기");

    fireEvent.change(screen.getByLabelText("새 북마크 이름"), { target: { value: "검색 보기" } });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(props.onAddBookmark).toHaveBeenCalledWith("search", "검색 보기");

    fireEvent.change(screen.getByLabelText("새 북마크 이름"), { target: { value: "그래프 보기" } });
    fireEvent.click(screen.getByRole("button", { name: "그래프" }));
    expect(props.onAddBookmark).toHaveBeenCalledWith("graph", "그래프 보기");

    fireEvent.click(screen.getByRole("button", { name: "프로젝트 검색 북마크 열기" }));
    expect(props.onOpenBookmark).toHaveBeenCalledWith(expect.objectContaining({ kind: "search", id: "search-a" }));
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 그래프 북마크 삭제" }));
    expect(props.onRemoveBookmark).toHaveBeenCalledWith(expect.objectContaining({ kind: "graph", id: "graph-a" }));
  });

  it("captures, restores, renames, and deletes named workspaces", () => {
    const { props } = renderManager();
    fireEvent.change(screen.getByLabelText("현재 배치 이름"), { target: { value: "  연구 배치  " } });
    fireEvent.click(screen.getByRole("button", { name: "현재 배치 저장" }));
    expect(props.onCaptureWorkspace).toHaveBeenCalledWith("연구 배치");

    fireEvent.click(screen.getByRole("button", { name: "집필 작업 워크스페이스 복원" }));
    expect(props.onRestoreWorkspace).toHaveBeenCalledWith("workspace-a");
    fireEvent.click(screen.getByRole("button", { name: "집필 작업 워크스페이스 이름 변경" }));
    fireEvent.change(screen.getByLabelText("워크스페이스 새 이름"), { target: { value: "새 집필" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(props.onRenameWorkspace).toHaveBeenCalledWith("workspace-a", "새 집필");

    fireEvent.click(screen.getByRole("button", { name: "집필 작업 워크스페이스 삭제" }));
    expect(props.onDeleteWorkspace).toHaveBeenCalledWith("workspace-a");
  });

  it("states that split direction and ratio are encrypted with the workspace", () => {
    renderManager();
    expect(screen.getByText(/분할 방향·비율을 암호화해 저장합니다/u)).toBeInTheDocument();
  });
});
