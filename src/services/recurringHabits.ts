import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
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
  sortOrder?: number | null;
}

export interface UpdateRecurringHabitInput {
  encryptedTitle?: EncryptedPayload;
  encryptedDetails?: EncryptedPayload;
  slot?: RecurringHabitSlot;
  icon?: RecurringHabitIcon;
  color?: string;
  sortOrder?: number | null;
  status?: RecurringHabitStatus;
}

export interface UpdateRecurringHabitDayStateInput {
  checkedItemIds?: string[];
  completed?: boolean;
  progressPercent?: number | null;
  toggleCheckedItem?: {
    allowedItemIds: string[];
    itemId: string;
  };
}

export interface RecurringHabitDayStateResult {
  checkedItemIds: string[];
  completed: boolean;
  progressPercent: number;
}

export interface RecurringHabitCheckInSubscriptionOptions {
  date?: string;
}

export interface RecurringHabitLatestUpdate<TResult> {
  input: UpdateRecurringHabitInput;
  result: TResult;
}

function timestampMillis(timestamp: RecurringHabitDocument["updatedAt"]) {
  return timestamp && typeof timestamp.toMillis === "function" ? timestamp.toMillis() : 0;
}

function habitSnapshotList(snapshot: { docs: Array<{ id: string; data: () => unknown }> }) {
  return snapshot.docs
    .map((document) => ({ id: document.id, ...(document.data() as RecurringHabitDocument) }))
    .sort((left, right) => timestampMillis(left.createdAt) - timestampMillis(right.createdAt));
}

function normalizedCheckedItemIds(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((itemId): itemId is string => typeof itemId === "string" && itemId.length > 0))].slice(0, 100)
    : [];
}

function normalizedProgressPercent(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : fallback;
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
  onError?: (error: Error) => void,
  options?: RecurringHabitCheckInSubscriptionOptions
) {
  const checkInsQuery = options?.date
    ? query(
      collection(db, "recurringHabitCheckIns"),
      where("ownerUid", "==", uid),
      where("date", "==", options.date)
    )
    : query(collection(db, "recurringHabitCheckIns"), where("ownerUid", "==", uid));
  const checkInsById = new Map<string, RecurringHabitCheckInSnapshot>();

  return onSnapshot(
    checkInsQuery,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") {
          checkInsById.delete(change.doc.id);
          return;
        }

        checkInsById.set(change.doc.id, {
          id: change.doc.id,
          ...(change.doc.data() as RecurringHabitCheckInDocument)
        });
      });
      callback([...checkInsById.values()]);
    },
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
    sortOrder: input.sortOrder ?? null,
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

export async function updateRecurringHabitFromLatest<TResult>(
  habitId: string,
  uid: string,
  buildUpdate: (habit: RecurringHabitSnapshot) => Promise<RecurringHabitLatestUpdate<TResult>>
) {
  const habitRef = doc(db, "recurringHabits", habitId);

  return runTransaction(db, async (transaction): Promise<TResult> => {
    const snapshot = await transaction.get(habitRef);

    if (!snapshot.exists()) {
      throw new Error("반복 업무를 찾을 수 없습니다.");
    }

    const habit = {
      id: snapshot.id,
      ...(snapshot.data() as RecurringHabitDocument)
    } satisfies RecurringHabitSnapshot;

    if (habit.ownerUid !== uid) {
      throw new Error("반복 업무 소유자를 확인할 수 없습니다.");
    }

    const update = await buildUpdate(habit);

    transaction.update(habitRef, {
      ...update.input,
      updatedBy: uid,
      updatedAt: serverTimestamp()
    });

    return update.result;
  });
}

export async function updateRecurringHabitOrderBatch(
  uid: string,
  updates: Array<{ habitId: string; slot: RecurringHabitSlot; sortOrder: number | null }>
) {
  const batch = writeBatch(db);

  updates.forEach((update) => {
    batch.update(doc(db, "recurringHabits", update.habitId), {
      slot: update.slot,
      sortOrder: update.sortOrder,
      updatedBy: uid,
      updatedAt: serverTimestamp()
    });
  });

  await batch.commit();
}

