import {
  EmailAuthProvider,
  type User,
  type UserCredential,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updatePassword
} from "firebase/auth";
import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { auth, authPersistenceReady } from "../lib/firebase";
import { relockUserPrivateKey, unlockPrivateKeyWithFallback } from "../lib/crypto";
import { clearAuthSession, readAuthSession, startAuthSession } from "../lib/authSession";
import {
  deleteSessionPrivateKey,
  privateKeySessionDurationMs,
  readSessionPrivateKey,
  writeSessionPrivateKey
} from "../lib/sessionPrivateKey";
import {
  clearPendingUserKey,
  getUserKeyDocument,
  getUserProfile,
  promotePendingUserKey,
  stagePendingUserKey,
  subscribeUserProfile
} from "../services/users";
import type { PublicRosterUser, UserProfile } from "../types";

interface AuthContextValue {
  firebaseUser: User | null;
  profile: UserProfile | null;
  privateKey: CryptoKey | null;
  loading: boolean;
  keyError: string | null;
  changePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  loginRosterUser: (user: PublicRosterUser, password: string) => Promise<UserProfile>;
  unlockPrivateKey: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface ProfileLoadInFlight {
  generation: number;
  promise: Promise<UserProfile | null>;
}

interface SignInAttempt {
  attemptId: number;
  expectedUid: string;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [privateKeyUid, setPrivateKeyUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyError, setKeyError] = useState<string | null>(null);
  const privateKeyUidRef = useRef<string | null>(null);
  const signInAttemptRef = useRef<SignInAttempt | null>(null);
  const signInAttemptSequenceRef = useRef(0);
  const passwordChangeInFlightRef = useRef<Promise<void> | null>(null);
  const observedFirebaseUidRef = useRef<string | null>(null);
  const activeProfileUidRef = useRef<string | null>(null);
  const authGenerationRef = useRef(0);
  const profileLoadInFlightRef = useRef(new Map<string, ProfileLoadInFlight>());
  const firebaseUserUid = firebaseUser?.uid ?? null;

  const observeFirebaseUid = useCallback((uid: string | null) => {
    if (observedFirebaseUidRef.current !== uid) {
      observedFirebaseUidRef.current = uid;
      activeProfileUidRef.current = null;
      authGenerationRef.current += 1;
      profileLoadInFlightRef.current.clear();
    }

    return authGenerationRef.current;
  }, []);

  const clearPrivateKey = useCallback(() => {
    privateKeyUidRef.current = null;
    setPrivateKeyUid(null);
    setPrivateKey(null);
  }, []);

  const rememberPrivateKey = useCallback((uid: string, key: CryptoKey, generation = authGenerationRef.current) => {
    if (
      auth.currentUser?.uid !== uid ||
      observedFirebaseUidRef.current !== uid ||
      activeProfileUidRef.current !== uid ||
      authGenerationRef.current !== generation ||
      !readAuthSession(uid)
    ) {
      return false;
    }

    privateKeyUidRef.current = uid;
    setPrivateKeyUid(uid);
    setPrivateKey(key);
    void writeSessionPrivateKey(uid, key)
      .then((mutationVersion) => {
        if (mutationVersion === null) {
          return undefined;
        }
        if (
          auth.currentUser?.uid !== uid ||
          observedFirebaseUidRef.current !== uid ||
          activeProfileUidRef.current !== uid ||
          authGenerationRef.current !== generation ||
          !readAuthSession(uid)
        ) {
          return deleteSessionPrivateKey(uid, mutationVersion);
        }

        return undefined;
      })
      .catch(() => undefined);
    return true;
  }, []);

