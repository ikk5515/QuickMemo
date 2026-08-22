/* global Buffer */

import {
  HttpError,
  firestoreDocumentName,
  toFirestoreFields,
  toFirestoreValue
} from "./_secure-share-common.js";

export const VAULT_FOLDER_TREE_SCHEMA_VERSION = 1;
export const VAULT_FOLDER_TREE_MAX_FOLDERS = 2_000;
export const VAULT_FOLDER_TREE_MAX_DEPTH = 32;
// Firestore documents are limited to 1 MiB. Leave substantial room for field
// names, protobuf overhead, timestamps, and future schema additions.
export const VAULT_FOLDER_TREE_MAX_JSON_BYTES = 700_000;

const safeFolderIdPattern = /^[A-Za-z0-9_-]{1,120}$/u;
const unsafeDynamicFieldIds = new Set(["__proto__", "constructor", "prototype"]);

function invalidTree(message = "Invalid vault folder tree") {
  return new HttpError(409, "vault_tree_invalid", message, { expose: false });
}

export function assertVaultFolderId(value, fieldName = "folderId") {
  if (
    typeof value !== "string"
    || !safeFolderIdPattern.test(value)
    || unsafeDynamicFieldIds.has(value)
  ) {
    throw new HttpError(400, "invalid_request", `Invalid ${fieldName}`);
  }
  return value;
}

function integerInRange(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function assertNodeShape(folderId, candidate) {
  assertVaultFolderId(folderId);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw invalidTree();
  }
  const keys = Object.keys(candidate);
  if (
    !keys.every((key) => ["parentId", "active", "selfActive", "generation"].includes(key))
    || !keys.includes("parentId")
    || !keys.includes("active")
    || !keys.includes("selfActive")
    || !keys.includes("generation")
    || (candidate.parentId !== null && !safeFolderIdPattern.test(candidate.parentId))
    || typeof candidate.active !== "boolean"
    || typeof candidate.selfActive !== "boolean"
    || !integerInRange(candidate.generation, 1, 999_999_999_999)
  ) {
    throw invalidTree();
  }
  return {
    active: candidate.active,
    generation: candidate.generation,
    parentId: candidate.parentId,
    selfActive: candidate.selfActive
  };
}

function depthAndEffectiveState(nodes) {
  const depthById = new Map();
  const effectiveById = new Map();
  const visiting = new Set();

  const visit = (folderId) => {
    if (depthById.has(folderId)) {
      return { depth: depthById.get(folderId), active: effectiveById.get(folderId) };
    }
    if (visiting.has(folderId)) {
      throw invalidTree("Vault folder tree contains a cycle");
    }
    const node = nodes[folderId];
    if (!node) {
      throw invalidTree("Vault folder tree references a missing parent");
    }
    visiting.add(folderId);
    let depth = 0;
    let parentActive = true;
    if (node.parentId !== null) {
      if (node.parentId === folderId || !nodes[node.parentId]) {
        throw invalidTree("Vault folder tree references an invalid parent");
      }
      const parent = visit(node.parentId);
      depth = parent.depth + 1;
      parentActive = parent.active;
    }
    if (depth > VAULT_FOLDER_TREE_MAX_DEPTH) {
      throw new HttpError(409, "vault_depth_exceeded", "Vault folder depth limit exceeded");
    }
    const active = node.selfActive && parentActive;
    visiting.delete(folderId);
    depthById.set(folderId, depth);
    effectiveById.set(folderId, active);
    return { depth, active };
  };

  Object.keys(nodes).forEach(visit);
  return { depthById, effectiveById };
}

function cloneNodes(nodes) {
  return Object.fromEntries(Object.entries(nodes).map(([folderId, node]) => [
    folderId,
    { ...node }
  ]));
}

