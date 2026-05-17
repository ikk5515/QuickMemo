import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import type { NewUserPayload, PublicRosterUser } from "../types";

export interface BootstrapState {
  adminExists: boolean;
  userCount: number;
}

export interface CreatedUserResult {
  uid: string;
  loginEmail: string;
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
}

export interface ResetPasswordPayload {
  uid: string;
  password: string;
  keyBundle: NewUserPayload["keyBundle"];
}

const getBootstrapStateCall = httpsCallable<void, BootstrapState>(functions, "getBootstrapState");
const createFirstAdminCall = httpsCallable<NewUserPayload, CreatedUserResult>(functions, "createFirstAdmin");
const createUserCall = httpsCallable<NewUserPayload, CreatedUserResult>(functions, "createUser");
const updateUserCall = httpsCallable<UpdateUserPayload, { ok: true }>(functions, "updateUser");
const reorderUsersCall = httpsCallable<{ orderedUids: string[] }, { ok: true }>(functions, "reorderUsers");
const resetUserPasswordCall = httpsCallable<ResetPasswordPayload, { ok: true }>(
  functions,
  "resetUserPassword"
);

export async function getBootstrapState() {
  const result = await getBootstrapStateCall();
  return result.data;
}

export async function createFirstAdmin(payload: NewUserPayload) {
  const result = await createFirstAdminCall(payload);
  return result.data;
}

export async function createUser(payload: NewUserPayload) {
  const result = await createUserCall(payload);
  return result.data;
}

export async function updateUser(payload: UpdateUserPayload) {
  await updateUserCall(payload);
}

export async function reorderUsers(users: PublicRosterUser[]) {
  await reorderUsersCall({ orderedUids: users.map((user) => user.uid) });
}

export async function resetUserPassword(payload: ResetPasswordPayload) {
  await resetUserPasswordCall(payload);
}