  const expireFirebaseSession = useCallback(
    async (uid?: string | null) => {
      const targetUid = uid ?? observedFirebaseUidRef.current ?? privateKeyUidRef.current;
      const currentAuthUid = auth.currentUser?.uid ?? null;

      if (!targetUid || signInAttemptRef.current?.expectedUid === targetUid) {
        signInAttemptRef.current = null;
      }

      if (
        targetUid &&
        ((currentAuthUid && currentAuthUid !== targetUid) ||
          (observedFirebaseUidRef.current &&
            observedFirebaseUidRef.current !== targetUid &&
            currentAuthUid !== targetUid))
      ) {
        await deleteSessionPrivateKey(targetUid).catch(() => undefined);
        return;
      }

      const unlockedUid = privateKeyUidRef.current;

      observeFirebaseUid(null);
      clearAuthSession();
      setFirebaseUser(null);
      setProfile(null);
      clearPrivateKey();
      setLoading(false);

      // Start Firebase sign-out before awaiting legacy key-store cleanup. A
      // delayed IndexedDB delete must not sign out a newer same-UID session.
      const firebaseSignOutPromise = !targetUid || auth.currentUser?.uid === targetUid
        ? firebaseSignOut(auth).catch(() => undefined)
        : Promise.resolve();
      const keyDeletePromise = unlockedUid
        ? deleteSessionPrivateKey(unlockedUid).catch(() => undefined)
        : Promise.resolve();

      await Promise.all([firebaseSignOutPromise, keyDeletePromise]);
    },
    [clearPrivateKey, observeFirebaseUid]
  );