function normalizedTree(candidate, { recomputeActive = false } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw invalidTree();
  }
  const keys = Object.keys(candidate);
  if (!keys.every((key) => ["schemaVersion", "revision", "folderCount", "nodes"].includes(key))) {
    throw invalidTree();
  }
  if (
    candidate.schemaVersion !== VAULT_FOLDER_TREE_SCHEMA_VERSION
    || !integerInRange(candidate.revision, 1, 999_999_999_999)
    || !integerInRange(candidate.folderCount, 0, VAULT_FOLDER_TREE_MAX_FOLDERS)
    || !candidate.nodes
    || typeof candidate.nodes !== "object"
    || Array.isArray(candidate.nodes)
  ) {
    throw invalidTree();
  }
  const entries = Object.entries(candidate.nodes);
  if (entries.length !== candidate.folderCount || entries.length > VAULT_FOLDER_TREE_MAX_FOLDERS) {
    throw invalidTree();
  }
  const nodes = {};
  for (const [folderId, node] of entries) {
    nodes[folderId] = assertNodeShape(folderId, node);
  }
  const { effectiveById } = depthAndEffectiveState(nodes);
  for (const [folderId, node] of Object.entries(nodes)) {
    const expected = effectiveById.get(folderId);
    if (!recomputeActive && node.active !== expected) {
      throw invalidTree("Vault folder active state is inconsistent");
    }
    node.active = expected;
  }
  const tree = {
    folderCount: entries.length,
    nodes,
    revision: candidate.revision,
    schemaVersion: VAULT_FOLDER_TREE_SCHEMA_VERSION
  };
  assertVaultFolderTreeSize(tree);
  return tree;
}

export function validateVaultFolderTree(candidate) {
  return normalizedTree(candidate);
}

export function assertVaultFolderTreeSize(tree) {
  const bytes = Buffer.byteLength(JSON.stringify(tree), "utf8");
  if (bytes > VAULT_FOLDER_TREE_MAX_JSON_BYTES) {
    throw new HttpError(409, "vault_tree_capacity", "Vault folder tree capacity exceeded");
  }
  return bytes;
}

export function buildVaultFolderTree(folders, revision = 1) {
  if (!Array.isArray(folders)) {
    throw invalidTree();
  }
  const nodes = {};
  for (const folder of folders) {
    if (!folder || typeof folder !== "object" || !folder.encryptedName || !folder.wrappedKey) {
      continue;
    }
    const folderId = assertVaultFolderId(folder.__id, "stored folder id");
    if (Object.keys(nodes).length >= VAULT_FOLDER_TREE_MAX_FOLDERS) {
      throw new HttpError(409, "vault_tree_capacity", "Vault folder count limit exceeded");
    }
    if (nodes[folderId]) {
      throw invalidTree("Vault folder tree contains a duplicate id");
    }
    const parentId = folder.parentId ?? null;
    if (parentId !== null) {
      assertVaultFolderId(parentId, "stored parent id");
    }
    nodes[folderId] = {
      active: false,
      generation: integerInRange(folder.vaultLineageGeneration, 1, 999_999_999_999)
        ? folder.vaultLineageGeneration
        : 1,
      parentId,
      selfActive: folder.isDeleted !== true
    };
  }
  return normalizedTree({
    folderCount: Object.keys(nodes).length,
    nodes,
    revision,
    schemaVersion: VAULT_FOLDER_TREE_SCHEMA_VERSION
  }, { recomputeActive: true });
}

export function vaultFolderAncestors(treeCandidate, folderId) {
  const tree = validateVaultFolderTree(treeCandidate);
  assertVaultFolderId(folderId);
  const ancestors = [];
  let current = tree.nodes[folderId]?.parentId ?? null;
  while (current !== null) {
    ancestors.unshift(current);
    current = tree.nodes[current].parentId;
  }
  return ancestors;
}

function nextTree(candidate, mutate) {
  const current = validateVaultFolderTree(candidate);
  if (current.revision >= 999_999_999_999) {
    throw invalidTree("Vault folder tree revision exhausted");
  }
  const nodes = cloneNodes(current.nodes);
  mutate(nodes);
  return normalizedTree({
    folderCount: Object.keys(nodes).length,
    nodes,
    revision: current.revision + 1,
    schemaVersion: VAULT_FOLDER_TREE_SCHEMA_VERSION
  }, { recomputeActive: true });
}

export function createVaultFolderNode(tree, { folderId, parentId }) {
  assertVaultFolderId(folderId);
  if (parentId !== null) {
    assertVaultFolderId(parentId, "parentId");
  }
  return nextTree(tree, (nodes) => {
    if (nodes[folderId]) {
      throw new HttpError(409, "vault_folder_conflict", "Vault folder already exists");
    }
    if (Object.keys(nodes).length >= VAULT_FOLDER_TREE_MAX_FOLDERS) {
      throw new HttpError(409, "vault_tree_capacity", "Vault folder count limit exceeded");
    }
    if (parentId !== null && (!nodes[parentId] || !nodes[parentId].active)) {
      throw new HttpError(409, "vault_parent_unavailable", "Vault parent is unavailable");
    }
    nodes[folderId] = { active: true, generation: 1, parentId, selfActive: true };
  });
}

