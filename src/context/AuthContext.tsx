import {
  EmailAuthProvider,
  User,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updatePassword
} from "firebase/auth";
import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { auth, authPersistenceReady } from "../lib/firebase";
import {
  clearFirebaseAuthSession,
  ensureFirebaseAuthSession,
  firebaseAuthSessionDurationMs,
  firebaseAuthSessionExpired,
  firebaseAuthSessionRemainingMs,
  startFirebaseAuthSession
} from "../lib/authSession";
import { relockUserPrivateKey, unlockPrivateKeyWithFallback } from "../lib/crypto";
import {
  createPasskeyUnlockPayload,
  passkeyUnlockSupported,
  unlockPrivateKeyWithPasskeyPayload
} from "../lib/passkeyUnlock";
import {
  deleteSessionPrivateKey,
  privateKeySessionDurationMs,
  readSessionPrivateKey,
  writeSessionPrivateKey
} from "../lib/sessionPrivateKey";
import {
  clearPendingUserKey,
  clearUserPasskeyUnlock,
  getUserKeyDocument,
  getUserProfile,
  promotePendingUserKey,
  saveUserPasskeyUnlock,
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
  passkeySupported: boolean;
  passkeyUnlockAvailable: boolean;
  changePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  loginRosterUser: (user: PublicRosterUser, password: string) => Promise<UserProfile>;
  registerPasskeyUnlock: (password: string) => Promise<void>;
  removePasskeyUnlock: () => Promise<void>;
  unlockPrivateKey: (password: string) => Promise<void>;
  unlockPrivateKeyWithPasskey: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [privateKeyUid, setPrivateKeyUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [passkeyUnlockAvailable, setPasskeyUnlockAvailable] = useState(false);
  const privateKeyUidRef = useRef<string | null>(null);
  const firebaseUserUid = firebaseUser?.uid ?? null;
  const passkeySupported = useMemo(() => passkeyUnlockSupported(), []);

  const clearPrivateKey = useCallback(() => {
    privateKeyUidRef.current = null;
    setPrivateKeyUid(null);
    setPrivateKey(null);
  }, []);

  const endFirebaseSession = useCallback(
    async (uid?: string | null) => {
      const targetUid = uid ?? privateKeyUidRef.current ?? auth.currentUser?.uid;

      clearPrivateKey();
      setPasskeyUnlockAvailable(false);

      if (targetUid) {
        clearFirebaseAuthSession(targetUid);
        await deleteSessionPrivateKey(targetUid).catch(() => undefined);
      }

      await firebaseSignOut(auth);
      setFirebaseUser(null);
      setProfile(null);
    },
    [clearPrivateKey]
  );

  const rememberPrivateKey = useCallback((uid: string, key: CryptoKey) => {
    privateKeyUidRef.current = uid;
    setPrivateKeyUid(uid);
    setPrivateKey(key);
    void writeSessionPrivateKey(uid, key).catch(() => undefined);
  }, []);

  const refreshPasskeyUnlockAvailability = useCallback(async (uid: string) => {
    const keyDocument = await getUserKeyDocument(uid).catch(() => null);
    setPasskeyUnlockAvailable(Boolean(keyDocument?.passkeyUnlock));
    return keyDocument;
  }, []);

  const loadProfile = useCallback(async (user: User | null) => {
    if (!user) {
      const unlockedUid = privateKeyUidRef.current;
      if (unlockedUid) {
        clearFirebaseAuthSession(unlockedUid);
        await deleteSessionPrivateKey(unlockedUid).catch(() => undefined);
      }
      setFirebaseUser(null);
      setProfile(null);
      setPasskeyUnlockAvailable(false);
      clearPrivateKey();
      setLoading(false);
      return null;
    }

    if (firebaseAuthSessionExpired(user.uid)) {
      await endFirebaseSession(user.uid);
      setLoading(false);
      return null;
    }

    ensureFirebaseAuthSession(user.uid);

    const nextProfile = await getUserProfile(user.uid);

    if (nextProfile && !nextProfile.isActive) {
      await endFirebaseSession(user.uid);
      setLoading(false);
      return null;
    }

    const cachedPrivateKey = await readSessionPrivateKey(user.uid).catch(() => null);
    await refreshPasskeyUnlockAvailability(user.uid);

    setFirebaseUser(user);
    setProfile(nextProfile);
    if (cachedPrivateKey) {
      rememberPrivateKey(user.uid, cachedPrivateKey);
    } else if (privateKeyUidRef.current !== user.uid) {
      clearPrivateKey();
    }
    setLoading(false);
    return nextProfile;
  }, [clearPrivateKey, endFirebaseSession, refreshPasskeyUnlockAvailability, rememberPrivateKey]);

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
          setFirebaseUser(user);
          setProfile(null);
          if (!user || privateKeyUidRef.current !== user.uid) {
            clearPrivateKey();
          }
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

    let active = true;

    const unsubscribe = subscribeUserProfile(
      firebaseUserUid,
      (nextProfile) => {
        if (!active) {
          return;
        }

        if (nextProfile && !nextProfile.isActive) {
          void endFirebaseSession(firebaseUserUid);
          return;
        }

        setProfile(nextProfile);
      },
      () => {
        if (active) {
          setProfile(null);
        }
      }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [endFirebaseSession, firebaseUserUid]);

  useEffect(() => {
    if (!firebaseUserUid) {
      return undefined;
    }

    const remainingMs = firebaseAuthSessionRemainingMs(firebaseUserUid);
    const timeoutMs = Math.max(0, remainingMs ?? firebaseAuthSessionDurationMs);
    const timeoutId = window.setTimeout(() => {
      void endFirebaseSession(firebaseUserUid);
    }, timeoutMs);

    return () => window.clearTimeout(timeoutId);
  }, [endFirebaseSession, firebaseUserUid]);

  useEffect(() => {
    if (!firebaseUserUid || !privateKey || privateKeyUid !== firebaseUserUid) {
      return undefined;
    }

    const uid = firebaseUserUid;
    const sessionPrivateKey = privateKey;
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
      void writeSessionPrivateKey(uid, sessionPrivateKey, lastRefreshAt + privateKeySessionDurationMs).catch(() => undefined);
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

      setKeyError(null);
      await authPersistenceReady;
      const credential = await signInWithEmailAndPassword(auth, profile.loginEmail, password);
      startFirebaseAuthSession(credential.user.uid);
      const keyDocument = await refreshPasskeyUnlockAvailability(credential.user.uid);

      if (!keyDocument) {
        throw new Error("사용자 암호화 키를 찾을 수 없습니다.");
      }

      try {
        rememberPrivateKey(credential.user.uid, await unlockPrivateKeyWithFallback(keyDocument, password));
      } catch (error) {
        setKeyError("노트 암호화 키를 열 수 없습니다. 비밀번호를 확인해주세요.");
        throw error;
      }
    },
    [firebaseUser, profile, refreshPasskeyUnlockAvailability, rememberPrivateKey]
  );

  const loginRosterUser = useCallback(
    async (rosterUser: PublicRosterUser, password: string) => {
      setKeyError(null);
      await authPersistenceReady;
      const credential = await signInWithEmailAndPassword(auth, rosterUser.loginEmail, password);
      startFirebaseAuthSession(credential.user.uid);
      const nextProfile = await loadProfile(credential.user);
      const keyDocument = await getUserKeyDocument(credential.user.uid);

      if (!nextProfile || !keyDocument) {
        throw new Error("사용자 프로필 또는 암호화 키를 불러오지 못했습니다.");
      }

      rememberPrivateKey(credential.user.uid, await unlockPrivateKeyWithFallback(keyDocument, password));
      return nextProfile;
    },
    [loadProfile, rememberPrivateKey]
  );

  const changePassword = useCallback(
    async (currentPassword: string, nextPassword: string) => {
      if (!firebaseUser || !profile) {
        throw new Error("로그인된 사용자가 없습니다.");
      }

      const credential = EmailAuthProvider.credential(profile.loginEmail, currentPassword);
      await reauthenticateWithCredential(firebaseUser, credential);

      const keyDocument = await getUserKeyDocument(firebaseUser.uid);

      if (!keyDocument) {
        throw new Error("사용자 암호화 키를 찾을 수 없습니다.");
      }

      const nextKeyBundle = await relockUserPrivateKey(keyDocument, currentPassword, nextPassword);
      await stagePendingUserKey(firebaseUser.uid, nextKeyBundle);

      let authPasswordChanged = false;

      try {
        await updatePassword(firebaseUser, nextPassword);
        authPasswordChanged = true;
        await promotePendingUserKey(firebaseUser.uid, nextKeyBundle);
        rememberPrivateKey(firebaseUser.uid, await unlockPrivateKeyWithFallback({ ...keyDocument, ...nextKeyBundle }, nextPassword));
        setKeyError(null);
      } catch (error) {
        if (!authPasswordChanged) {
          await clearPendingUserKey(firebaseUser.uid).catch(() => undefined);
        }

        throw error;
      }
    },
    [firebaseUser, profile, rememberPrivateKey]
  );

  const registerPasskeyUnlock = useCallback(
    async (password: string) => {
      if (!firebaseUser || !profile) {
        throw new Error("로그인된 사용자가 없습니다.");
      }

      if (firebaseAuthSessionExpired(firebaseUser.uid)) {
        await endFirebaseSession(firebaseUser.uid);
        throw new Error("로그인 세션이 만료되었습니다.");
      }

      const keyDocument = await getUserKeyDocument(firebaseUser.uid);

      if (!keyDocument) {
        throw new Error("사용자 암호화 키를 찾을 수 없습니다.");
      }

      const passkeyUnlock = await createPasskeyUnlockPayload(profile, keyDocument, password);
      await saveUserPasskeyUnlock(firebaseUser.uid, passkeyUnlock);
      setPasskeyUnlockAvailable(true);
    },
    [endFirebaseSession, firebaseUser, profile]
  );

  const removePasskeyUnlock = useCallback(async () => {
    if (!firebaseUser) {
      throw new Error("로그인된 사용자가 없습니다.");
    }

    if (firebaseAuthSessionExpired(firebaseUser.uid)) {
      await endFirebaseSession(firebaseUser.uid);
      throw new Error("로그인 세션이 만료되었습니다.");
    }

    await clearUserPasskeyUnlock(firebaseUser.uid);
    setPasskeyUnlockAvailable(false);
  }, [endFirebaseSession, firebaseUser]);

  const unlockPrivateKeyWithPasskey = useCallback(async () => {
    if (!firebaseUser) {
      throw new Error("로그인된 사용자가 없습니다.");
    }

    if (firebaseAuthSessionExpired(firebaseUser.uid)) {
      await endFirebaseSession(firebaseUser.uid);
      throw new Error("로그인 세션이 만료되었습니다.");
    }

    setKeyError(null);
    const keyDocument = await refreshPasskeyUnlockAvailability(firebaseUser.uid);

    if (!keyDocument) {
      throw new Error("사용자 암호화 키를 찾을 수 없습니다.");
    }

    try {
      rememberPrivateKey(firebaseUser.uid, await unlockPrivateKeyWithPasskeyPayload(keyDocument));
    } catch (error) {
      setKeyError("Passkey로 노트 암호화 키를 열 수 없습니다.");
      throw error;
    }
  }, [endFirebaseSession, firebaseUser, refreshPasskeyUnlockAvailability, rememberPrivateKey]);

  const signOut = useCallback(async () => {
    await endFirebaseSession(firebaseUser?.uid);
  }, [endFirebaseSession, firebaseUser]);

  const value = useMemo(
    () => ({
      firebaseUser,
      profile,
      privateKey: privateKeyUid === firebaseUserUid ? privateKey : null,
      loading,
      keyError,
      passkeySupported,
      passkeyUnlockAvailable,
      changePassword,
      loginRosterUser,
      registerPasskeyUnlock,
      removePasskeyUnlock,
      unlockPrivateKey,
      unlockPrivateKeyWithPasskey,
      signOut
    }),
    [
      changePassword,
      firebaseUser,
      firebaseUserUid,
      keyError,
      loading,
      loginRosterUser,
      passkeySupported,
      passkeyUnlockAvailable,
      privateKey,
      privateKeyUid,
      profile,
      registerPasskeyUnlock,
      removePasskeyUnlock,
      signOut,
      unlockPrivateKey,
      unlockPrivateKeyWithPasskey
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
