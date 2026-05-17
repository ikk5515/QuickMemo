import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

initializeApp();

const auth = getAuth();
const db = getFirestore();

type JsonWebKey = Record<string, unknown>;

interface EncryptedPayload {
  version: 1;
  algorithm: "AES-GCM";
  cipherText: string;
  iv: string;
}

interface UserKeyBundle {
  publicKeyJwk: JsonWebKey;
  encryptedPrivateKeyJwk: EncryptedPayload;
  kdfSalt: string;
  kdfIterations: number;
}

interface NewUserPayload {
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  password: string;
  isAdmin: boolean;
  keyBundle: UserKeyBundle;
}

interface UpdateUserPayload {
  uid: string;
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  order: number;
  isActive: boolean;
  isAdmin: boolean;
}

const callableOptions = {
  region: "asia-northeast3",
  maxInstances: 10
};

function assertString(value: unknown, name: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new HttpsError("invalid-argument", `${name} 값이 올바르지 않습니다.`);
  }

  return value.trim();
}

function assertBoolean(value: unknown, name: string) {
  if (typeof value !== "boolean") {
    throw new HttpsError("invalid-argument", `${name} 값이 올바르지 않습니다.`);
  }

  return value;
}

function assertPassword(value: unknown) {
  if (typeof value !== "string" || value.length < 6 || value.length > 128) {
    throw new HttpsError("invalid-argument", "비밀번호는 6자 이상이어야 합니다.");
  }

  return value;
}

function assertPositiveInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 99) {
    throw new HttpsError("invalid-argument", `${name} 값이 올바르지 않습니다.`);
  }

  return value;
}

function assertKeyBundle(value: unknown) {
  const bundle = value as Partial<UserKeyBundle> | undefined;

  if (
    !bundle ||
    !bundle.publicKeyJwk ||
    !bundle.encryptedPrivateKeyJwk ||
    typeof bundle.kdfSalt !== "string" ||
    typeof bundle.kdfIterations !== "number"
  ) {
    throw new HttpsError("invalid-argument", "사용자 암호화 키가 올바르지 않습니다.");
  }

  return bundle as UserKeyBundle;
}

function normalizeNewUserPayload(data: unknown): NewUserPayload {
  const payload = data as Partial<NewUserPayload>;

  return {
    displayName: assertString(payload.displayName, "이름", 24),
    avatarText: assertString(payload.avatarText, "원 안 글자", 3).toUpperCase(),
    color: assertString(payload.color, "색상", 16),
    quickKey: assertPositiveInteger(payload.quickKey, "빠른 로그인 번호"),
    password: assertPassword(payload.password),
    isAdmin: assertBoolean(payload.isAdmin, "관리자 권한"),
    keyBundle: assertKeyBundle(payload.keyBundle)
  };
}

function normalizeUpdateUserPayload(data: unknown): UpdateUserPayload {
  const payload = data as Partial<UpdateUserPayload>;

  return {
    uid: assertString(payload.uid, "사용자 ID", 128),
    displayName: assertString(payload.displayName, "이름", 24),
    avatarText: assertString(payload.avatarText, "원 안 글자", 3).toUpperCase(),
    color: assertString(payload.color, "색상", 16),
    quickKey: assertPositiveInteger(payload.quickKey, "빠른 로그인 번호"),
    order: assertPositiveInteger(payload.order, "순서"),
    isActive: assertBoolean(payload.isActive, "활성 상태"),
    isAdmin: assertBoolean(payload.isAdmin, "관리자 권한")
  };
}

async function requireAdmin(uid?: string) {
  if (!uid) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const userSnapshot = await db.doc(`users/${uid}`).get();

  if (!userSnapshot.exists || userSnapshot.get("isAdmin") !== true || userSnapshot.get("isActive") !== true) {
    throw new HttpsError("permission-denied", "관리자 권한이 필요합니다.");
  }
}

async function assertQuickKeyAvailable(quickKey: number, exceptUid?: string) {
  const quickKeySnapshot = await db.doc(`quickLoginKeys/${quickKey}`).get();

  if (quickKeySnapshot.exists && quickKeySnapshot.get("uid") !== exceptUid) {
    throw new HttpsError("already-exists", "이미 사용 중인 빠른 로그인 번호입니다.");
  }

  const existing = await db.collection("users").where("quickKey", "==", quickKey).where("isActive", "==", true).get();
  const duplicate = existing.docs.find((document) => document.id !== exceptUid);

  if (duplicate) {
    throw new HttpsError("already-exists", "이미 사용 중인 빠른 로그인 번호입니다.");
  }
}

