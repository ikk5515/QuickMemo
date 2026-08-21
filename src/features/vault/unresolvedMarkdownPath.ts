import { normalizeVaultPath } from "./interop/path";
import { MAX_VAULT_FOLDER_DEPTH } from "./vaultIntegrity";

export interface UnresolvedMarkdownFolderPlan {
  name: string;
  parentPath: string | null;
  path: string;
}

export interface UnresolvedMarkdownTargetPlan {
  folders: UnresolvedMarkdownFolderPlan[];
  targetPath: string;
  title: string;
}

/** Builds an exact, safe Vault path for an unresolved Markdown wikilink. */
export function planUnresolvedMarkdownTarget(requestedPath: string): UnresolvedMarkdownTargetPlan {
  const normalized = normalizeVaultPath(requestedPath.trim());
  const segments = normalized.split("/");
  const requestedFileName = segments.pop() ?? "";
  if (/\.[^./]+$/u.test(requestedFileName) && !/\.md$/iu.test(requestedFileName)) {
    throw new Error("Markdown가 아닌 파일 링크는 빈 노트로 만들 수 없습니다.");
  }
  const title = requestedFileName.replace(/\.md$/iu, "").trim();
  if (!title || title.length > 180) {
    throw new Error("만들 노트의 이름을 확인해주세요.");
  }
  if (segments.some((segment) => !segment.trim() || segment.length > 120)) {
    throw new Error("만들 폴더의 이름을 확인해주세요.");
  }
  if (segments.length - 1 > MAX_VAULT_FOLDER_DEPTH) {
    throw new Error(`폴더 중첩 깊이는 ${MAX_VAULT_FOLDER_DEPTH} 이하여야 합니다.`);
  }

  const folders = segments.map((name, index) => ({
    name,
    parentPath: index === 0 ? null : segments.slice(0, index).join("/"),
    path: segments.slice(0, index + 1).join("/")
  }));
  return {
    folders,
    targetPath: [...segments, `${title}.md`].join("/"),
    title
  };
}