  const loadProfile = useCallback(async (user: User | null) => {
    if (!user) {
      const unlockedUid = privateKeyUidRef.current;

      observeFirebaseUid(null);
      clearAuthSession();
      setFirebaseUser(null);
      setProfile(null);
      clearPrivateKey();
      setLoading(false);
      if (unlockedUid) {
        await deleteSessionPrivateKey(unlockedUid).catch(() => undefined);
      }
      return null;
    }

    const previousUid = observedFirebaseUidRef.current;
    const generation = observeFirebaseUid(user.uid);

    if (previousUid !== user.uid) {
      setFirebaseUser(null);
      setProfile(null);
      clearPrivateKey();
    }

    if (!readAuthSession(user.uid)) {
      if (signInAttemptRef.current?.expectedUid === user.uid) {
        // Firebase can emit a persisted same-UID user before the password
        // credential request finishes. Only the credential-success path may
        // create the per-tab QuickMemo session; the observer waits here.
        setLoading(false);
        return null;
      } else {
        await expireFirebaseSession(user.uid);
        return null;
      }
    }

    const existingLoad = profileLoadInFlightRef.current.get(user.uid);

    if (existingLoad?.generation === generation) {
      return existingLoad.promise;
    }

    const profileLoad = (async () => {
      const nextProfile = await getUserProfile(user.uid);

      if (
        auth.currentUser?.uid !== user.uid ||
        observedFirebaseUidRef.current !== user.uid ||
        authGenerationRef.current !== generation
      ) {
        return null;
      }

      if (!nextProfile?.isActive || nextProfile.uid !== user.uid) {
        await expireFirebaseSession(user.uid);
        return null;
      }

      activeProfileUidRef.current = user.uid;
      const cachedPrivateKey = await readSessionPrivateKey(user.uid).catch(() => null);

      if (
        auth.currentUser?.uid !== user.uid ||
        observedFirebaseUidRef.current !== user.uid ||
        activeProfileUidRef.current !== user.uid ||
        authGenerationRef.current !== generation ||
        !readAuthSession(user.uid)
      ) {
        return null;
      }

      setFirebaseUser(user);
      setProfile(nextProfile);
      if (cachedPrivateKey) {
        rememberPrivateKey(user.uid, cachedPrivateKey, generation);
      } else if (privateKeyUidRef.current !== user.uid) {
        clearPrivateKey();
      }
      setLoading(false);
      return nextProfile;
    })().finally(() => {
      const currentLoad = profileLoadInFlightRef.current.get(user.uid);

      if (currentLoad?.promise === profileLoad) {
        profileLoadInFlightRef.current.delete(user.uid);
      }
    });

    profileLoadInFlightRef.current.set(user.uid, { generation, promise: profileLoad });
    return profileLoad;
  }, [clearPrivateKey, expireFirebaseSession, observeFirebaseUid, rememberPrivateKey]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    void authPersistenceReady.then(() => {
      if (!active) {
        return;
      }

      unsubscribe = onAuthStateChanged(auth, (user) => {
        setLoading(true);
        void loadProfile(user).catch(() => {
          if (observedFirebaseUidRef.current !== (user?.uid ?? null)) {
            return;
          }

          activeProfileUidRef.current = null;
          setFirebaseUser(user);
          setProfile(null);
          clearPrivateKey();
          setLoading(false);
        });
      });
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [clearPrivateKey, loadProfile]);

  useEffect(() => {
    if (!firebaseUserUid) {
      return undefined;
    }

    const uid = firebaseUserUid;
    const authSession = readAuthSession(uid);

    if (!authSession) {
      void expireFirebaseSession(uid);
      return undefined;
    }

    const timeoutMs = Math.max(0, authSession.expiresAt - Date.now());
    const timeoutId = window.setTimeout(() => {
      void expireFirebaseSession(uid);
    }, timeoutMs);

    function checkAuthSession() {
      if (!readAuthSession(uid)) {
        void expireFirebaseSession(uid);
      }
    }

    window.addEventListener("focus", checkAuthSession);
    document.addEventListener("visibilitychange", checkAuthSession);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("focus", checkAuthSession);
      document.removeEventListener("visibilitychange", checkAuthSession);
    };
  }, [expireFirebaseSession, firebaseUserUid]);

  useEffect(() => {
    if (!firebaseUserUid) {
      return undefined;
    }

    let active = true;

    const unsubscribe = subscribeUserProfile(
      firebaseUserUid,
      (nextProfile) => {
        if (!active) {
          return;
        }

        if (!nextProfile?.isActive || nextProfile.uid !== firebaseUserUid) {
          activeProfileUidRef.current = null;
          void expireFirebaseSession(firebaseUserUid);
          return;
        }

        if (
          auth.currentUser?.uid !== firebaseUserUid ||
          observedFirebaseUidRef.current !== firebaseUserUid
        ) {
          return;
        }

        activeProfileUidRef.current = firebaseUserUid;
        setProfile(nextProfile);
      },
      () => {
        if (active) {
          activeProfileUidRef.current = null;
          setProfile(null);
          clearPrivateKey();
        }
      }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [clearPrivateKey, expireFirebaseSession, firebaseUserUid]);

  useEffect(() => {
    if (!firebaseUserUid || !privateKey || privateKeyUid !== firebaseUserUid) {
      return undefined;
    }

    const uid = firebaseUserUid;
    const sessionPrivateKey = privateKey;
    const generation = authGenerationRef.current;
    let timeoutId: number | undefined;
    let active = true;
    let lastRefreshAt = 0;

    function clearUnlockAfterIdle() {
      if (!active) {
        return;
      }

      clearPrivateKey();
      void deleteSessionPrivateKey(uid).catch(() => undefined);
    }

    function refreshSession() {
      if (!active) {
        return;
      }

      lastRefreshAt = Date.now();
      window.clearTimeout(timeoutId);
      void writeSessionPrivateKey(uid, sessionPrivateKey, lastRefreshAt + privateKeySessionDurationMs)
        .then((mutationVersion) => {
          if (mutationVersion === null) {
            return undefined;
          }
          if (
            !active ||
            auth.currentUser?.uid !== uid ||
            observedFirebaseUidRef.current !== uid ||
            activeProfileUidRef.current !== uid ||
            privateKeyUidRef.current !== uid ||
            authGenerationRef.current !== generation ||
            !readAuthSession(uid)
          ) {
            return deleteSessionPrivateKey(uid, mutationVersion);
          }

          return undefined;
        })
        .catch(() => undefined);
      timeoutId = window.setTimeout(clearUnlockAfterIdle, privateKeySessionDurationMs);
    }

    function refreshSessionFromActivity() {
      if (Date.now() - lastRefreshAt < 60_000) {
        return;
      }

      refreshSession();
    }

    refreshSession();
    window.addEventListener("keydown", refreshSessionFromActivity, true);
    window.addEventListener("pointerdown", refreshSessionFromActivity, true);
    window.addEventListener("focus", refreshSessionFromActivity);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      window.removeEventListener("keydown", refreshSessionFromActivity, true);
      window.removeEventListener("pointerdown", refreshSessionFromActivity, true);
      window.removeEventListener("focus", refreshSessionFromActivity);
    };
  }, [clearPrivateKey, firebaseUserUid, privateKey, privateKeyUid]);

  const unlockPrivateKey = useCallback(
    async (password: string) => {
      if (!firebaseUser || !profile) {
        throw new Error("로그인된 사용자가 없습니다.");
      }

      const expectedUid = firebaseUser.uid;
      const generation = authGenerationRef.current;
      const attempt = {
        attemptId: signInAttemptSequenceRef.current + 1,
        expectedUid
      };

      signInAttemptSequenceRef.current = attempt.attemptId;
      signInAttemptRef.current = attempt;
      setKeyError(null);

      try {
        await authPersistenceReady;
        const credential: UserCredential = await signInWithEmailAndPassword(
          auth,
          profile.loginEmail,
          password
        );

        if (signInAttemptRef.current?.attemptId !== attempt.attemptId) {
          throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
        }
        if (credential.user.uid !== expectedUid) {
          await expireFirebaseSession(credential.user.uid);
          throw new Error("로그인 계정이 현재 사용자와 일치하지 않습니다.");
        }

        startAuthSession(expectedUid);
        const keyDocument = await getUserKeyDocument(expectedUid);

        if (!keyDocument) {
          throw new Error("사용자 암호화 키를 찾을 수 없습니다.");
        }
        if (
          signInAttemptRef.current?.attemptId !== attempt.attemptId ||
          auth.currentUser?.uid !== expectedUid ||
          observedFirebaseUidRef.current !== expectedUid ||
          activeProfileUidRef.current !== expectedUid ||
          authGenerationRef.current !== generation ||
          !readAuthSession(expectedUid)
        ) {
          throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
        }

        let unlockedPrivateKey: CryptoKey;

        try {
          unlockedPrivateKey = await unlockPrivateKeyWithFallback(keyDocument, password);
        } catch (error) {
          setKeyError("노트 암호화 키를 열 수 없습니다. 비밀번호를 확인해주세요.");
          throw error;
        }

        if (
          signInAttemptRef.current?.attemptId !== attempt.attemptId ||
          !rememberPrivateKey(expectedUid, unlockedPrivateKey, generation)
        ) {
          throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
        }
      } finally {
        if (signInAttemptRef.current?.attemptId === attempt.attemptId) {
          signInAttemptRef.current = null;
        }
      }
    },
    [expireFirebaseSession, firebaseUser, profile, rememberPrivateKey]
  );

  const loginRosterUser = useCallback(
    async (rosterUser: PublicRosterUser, password: string) => {
      const attempt = {
        attemptId: signInAttemptSequenceRef.current + 1,
        expectedUid: rosterUser.uid
      };

      signInAttemptSequenceRef.current = attempt.attemptId;
      signInAttemptRef.current = attempt;
      setKeyError(null);

      try {
        await authPersistenceReady;
        const credential: UserCredential = await signInWithEmailAndPassword(
          auth,
          rosterUser.loginEmail,
          password
        );

        if (signInAttemptRef.current?.attemptId !== attempt.attemptId) {
          throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
        }
        if (credential.user.uid !== rosterUser.uid) {
          await expireFirebaseSession(credential.user.uid);
          throw new Error("선택한 사용자와 로그인 계정이 일치하지 않습니다.");
        }

        startAuthSession(credential.user.uid);
        const generation = observeFirebaseUid(credential.user.uid);
        const [nextProfile, keyDocument] = await Promise.all([
          loadProfile(credential.user),
          getUserKeyDocument(credential.user.uid)
        ]);

        if (!nextProfile?.isActive || nextProfile.uid !== credential.user.uid || !keyDocument) {
          throw new Error("사용자 프로필 또는 암호화 키를 불러오지 못했습니다.");
        }
        if (
          signInAttemptRef.current?.attemptId !== attempt.attemptId ||
          auth.currentUser?.uid !== credential.user.uid ||
          observedFirebaseUidRef.current !== credential.user.uid ||
          activeProfileUidRef.current !== credential.user.uid ||
          authGenerationRef.current !== generation ||
          !readAuthSession(credential.user.uid)
        ) {
          throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
        }

        const unlockedPrivateKey = await unlockPrivateKeyWithFallback(keyDocument, password);

        if (
          signInAttemptRef.current?.attemptId !== attempt.attemptId ||
          !rememberPrivateKey(credential.user.uid, unlockedPrivateKey, generation)
        ) {
          throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
        }
        return nextProfile;
      } catch (error) {
        if (auth.currentUser?.uid === rosterUser.uid && !readAuthSession(rosterUser.uid)) {
          await expireFirebaseSession(rosterUser.uid);
        }
        throw error;
      } finally {
        if (signInAttemptRef.current?.attemptId === attempt.attemptId) {
          signInAttemptRef.current = null;
        }
      }
    },
    [expireFirebaseSession, loadProfile, observeFirebaseUid, rememberPrivateKey]
  );

  const changePassword = useCallback(
    async (currentPassword: string, nextPassword: string) => {
      if (!firebaseUser || !profile) {
        throw new Error("로그인된 사용자가 없습니다.");
      }
      if (passwordChangeInFlightRef.current) {
        throw new Error("비밀번호를 변경하고 있습니다. 잠시 후 다시 시도해주세요.");
      }

      const uid = firebaseUser.uid;
      const generation = authGenerationRef.current;
      const assertPasswordChangeSession = () => {
        if (
          auth.currentUser !== firebaseUser ||
          observedFirebaseUidRef.current !== uid ||
          activeProfileUidRef.current !== uid ||
          authGenerationRef.current !== generation ||
          !readAuthSession(uid)
        ) {
          throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
        }
      };
      const operation = (async () => {
        const credential = EmailAuthProvider.credential(profile.loginEmail, currentPassword);
        await reauthenticateWithCredential(firebaseUser, credential);
        assertPasswordChangeSession();

        const keyDocument = await getUserKeyDocument(uid);

        if (!keyDocument) {
          throw new Error("사용자 암호화 키를 찾을 수 없습니다.");
        }
        assertPasswordChangeSession();

        const nextKeyBundle = await relockUserPrivateKey(keyDocument, currentPassword, nextPassword);
        assertPasswordChangeSession();
        await stagePendingUserKey(uid, nextKeyBundle);
        assertPasswordChangeSession();

        let authPasswordChanged = false;

        try {
          await updatePassword(firebaseUser, nextPassword);
          authPasswordChanged = true;
          assertPasswordChangeSession();
          await promotePendingUserKey(uid, nextKeyBundle);
          assertPasswordChangeSession();
          const unlockedPrivateKey = await unlockPrivateKeyWithFallback(
            { ...keyDocument, ...nextKeyBundle },
            nextPassword
          );

          assertPasswordChangeSession();
          if (!rememberPrivateKey(uid, unlockedPrivateKey, generation)) {
            throw new Error("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
          }
          setKeyError(null);
        } catch (error) {
          if (!authPasswordChanged) {
            await clearPendingUserKey(uid).catch(() => undefined);
          }

          throw error;
        }
      })();

      passwordChangeInFlightRef.current = operation;
      try {
        await operation;
      } finally {
        if (passwordChangeInFlightRef.current === operation) {
          passwordChangeInFlightRef.current = null;
        }
      }
    },
    [firebaseUser, profile, rememberPrivateKey]
  );

  const signOut = useCallback(async () => {
    const uid = firebaseUser?.uid ?? observedFirebaseUidRef.current ?? privateKeyUidRef.current;

    signInAttemptRef.current = null;
    observeFirebaseUid(null);
    clearAuthSession();
    clearPrivateKey();
    setFirebaseUser(null);
    setProfile(null);
    const firebaseSignOutPromise = firebaseSignOut(auth);
    const keyDeletePromise = uid
      ? deleteSessionPrivateKey(uid).catch(() => undefined)
      : Promise.resolve();

    await Promise.all([firebaseSignOutPromise, keyDeletePromise]);
  }, [clearPrivateKey, firebaseUser, observeFirebaseUid]);

  const value = useMemo(
    () => ({
      firebaseUser,
      profile,
      privateKey:
        profile?.isActive &&
        profile.uid === firebaseUserUid &&
        privateKeyUid === firebaseUserUid
          ? privateKey
          : null,
      loading,
      keyError,
      changePassword,
      loginRosterUser,
      unlockPrivateKey,
      signOut
    }),
    [
      changePassword,
      firebaseUser,
      firebaseUserUid,
      keyError,
      loading,
      loginRosterUser,
      privateKey,
      privateKeyUid,
      profile,
      signOut,
      unlockPrivateKey
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth는 AuthProvider 안에서만 사용할 수 있습니다.");
  }

  return context;
}