async function assertAdminWillRemain(targetUid: string, nextIsAdmin: boolean, nextIsActive: boolean) {
  if (nextIsAdmin && nextIsActive) {
    return;
  }

  const adminSnapshot = await db
    .collection("users")
    .where("isAdmin", "==", true)
    .where("isActive", "==", true)
    .get();
  const remainingAdmins = adminSnapshot.docs.filter((document) => document.id !== targetUid);

  if (remainingAdmins.length === 0) {
    throw new HttpsError("failed-precondition", "마지막 활성 관리자는 비활성화하거나 권한을 제거할 수 없습니다.");
  }
}

async function nextOrder() {
  const snapshot = await db.collection("users").orderBy("order", "desc").limit(1).get();
  return snapshot.empty ? 1 : Number(snapshot.docs[0].get("order") ?? 0) + 1;
}

function makeLoginEmail() {
  const alias = `qm_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return `${alias}@quickmemo.local`;
}

async function writeUserDocuments(uid: string, loginEmail: string, payload: NewUserPayload, order: number) {
  const now = FieldValue.serverTimestamp();
  const quickKeyReference = db.doc(`quickLoginKeys/${payload.quickKey}`);
  const profile = {
    uid,
    displayName: payload.displayName,
    avatarText: payload.avatarText,
    color: payload.color,
    order,
    quickKey: payload.quickKey,
    loginEmail,
    isActive: true,
    isAdmin: payload.isAdmin,
    role: payload.isAdmin ? "admin" : "user",
    publicKeyJwk: payload.keyBundle.publicKeyJwk,
    createdAt: now,
    updatedAt: now,
    needsKeyRecovery: false
  };

  await db.runTransaction(async (transaction) => {
    const quickKeySnapshot = await transaction.get(quickKeyReference);

    if (quickKeySnapshot.exists) {
      throw new HttpsError("already-exists", "이미 사용 중인 빠른 로그인 번호입니다.");
    }

    transaction.create(quickKeyReference, {
      uid,
      quickKey: payload.quickKey,
      createdAt: now
    });
    transaction.set(db.doc(`users/${uid}`), profile);
    transaction.set(db.doc(`publicLoginRoster/${uid}`), {
      uid,
      displayName: payload.displayName,
      avatarText: payload.avatarText,
      color: payload.color,
      order,
      quickKey: payload.quickKey,
      loginEmail,
      isActive: true,
      isAdmin: payload.isAdmin
    });
    transaction.set(db.doc(`userKeys/${uid}`), {
      uid,
      publicKeyJwk: payload.keyBundle.publicKeyJwk,
      encryptedPrivateKeyJwk: payload.keyBundle.encryptedPrivateKeyJwk,
      kdfSalt: payload.keyBundle.kdfSalt,
      kdfIterations: payload.keyBundle.kdfIterations,
      updatedAt: now
    });
  });
}

async function createManagedUser(payload: NewUserPayload, order: number) {
  await assertQuickKeyAvailable(payload.quickKey);
  const loginEmail = makeLoginEmail();
  const created = await auth.createUser({
    email: loginEmail,
    password: payload.password,
    displayName: payload.displayName,
    disabled: false
  });

  await auth.setCustomUserClaims(created.uid, { admin: payload.isAdmin });

  try {
    await writeUserDocuments(created.uid, loginEmail, payload, order);
  } catch (error) {
    await auth.deleteUser(created.uid);
    throw error;
  }

  return { uid: created.uid, loginEmail };
}

export const getBootstrapState = onCall(callableOptions, async () => {
  const [adminSnapshot, userSnapshot] = await Promise.all([
    db.collection("users").where("isAdmin", "==", true).limit(1).get(),
    db.collection("users").limit(1000).get()
  ]);

  return {
    adminExists: !adminSnapshot.empty,
    userCount: userSnapshot.size
  };
});

export const createFirstAdmin = onCall(callableOptions, async (request) => {
  const adminSnapshot = await db.collection("users").where("isAdmin", "==", true).limit(1).get();

  if (!adminSnapshot.empty) {
    throw new HttpsError("failed-precondition", "첫 관리자가 이미 설정되어 있습니다.");
  }

  const payload = normalizeNewUserPayload({ ...(request.data as object), isAdmin: true });
  const bootstrapReference = db.doc("system/bootstrap");

  try {
    await bootstrapReference.create({
      adminCreationStartedAt: FieldValue.serverTimestamp()
    });
  } catch {
    throw new HttpsError("failed-precondition", "첫 관리자 설정이 이미 진행되었거나 완료되었습니다.");
  }

  try {
    const created = await createManagedUser(payload, 1);
    await bootstrapReference.set(
      {
        adminUid: created.uid,
        adminCreatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    return created;
  } catch (error) {
    await bootstrapReference.delete().catch(() => undefined);
    throw error;
  }
});

export const createUser = onCall(callableOptions, async (request) => {
  await requireAdmin(request.auth?.uid);
  const payload = normalizeNewUserPayload(request.data);
  return createManagedUser(payload, await nextOrder());
});

export const updateUser = onCall(callableOptions, async (request) => {
  await requireAdmin(request.auth?.uid);
  const payload = normalizeUpdateUserPayload(request.data);
  await assertQuickKeyAvailable(payload.quickKey, payload.uid);
  await assertAdminWillRemain(payload.uid, payload.isAdmin, payload.isActive);

  const now = FieldValue.serverTimestamp();

  await db.runTransaction(async (transaction) => {
    const userReference = db.doc(`users/${payload.uid}`);
    const rosterReference = db.doc(`publicLoginRoster/${payload.uid}`);
    const currentUser = await transaction.get(userReference);

    if (!currentUser.exists) {
      throw new HttpsError("not-found", "사용자를 찾을 수 없습니다.");
    }

    const previousQuickKey = Number(currentUser.get("quickKey"));
    const nextQuickKeyReference = db.doc(`quickLoginKeys/${payload.quickKey}`);
    const nextQuickKeySnapshot = await transaction.get(nextQuickKeyReference);

    if (nextQuickKeySnapshot.exists && nextQuickKeySnapshot.get("uid") !== payload.uid) {
      throw new HttpsError("already-exists", "이미 사용 중인 빠른 로그인 번호입니다.");
    }

    transaction.update(db.doc(`users/${payload.uid}`), {
      displayName: payload.displayName,
      avatarText: payload.avatarText,
      color: payload.color,
      quickKey: payload.quickKey,
      order: payload.order,
      isActive: payload.isActive,
      isAdmin: payload.isAdmin,
      role: payload.isAdmin ? "admin" : "user",
      updatedAt: now
    });
    transaction.set(
      rosterReference,
      {
        uid: payload.uid,
        displayName: payload.displayName,
        avatarText: payload.avatarText,
        color: payload.color,
        quickKey: payload.quickKey,
        order: payload.order,
        loginEmail: currentUser.get("loginEmail"),
        isActive: payload.isActive,
        isAdmin: payload.isAdmin
      },
      { merge: true }
    );

    if (previousQuickKey !== payload.quickKey) {
      transaction.delete(db.doc(`quickLoginKeys/${previousQuickKey}`));
      transaction.set(nextQuickKeyReference, {
        uid: payload.uid,
        quickKey: payload.quickKey,
        updatedAt: now
      });
    }
  });

  await auth.updateUser(payload.uid, {
    displayName: payload.displayName,
    disabled: !payload.isActive
  });
  await auth.setCustomUserClaims(payload.uid, { admin: payload.isAdmin });

  return { ok: true };
});

export const reorderUsers = onCall(callableOptions, async (request) => {
  await requireAdmin(request.auth?.uid);
  const orderedUids = (request.data as { orderedUids?: unknown }).orderedUids;

  if (!Array.isArray(orderedUids) || orderedUids.some((uid) => typeof uid !== "string")) {
    throw new HttpsError("invalid-argument", "사용자 순서가 올바르지 않습니다.");
  }

  const batch = db.batch();
  orderedUids.forEach((uid, index) => {
    batch.update(db.doc(`users/${uid}`), { order: index + 1, updatedAt: FieldValue.serverTimestamp() });
    batch.update(db.doc(`publicLoginRoster/${uid}`), { order: index + 1 });
  });
  await batch.commit();

  return { ok: true };
});

export const resetUserPassword = onCall(callableOptions, async (request) => {
  await requireAdmin(request.auth?.uid);
  const payload = request.data as { uid?: unknown; password?: unknown; keyBundle?: unknown };
  const uid = assertString(payload.uid, "사용자 ID", 128);
  const password = assertPassword(payload.password);
  const keyBundle = assertKeyBundle(payload.keyBundle);

  await auth.updateUser(uid, { password });
  await db.runTransaction(async (transaction) => {
    transaction.update(db.doc(`users/${uid}`), {
      publicKeyJwk: keyBundle.publicKeyJwk,
      needsKeyRecovery: true,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.set(
      db.doc(`userKeys/${uid}`),
      {
        uid,
        publicKeyJwk: keyBundle.publicKeyJwk,
        encryptedPrivateKeyJwk: keyBundle.encryptedPrivateKeyJwk,
        kdfSalt: keyBundle.kdfSalt,
        kdfIterations: keyBundle.kdfIterations,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  return { ok: true };
});