export async function deleteRecurringHabit(habitId: string, uid: string) {
  const habitRef = doc(db, "recurringHabits", habitId);
  const habitExists = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(habitRef);

    if (!snapshot.exists()) {
      return false;
    }

    const habit = snapshot.data() as RecurringHabitDocument;

    if (habit.ownerUid !== uid) {
      throw new Error("반복 업무 소유자를 확인할 수 없습니다.");
    }

    if (habit.status === "active") {
      transaction.update(habitRef, {
        status: "archived",
        updatedBy: uid,
        updatedAt: serverTimestamp()
      });
    }

    return true;
  });

  if (!habitExists) {
    return;
  }

  try {
    while (true) {
      const checkInsQuery = query(
        collection(db, "recurringHabitCheckIns"),
        where("ownerUid", "==", uid),
        where("habitId", "==", habitId),
        limit(450)
      );
      const checkInsSnapshot = await getDocs(checkInsQuery);

      if (checkInsSnapshot.empty) {
        break;
      }

      const batch = writeBatch(db);

      checkInsSnapshot.docs.forEach((snapshot) => batch.delete(snapshot.ref));

      try {
        await batch.commit();
      } catch (caught) {
        const remainingCheckIns = await getDocs(
          query(
            collection(db, "recurringHabitCheckIns"),
            where("ownerUid", "==", uid),
            where("habitId", "==", habitId),
            limit(1)
          )
        );

        if (!remainingCheckIns.empty) {
          throw caught;
        }
        break;
      }
    }

    try {
      await deleteDoc(habitRef);
    } catch (caught) {
      const remainingHabit = await getDocs(
        query(
          collection(db, "recurringHabits"),
          where("ownerUid", "==", uid)
        )
      );

      if (remainingHabit.docs.some((snapshot) => snapshot.id === habitId)) {
        throw caught;
      }
    }
  } catch (caught) {
    throw new Error("반복 업무 삭제 정리가 중단됐습니다. 반복 업무 페이지에서 삭제를 다시 시도해주세요.", {
      cause: caught
    });
  }
}

export async function setRecurringHabitCheckIn(uid: string, habitId: string, date: string, checked: boolean) {
  const checkInRef = doc(db, "recurringHabitCheckIns", recurringCheckInId(habitId, date));

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(checkInRef);

    if (!checked) {
      if (snapshot.exists()) {
        transaction.delete(checkInRef);
      }
      return;
    }

    const timestamp = serverTimestamp();

    if (snapshot.exists()) {
      const current = snapshot.data() as RecurringHabitCheckInDocument;

      transaction.update(checkInRef, {
        checkedItemIds: normalizedCheckedItemIds(current.checkedItemIds),
        completed: true,
        progressPercent: 100,
        checkedAt: timestamp,
        updatedAt: timestamp
      });
      return;
    }

    transaction.set(checkInRef, {
      ownerUid: uid,
      habitId,
      date,
      completed: true,
      progressPercent: 100,
      checkedItemIds: [],
      checkedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  });
}

export async function updateRecurringHabitDayState(
  uid: string,
  habitId: string,
  date: string,
  input: UpdateRecurringHabitDayStateInput
) {
  const checkInRef = doc(db, "recurringHabitCheckIns", recurringCheckInId(habitId, date));
  return runTransaction(db, async (transaction): Promise<RecurringHabitDayStateResult> => {
    const snapshot = await transaction.get(checkInRef);
    const current = snapshot.exists() ? snapshot.data() as RecurringHabitCheckInDocument : null;
    let checkedItemIds = input.checkedItemIds !== undefined
      ? normalizedCheckedItemIds(input.checkedItemIds)
      : normalizedCheckedItemIds(current?.checkedItemIds);
    let progressPercent = normalizedProgressPercent(
      input.progressPercent,
      normalizedProgressPercent(current?.progressPercent, current && current.completed !== false ? 100 : 0)
    );
    let completed = input.completed ?? (current ? current.completed !== false : false);

    if (input.progressPercent !== undefined) {
      completed = progressPercent >= 100;
    } else if (input.completed !== undefined) {
      progressPercent = completed ? 100 : Math.min(progressPercent, 99);
    }

    if (input.toggleCheckedItem) {
      checkedItemIds = normalizedCheckedItemIds(current?.checkedItemIds);
      const allowedItemIds = normalizedCheckedItemIds(input.toggleCheckedItem.allowedItemIds);

      if (!allowedItemIds.includes(input.toggleCheckedItem.itemId)) {
        throw new Error("Invalid recurring checklist item.");
      }

      const allowedItems = new Set(allowedItemIds);
      const nextCheckedItems = new Set(checkedItemIds.filter((itemId) => allowedItems.has(itemId)));

      if (nextCheckedItems.has(input.toggleCheckedItem.itemId)) {
        nextCheckedItems.delete(input.toggleCheckedItem.itemId);
      } else {
        nextCheckedItems.add(input.toggleCheckedItem.itemId);
      }

      checkedItemIds = allowedItemIds.filter((itemId) => nextCheckedItems.has(itemId));
      progressPercent = allowedItemIds.length
        ? Math.round((checkedItemIds.length / allowedItemIds.length) * 100)
        : 0;
      completed = allowedItemIds.length > 0 && progressPercent >= 100;
    }

    const timestamp = serverTimestamp();
    const nextState = {
      checkedItemIds,
      completed,
      progressPercent,
      checkedAt: completed ? timestamp : null,
      updatedAt: timestamp
    };

    if (snapshot.exists()) {
      transaction.update(checkInRef, nextState);
    } else {
      transaction.set(checkInRef, {
        ownerUid: uid,
        habitId,
        date,
        ...nextState,
        createdAt: timestamp
      });
    }

    return { checkedItemIds, completed, progressPercent };
  });
}
