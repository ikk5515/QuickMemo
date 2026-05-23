import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { recurringCheckInId } from "../lib/recurringHabitHelpers";
import type {
  EncryptedPayload,
  RecurringHabitCheckInDocument,
  RecurringHabitDocument,
  RecurringHabitIcon,
  RecurringHabitSlot,
  RecurringHabitStatus,
  WrappedNoteKey
} from "../types";

export interface RecurringHabitSnapshot extends RecurringHabitDocument {
  id: string;
}

export interface RecurringHabitCheckInSnapshot extends RecurringHabitCheckInDocument {
  id: string;
}

export interface CreateRecurringHabitInput {
  ownerUid: string;
  title: EncryptedPayload;
  details: EncryptedPayload;
  wrappedKey: WrappedNoteKey;
  slot: RecurringHabitSlot;
  icon: RecurringHabitIcon;
  color: string;
}

export interface UpdateRecurringHabitInput {
  encryptedTitle?: EncryptedPayload;
  encryptedDetails?: EncryptedPayload;
  slot?: RecurringHabitSlot;
  icon?: RecurringHabitIcon;
  color?: string;
  status?: RecurringHabitStatus;
}

function timestampMillis(timestamp: RecurringHabitDocument["updatedAt"]) {
  return timestamp && typeof timestamp.toMillis === "function" ? timestamp.toMillis() : 0;
}

function habitSnapshotList(snapshot: { docs: Array<{ id: string; data: () => unknown }> }) {
  return snapshot.docs
    .map((document) => ({ id: document.id, ...(document.data() as RecurringHabitDocument) }))
    .sort((left, right) => timestampMillis(left.createdAt) - timestampMillis(right.createdAt));
}

function checkInSnapshotList(snapshot: { docs: Array<{ id: string; data: () => unknown }> }) {
  return snapshot.docs
    .map((document) => ({ id: document.id, ...(document.data() as RecurringHabitCheckInDocument) }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

export function subscribeRecurringHabits(
  uid: string,
  callback: (habits: RecurringHabitSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const habitsQuery = query(collection(db, "recurringHabits"), where("ownerUid", "==", uid));

  return onSnapshot(
    habitsQuery,
    (snapshot) => callback(habitSnapshotList(snapshot)),
    (error) => onError?.(error)
  );
}

export function subscribeRecurringHabitCheckIns(
  uid: string,
  callback: (checkIns: RecurringHabitCheckInSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const checkInsQuery = query(collection(db, "recurringHabitCheckIns"), where("ownerUid", "==", uid));

  return onSnapshot(
    checkInsQuery,
    (snapshot) => callback(checkInSnapshotList(snapshot)),
    (error) => onError?.(error)
  );
}

export async function createRecurringHabit(input: CreateRecurringHabitInput) {
  const habitRef = doc(collection(db, "recurringHabits"));

  await setDoc(habitRef, {
    ownerUid: input.ownerUid,
    status: "active",
    slot: input.slot,
    icon: input.icon,
    color: input.color,
    encryptedTitle: input.title,
    encryptedDetails: input.details,
    wrappedKeys: {
      [input.ownerUid]: input.wrappedKey
    },
    createdBy: input.ownerUid,
    updatedBy: input.ownerUid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return habitRef;
}

export async function updateRecurringHabit(habitId: string, uid: string, input: UpdateRecurringHabitInput) {
  await updateDoc(doc(db, "recurringHabits", habitId), {
    ...input,
    updatedBy: uid,
    updatedAt: serverTimestamp()
  });
}

export async function deleteRecurringHabit(habitId: string, uid: string) {
  const checkInsSnapshot = await getDocs(
    query(collection(db, "recurringHabitCheckIns"), where("ownerUid", "==", uid))
  );
  const documents = checkInsSnapshot.docs
    .filter((snapshot) => (snapshot.data() as RecurringHabitCheckInDocument).habitId === habitId)
    .map((snapshot) => snapshot.ref);

  for (let index = 0; index < documents.length; index += 450) {
    const batch = writeBatch(db);

    documents.slice(index, index + 450).forEach((documentRef) => batch.delete(documentRef));
    await batch.commit();
  }

  await deleteDoc(doc(db, "recurringHabits", habitId));
}

export async function setRecurringHabitCheckIn(uid: string, habitId: string, date: string, checked: boolean) {
  const checkInRef = doc(db, "recurringHabitCheckIns", recurringCheckInId(habitId, date));

  if (!checked) {
    await deleteDoc(checkInRef);
    return;
  }

  const snapshot = await getDoc(checkInRef);

  if (snapshot.exists()) {
    await updateDoc(checkInRef, {
      checkedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return;
  }

  await setDoc(checkInRef, {
    ownerUid: uid,
    habitId,
    date,
    checkedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}
