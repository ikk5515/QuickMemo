import {
  GoogleAuthProvider,
  User,
  deleteUser,
  linkWithPopup,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut
} from "firebase/auth";
import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { auth } from "../lib/firebase";
import { unlockPrivateKey as unlockStoredPrivateKey } from "../lib/crypto";
import { getUserKeyDocument, getUserProfile } from "../services/users";
import type { PublicRosterUser, UserProfile } from "../types";

interface AuthContextValue {
  firebaseUser: User | null;
  profile: UserProfile | null;
  privateKey: CryptoKey | null;
  loading: boolean;
  keyError: string | null;
  googleLinked: boolean;
  linkGoogleLogin: () => Promise<void>;
  loginWithGoogle: () => Promise<UserProfile>;
  loginRosterUser: (user: PublicRosterUser, password: string) => Promise<UserProfile>;
  unlockPrivateKey: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function googleProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyError, setKeyError] = useState<string | null>(null);

  const loadProfile = useCallback(async (user: User | null) => {
    if (!user) {
      setFirebaseUser(null);
      setProfile(null);
      setPrivateKey(null);
      setLoading(false);
      return null;
    }

    const nextProfile = await getUserProfile(user.uid);

    if (nextProfile && !nextProfile.isActive) {
      await firebaseSignOut(auth);
      setFirebaseUser(null);
      setProfile(null);
      setPrivateKey(null);
      setLoading(false);
      return null;
    }

    setFirebaseUser(user);
    setProfile(nextProfile);
    setLoading(false);
    return nextProfile;
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setLoading(true);
      void loadProfile(user).catch(() => {
        setFirebaseUser(user);
        setProfile(null);
        setLoading(false);
      });
    });
  }, [loadProfile]);

  const unlockPrivateKey = useCallback(
    async (password: string) => {
      if (!firebaseUser || !profile) {
        throw new Error("로그인된 사용자가 없습니다.");
      }

      setKeyError(null);
      await signInWithEmailAndPassword(auth, profile.loginEmail, password);
      const keyDocument = await getUserKeyDocument(firebaseUser.uid);

      if (!keyDocument) {
        throw new Error("사용자 암호화 키를 찾을 수 없습니다.");
      }

      try {
        setPrivateKey(await unlockStoredPrivateKey(keyDocument, password));
      } catch (error) {
        setKeyError("노트 암호화 키를 열 수 없습니다. 비밀번호를 확인해주세요.");
        throw error;
      }
    },
    [firebaseUser, profile]
  );

  const loginRosterUser = useCallback(
    async (rosterUser: PublicRosterUser, password: string) => {
      setKeyError(null);
      const credential = await signInWithEmailAndPassword(auth, rosterUser.loginEmail, password);
      const nextProfile = await loadProfile(credential.user);
      const keyDocument = await getUserKeyDocument(credential.user.uid);

      if (!nextProfile || !keyDocument) {
        throw new Error("사용자 프로필 또는 암호화 키를 불러오지 못했습니다.");
      }

      setPrivateKey(await unlockStoredPrivateKey(keyDocument, password));
      return nextProfile;
    },
    [loadProfile]
  );

  const loginWithGoogle = useCallback(async () => {
    setKeyError(null);
    const credential = await signInWithPopup(auth, googleProvider());
    const nextProfile = await getUserProfile(credential.user.uid);

    if (!nextProfile) {
      await deleteUser(credential.user).catch(() => firebaseSignOut(auth));
      throw new Error("QuickMemo 사용자에 연결된 Google 계정이 아닙니다. 먼저 기존 계정으로 로그인한 뒤 Google 연결을 진행하세요.");
    }

    if (!nextProfile.isActive) {
      await firebaseSignOut(auth);
      throw new Error("비활성화된 사용자입니다.");
    }

    await loadProfile(credential.user);
    setPrivateKey(null);
    return nextProfile;
  }, [loadProfile]);

  const linkGoogleLogin = useCallback(async () => {
    if (!firebaseUser || !profile) {
      throw new Error("로그인된 사용자가 없습니다.");
    }

    const credential = await linkWithPopup(firebaseUser, googleProvider());
    await loadProfile(credential.user);
  }, [firebaseUser, loadProfile, profile]);

  const signOut = useCallback(async () => {
    setPrivateKey(null);
    await firebaseSignOut(auth);
  }, []);

  const googleLinked = useMemo(
    () => Boolean(firebaseUser?.providerData.some((provider) => provider.providerId === "google.com")),
    [firebaseUser]
  );

  const value = useMemo(
    () => ({
      firebaseUser,
      profile,
      privateKey,
      loading,
      keyError,
      googleLinked,
      linkGoogleLogin,
      loginWithGoogle,
      loginRosterUser,
      unlockPrivateKey,
      signOut
    }),
    [
      firebaseUser,
      googleLinked,
      keyError,
      linkGoogleLogin,
      loading,
      loginRosterUser,
      loginWithGoogle,
      privateKey,
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