export function moveVaultFolderNode(tree, { folderId, parentId }) {
  assertVaultFolderId(folderId);
  if (parentId !== null) {
    assertVaultFolderId(parentId, "parentId");
  }
  return nextTree(tree, (nodes) => {
    const node = nodes[folderId];
    if (!node || !node.selfActive) {
      throw new HttpError(409, "vault_folder_unavailable", "Vault folder is unavailable");
    }
    if (parentId !== null && (!nodes[parentId] || !nodes[parentId].active)) {
      throw new HttpError(409, "vault_parent_unavailable", "Vault parent is unavailable");
    }
    if (node.parentId === parentId) {
      throw new HttpError(409, "vault_folder_unchanged", "Vault parent is unchanged");
    }
    node.parentId = parentId;
    node.generation += 1;
  });
}

export function setVaultFolderLifecycle(tree, { folderId, active }) {
  assertVaultFolderId(folderId);
  if (typeof active !== "boolean") {
    throw new HttpError(400, "invalid_request", "Invalid folder lifecycle state");
  }
  return nextTree(tree, (nodes) => {
    const node = nodes[folderId];
    if (!node || node.selfActive === active) {
      throw new HttpError(409, "vault_folder_state_conflict", "Vault folder lifecycle state changed");
    }
    if (active && node.parentId !== null && !nodes[node.parentId]?.active) {
      throw new HttpError(409, "vault_parent_unavailable", "Restore the parent folder first");
    }
    node.selfActive = active;
    node.generation += 1;
  });
}

export function vaultFolderTreeMatchesFolders(treeCandidate, folders) {
  try {
    const expected = buildVaultFolderTree(folders, treeCandidate?.revision ?? 1);
    const actual = validateVaultFolderTree(treeCandidate);
    const ids = Object.keys(actual.nodes);
    return actual.folderCount === expected.folderCount
      && ids.every((folderId) => (
        expected.nodes[folderId]
        && actual.nodes[folderId].active === expected.nodes[folderId].active
        && actual.nodes[folderId].generation === expected.nodes[folderId].generation
        && actual.nodes[folderId].parentId === expected.nodes[folderId].parentId
        && actual.nodes[folderId].selfActive === expected.nodes[folderId].selfActive
      ));
  } catch {
    return false;
  }
}

function nodeFirestoreValue(node) {
  return {
    mapValue: {
      fields: toFirestoreFields({
        active: node.active,
        generation: node.generation,
        parentId: node.parentId,
        selfActive: node.selfActive
      })
    }
  };
}

export function vaultFolderTreeFirestoreFields(ownerUid, treeCandidate, createdAt, updatedAt) {
  const tree = validateVaultFolderTree(treeCandidate);
  const nodes = {};
  for (const [folderId, node] of Object.entries(tree.nodes)) {
    // This is the only dynamic Firestore map writer. IDs were validated with a
    // conservative field-segment alphabet before reaching this encoder.
    nodes[folderId] = nodeFirestoreValue(node);
  }
  return {
    createdAt: toFirestoreValue(createdAt),
    folderCount: toFirestoreValue(tree.folderCount),
    nodes: { mapValue: { fields: nodes } },
    ownerUid: toFirestoreValue(ownerUid),
    revision: toFirestoreValue(tree.revision),
    schemaVersion: toFirestoreValue(tree.schemaVersion),
    updatedAt: toFirestoreValue(updatedAt)
  };
}

export function vaultFolderTreeDocumentWrite(
  projectId,
  ownerUid,
  tree,
  { createdAt, updatedAt, updateTime = "" }
) {
  const update = {
    name: firestoreDocumentName(projectId, `vaultFolderTrees/${ownerUid}`),
    fields: vaultFolderTreeFirestoreFields(ownerUid, tree, createdAt, updatedAt)
  };
  if (updateTime) {
    return { update, currentDocument: { updateTime } };
  }
  return { update, currentDocument: { exists: false } };
}
