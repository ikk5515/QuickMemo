import { deleteApp, initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
  signOut,
  updateProfile
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
  writeBatch
} from "firebase/firestore";
import { appCheckSiteKey, auth, db, firebaseConfig } from "../lib/firebase";
import type { NewUserPayload, PublicRosterUser, UserProfile } from "../types";

export interface BootstrapState {
  adminExists: boolean;
  userCount: number;
}

export interface CreatedUserResult {
  uid: string;
  loginEmail: string;
}

export interface FirstAdminPayload extends NewUserPayload {
  setupTokenHash: string;
}

export interface UpdateUserPayload {
  uid: string;
  displayName: string;
  avatarText: string;
  color: string;
  quickKey: number;
  order: number;
  isActive: boolean;
  isAdmin: boolean;
  allowedShareTargetUids: string[];
}

export interface ResetPasswordPayload {
  uid: string;
  password: string;
  keyBundle: NewUserPayload["keyBundle"];
}

function makeLoginEmail() {
  const alias = `qm_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return `${alias}@quickmemo.local`;
}

async function nextOrder() {
  const snapshot = await getDocs(query(collection(db, "users"), orderBy("order", "desc")));
  const [lastUser] = snapshot.docs;
  return lastUser ? Number(lastUser.get("order") ?? 0) + 1 : 1;
}

function profileDocument(uid: string, loginEmail: string, payload: NewUserPayload, order: number) {
  const now = serverTimestamp();

  return {
    uid,
    displayName: payload.displayName.trim(),
    avatarText: payload.avatarText.trim().toUpperCase(),
    color: payload.color,
    order,
    quickKey: payload.quickKey,
    loginEmail,
    isActive: true,
    isAdmin: payload.isAdmin,
    role: payload.isAdmin ? "admin" : "user",
    publicKeyJwk: payload.keyBundle.publicKeyJwk,
    allowedShareTargetUids: Array.from(new Set([uid, ...(payload.allowedShareTargetUids ?? [])])),
    createdAt: now,
    updatedAt: now,
    needsKeyRecovery: false
  };
}

function rosterDocument(uid: string, loginEmail: string, payload: NewUserPayload, order: number) {
  return {
    uid,
    displayName: payload.displayName.trim(),
    avatarText: payload.avatarText.trim().toUpperCase(),
    color: payload.color,
    order,
    quickKey: payload.quickKey,
    loginEmail,
    isActive: true,
    isAdmin: payload.isAdmin
  };
}

function userKeyDocument(uid: string, payload: NewUserPayload) {
  return {
    uid,
    publicKeyJwk: payload.keyBundle.publicKeyJwk,
    encryptedPrivateKeyJwk: payload.keyBundle.encryptedPrivateKeyJwk,
    kdfSalt: payload.keyBundle.kdfSalt,
    kdfIterations: payload.keyBundle.kdfIterations,
    updatedAt: serverTimestamp()
  };
}

function quickLoginKeyDocument(uid: string, quickKey: number) {
  return {
    uid,
    quickKey,
    updatedAt: serverTimestamp()
  };
}

async function writeNewUserDocuments(
  uid: string,
  loginEmail: string,
  payload: NewUserPayload,
  order: number,
  targetDb: Firestore = db
) {
  const batch = writeBatch(targetDb);

  batch.set(doc(targetDb, "quickLoginKeys", String(payload.quickKey)), {
    ...quickLoginKeyDocument(uid, payload.quickKey),
    createdAt: serverTimestamp()
  });
  batch.set(doc(targetDb, "users", uid), profileDocument(uid, loginEmail, payload, order));
  batch.set(doc(targetDb, "publicLoginRoster", uid), rosterDocument(uid, loginEmail, payload, order));
  batch.set(doc(targetDb, "userKeys", uid), userKeyDocument(uid, payload));

  await batch.commit();
}

async function createSecondaryAuthUser(displayName: string, loginEmail: string, password: string) {
  const secondaryApp = initializeApp(firebaseConfig, `quickmemo-user-create-${crypto.randomUUID()}`);
  const secondaryAuth = getAuth(secondaryApp);
  const secondaryDb = getFirestore(secondaryApp);

  if (import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true") {
    connectAuthEmulator(secondaryAuth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(secondaryDb, "127.0.0.1", 8080);
  } else if (appCheckSiteKey) {
    initializeAppCheck(secondaryApp, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true
    });
  }

  const credential = await createUserWithEmailAndPassword(secondaryAuth, loginEmail, password);
  await updateProfile(credential.user, { displayName });

  return {
    db: secondaryDb,
    user: credential.user,
    cleanup: async () => {
      await signOut(secondaryAuth).catch(() => undefined);
      await deleteApp(secondaryApp);
    }
  };
}

export async function getBootstrapState(): Promise<BootstrapState> {
  const bootstrap = await getDoc(doc(db, "system", "bootstrap"));

  return {
    adminExists: bootstrap.exists(),
    userCount: bootstrap.exists() ? 1 : 0
  };
}

export async function createFirstAdmin(payload: FirstAdminPayload): Promise<CreatedUserResult> {
  const loginEmail = makeLoginEmail();
  const created = await createSecondaryAuthUser(payload.displayName, loginEmail, payload.password);

  try {
    const batch = writeBatch(created.db);
    const uid = created.user.uid;
    const adminPayload = { ...payload, isAdmin: true };

    batch.set(doc(created.db, "system", "bootstrap"), {
      adminUid: uid,
      createdAt: serverTimestamp()
    });
    batch.set(doc(created.db, "system", "bootstrapAttempts", "attempts", uid), {
      uid,
      setupTokenHash: payload.setupTokenHash,
      createdAt: serverTimestamp()
    });
    batch.set(doc(created.db, "quickLoginKeys", String(adminPayload.quickKey)), {
      ...quickLoginKeyDocument(uid, adminPayload.quickKey),
      createdAt: serverTimestamp()
    });
    batch.set(doc(created.db, "users", uid), profileDocument(uid, loginEmail, adminPayload, 1));
    batch.set(doc(created.db, "publicLoginRoster", uid), rosterDocument(uid, loginEmail, adminPayload, 1));
    batch.set(doc(created.db, "userKeys", uid), userKeyDocument(uid, adminPayload));
    await batch.commit();

    return { uid, loginEmail };
  } catch (error) {
    await deleteUser(created.user).catch(() => undefined);
    throw error;
  } finally {
    await created.cleanup();
  }
}

export async function createUser(payload: NewUserPayload): Promise<CreatedUserResult> {
  const loginEmail = makeLoginEmail();
  const created = await createSecondaryAuthUser(payload.displayName, loginEmail, payload.password);

  try {
    await writeNewUserDocuments(created.user.uid, loginEmail, payload, await nextOrder());
    return { uid: created.user.uid, loginEmail };
  } catch (error) {
    await deleteUser(created.user).catch(() => undefined);
    throw error;
  } finally {
    await created.cleanup();
  }
}

export async function updateUser(payload: UpdateUserPayload) {
  await runTransaction(db, async (transaction) => {
    const userReference = doc(db, "users", payload.uid);
    const rosterReference = doc(db, "publicLoginRoster", payload.uid);
    const currentUser = await transaction.get(userReference);

    if (!currentUser.exists()) {
      throw new Error("사용자를 찾을 수 없습니다.");
    }

    const previousQuickKey = Number(currentUser.get("quickKey"));
    const nextData = {
      displayName: payload.displayName.trim(),
      avatarText: payload.avatarText.trim().toUpperCase(),
      color: payload.color,
      quickKey: payload.quickKey,
      order: payload.order,
      isActive: payload.isActive,
      isAdmin: payload.isAdmin,
      role: payload.isAdmin ? "admin" : "user",
      allowedShareTargetUids: Array.from(new Set([payload.uid, ...payload.allowedShareTargetUids])),
      updatedAt: serverTimestamp()
    };

    if (previousQuickKey !== payload.quickKey) {
      transaction.delete(doc(db, "quickLoginKeys", String(previousQuickKey)));
      transaction.set(
        doc(db, "quickLoginKeys", String(payload.quickKey)),
        quickLoginKeyDocument(payload.uid, payload.quickKey)
      );
    }

    transaction.update(userReference, nextData);
    transaction.set(
      rosterReference,
      {
        uid: payload.uid,
        displayName: nextData.displayName,
        avatarText: nextData.avatarText,
        color: nextData.color,
        quickKey: nextData.quickKey,
        order: nextData.order,
        loginEmail: currentUser.get("loginEmail"),
        isActive: nextData.isActive,
        isAdmin: nextData.isAdmin
      },
      { merge: true }
    );
  });
}

export async function reorderUsers(users: PublicRosterUser[]) {
  const batch = writeBatch(db);

  users.forEach((user, index) => {
    batch.update(doc(db, "users", user.uid), {
      order: index + 1,
      updatedAt: serverTimestamp()
    });
    batch.update(doc(db, "publicLoginRoster", user.uid), {
      order: index + 1
    });
  });

  await batch.commit();
}

export async function deleteManagedUserDocuments(user: Pick<UserProfile, "uid" | "quickKey">) {
  const idToken = await auth.currentUser?.getIdToken();

  if (!idToken) {
    throw new Error("관리자 인증을 확인할 수 없습니다.");
  }

  const response = await fetch("/api/delete-managed-user", {
    method: "POST",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ targetUid: user.uid })
  });

  if (!response.ok) {
    const result = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(result?.error ?? "사용자를 삭제하지 못했습니다.");
  }
}

export async function resetUserPassword() {
  throw new Error("Functions 없는 구성에서는 관리자가 다른 사용자의 Firebase Auth 비밀번호를 직접 변경할 수 없습니다.");
}
