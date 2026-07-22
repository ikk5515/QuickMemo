import { act, render, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicRosterUser, UserKeyDocument, UserProfile } from "../types";
import { AuthProvider, useAuth } from "./AuthContext";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

const mocks = vi.hoisted(() => {
  let authStateCallback: ((user: User | null) => void) | null = null;
  let sessionUid: string | null = null;

  return {
    auth: { currentUser: null as User | null },
    clearAuthSession: vi.fn(() => {
      sessionUid = null;
    }),
    deleteSessionPrivateKey: vi.fn(async () => undefined),
    emitAuthState(user: User | null) {
      authStateCallback?.(user);
    },
    firebaseSignOut: vi.fn(async () => {
      mocks.auth.currentUser = null;
    }),
    reauthenticateWithCredential: vi.fn(async () => undefined),
    getUserKeyDocument: vi.fn(),
    getUserProfile: vi.fn(),
    onAuthStateChanged: vi.fn((_auth: unknown, callback: (user: User | null) => void) => {
      authStateCallback = callback;
      return vi.fn();
    }),
    readAuthSession: vi.fn((uid: string) => (sessionUid === uid ? { expiresAt: Date.now() + 60_000, uid } : null)),
    readSessionPrivateKey: vi.fn(async () => null),
    resetState() {
      authStateCallback = null;
      sessionUid = null;
      mocks.auth.currentUser = null;
    },
    signInWithEmailAndPassword: vi.fn(),
    startAuthSession: vi.fn((uid: string) => {
      sessionUid = uid;
      return { expiresAt: Date.now() + 60_000, uid };
    }),
    subscribeUserProfile: vi.fn(() => vi.fn()),
    unlockPrivateKeyWithFallback: vi.fn(),
    updatePassword: vi.fn(async () => undefined),
    writeSessionPrivateKey: vi.fn(async () => 1 as number | null)
  };
});

vi.mock("firebase/auth", () => ({
  EmailAuthProvider: { credential: vi.fn() },
  onAuthStateChanged: mocks.onAuthStateChanged,
  reauthenticateWithCredential: mocks.reauthenticateWithCredential,
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  signOut: mocks.firebaseSignOut,
  updatePassword: mocks.updatePassword
}));

vi.mock("../lib/firebase", () => ({
  auth: mocks.auth,
  authPersistenceReady: Promise.resolve()
}));

vi.mock("../lib/authSession", () => ({
  clearAuthSession: mocks.clearAuthSession,
  readAuthSession: mocks.readAuthSession,
  startAuthSession: mocks.startAuthSession
}));

vi.mock("../lib/sessionPrivateKey", () => ({
  deleteSessionPrivateKey: mocks.deleteSessionPrivateKey,
  privateKeySessionDurationMs: 60 * 60 * 1000,
  readSessionPrivateKey: mocks.readSessionPrivateKey,
  writeSessionPrivateKey: mocks.writeSessionPrivateKey
}));

vi.mock("../lib/crypto", () => ({
  relockUserPrivateKey: vi.fn(),
  unlockPrivateKeyWithFallback: mocks.unlockPrivateKeyWithFallback
}));

vi.mock("../services/users", () => ({
  clearPendingUserKey: vi.fn(),
  getUserKeyDocument: mocks.getUserKeyDocument,
  getUserProfile: mocks.getUserProfile,
  promotePendingUserKey: vi.fn(),
  stagePendingUserKey: vi.fn(),
  subscribeUserProfile: mocks.subscribeUserProfile
}));

const userA = { uid: "user-a" } as User;
const userB = { uid: "user-b" } as User;

function profileFor(uid: string, isActive = true): UserProfile {
  return {
    uid,
    displayName: uid,
    avatarText: "A",
    color: "#000000",
    order: 1,
    quickKey: 1,
    loginEmail: `${uid}@example.com`,
    isActive,
    isAdmin: false,
    role: "user",
    publicKeyJwk: {}
  };
}

function rosterFor(uid: string): PublicRosterUser {
  const profile = profileFor(uid);

  return {
    uid: profile.uid,
    displayName: profile.displayName,
    avatarText: profile.avatarText,
    color: profile.color,
    order: profile.order,
    quickKey: profile.quickKey,
    loginEmail: profile.loginEmail,
    isActive: profile.isActive,
    isAdmin: profile.isAdmin
  };
}

const keyDocument = {
  encryptedPrivateKeyJwk: "encrypted",
  kdfIterations: 210_000,
  kdfSalt: "salt",
  publicKeyJwk: {},
  uid: "user-a"
} as unknown as UserKeyDocument;
const privateKey = {} as CryptoKey;

let currentAuth: ReturnType<typeof useAuth>;

function captureAuth(authValue: ReturnType<typeof useAuth>) {
  currentAuth = authValue;
}

function AuthHarness() {
  const authValue = useAuth();

  useEffect(() => {
    captureAuth(authValue);
  }, [authValue]);
  return null;
}

async function renderAuthProvider() {
  render(
    <AuthProvider>
      <AuthHarness />
    </AuthProvider>
  );
  await waitFor(() => expect(mocks.onAuthStateChanged).toHaveBeenCalledOnce());
}

describe("AuthProvider optimized login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetState();
    mocks.readSessionPrivateKey.mockResolvedValue(null);
    mocks.subscribeUserProfile.mockReturnValue(vi.fn());
    mocks.writeSessionPrivateKey.mockResolvedValue(1);
  });

  it("single-flights the auth observer profile load and fetches the key document in parallel", async () => {
    const profileLoad = deferred<UserProfile | null>();
    const keyLoad = deferred<UserKeyDocument | null>();

    mocks.getUserProfile.mockReturnValue(profileLoad.promise);
    mocks.getUserKeyDocument.mockReturnValue(keyLoad.promise);
    mocks.unlockPrivateKeyWithFallback.mockResolvedValue(privateKey);
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = userA;
      mocks.emitAuthState(userA);
      return { user: userA };
    });
    await renderAuthProvider();

    let loginPromise!: Promise<UserProfile>;
    act(() => {
      loginPromise = currentAuth.loginRosterUser(rosterFor("user-a"), "password");
    });

    await waitFor(() => {
      expect(mocks.getUserProfile).toHaveBeenCalledOnce();
      expect(mocks.getUserKeyDocument).toHaveBeenCalledOnce();
    });
    keyLoad.resolve(keyDocument);
    await Promise.resolve();
    expect(mocks.unlockPrivateKeyWithFallback).not.toHaveBeenCalled();

    profileLoad.resolve(profileFor("user-a"));
    await act(async () => {
      await expect(loginPromise).resolves.toMatchObject({ uid: "user-a", isActive: true });
    });

    expect(mocks.unlockPrivateKeyWithFallback).toHaveBeenCalledWith(keyDocument, "password");
    expect(mocks.writeSessionPrivateKey).toHaveBeenCalledWith("user-a", privateKey);
    expect(currentAuth.privateKey).toBe(privateKey);
  });

  it("never decrypts or restores a private key for an inactive profile", async () => {
    const profileLoad = deferred<UserProfile | null>();

    mocks.getUserProfile.mockReturnValue(profileLoad.promise);
    mocks.getUserKeyDocument.mockResolvedValue(keyDocument);
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = userA;
      mocks.emitAuthState(userA);
      return { user: userA };
    });
    await renderAuthProvider();

    let loginPromise!: Promise<UserProfile>;
    act(() => {
      loginPromise = currentAuth.loginRosterUser(rosterFor("user-a"), "password");
    });
    await waitFor(() => expect(mocks.getUserKeyDocument).toHaveBeenCalledOnce());
    profileLoad.resolve(profileFor("user-a", false));

    await act(async () => {
      await expect(loginPromise).rejects.toThrow("사용자 프로필 또는 암호화 키를 불러오지 못했습니다.");
    });
    expect(mocks.unlockPrivateKeyWithFallback).not.toHaveBeenCalled();
    expect(mocks.readSessionPrivateKey).not.toHaveBeenCalled();
    expect(mocks.firebaseSignOut).toHaveBeenCalledOnce();
    expect(currentAuth.privateKey).toBeNull();
  });

  it("does not publish a decrypted key when the user signs out during PBKDF2", async () => {
    const unlock = deferred<CryptoKey>();

    mocks.getUserProfile.mockResolvedValue(profileFor("user-a"));
    mocks.getUserKeyDocument.mockResolvedValue(keyDocument);
    mocks.unlockPrivateKeyWithFallback.mockReturnValue(unlock.promise);
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = userA;
      mocks.emitAuthState(userA);
      return { user: userA };
    });
    await renderAuthProvider();

    let loginPromise!: Promise<UserProfile>;
    act(() => {
      loginPromise = currentAuth.loginRosterUser(rosterFor("user-a"), "password");
    });
    await waitFor(() => expect(mocks.unlockPrivateKeyWithFallback).toHaveBeenCalledOnce());
    await act(async () => {
      await currentAuth.signOut();
    });
    unlock.resolve(privateKey);

    await act(async () => {
      await expect(loginPromise).rejects.toThrow("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
    });
    expect(mocks.writeSessionPrivateKey).not.toHaveBeenCalled();
    expect(currentAuth.firebaseUser).toBeNull();
    expect(currentAuth.privateKey).toBeNull();
  });

  it("does not let an old same-user login publish a key into a newer session", async () => {
    const unlock = deferred<CryptoKey>();

    mocks.getUserProfile.mockResolvedValue(profileFor("user-a"));
    mocks.getUserKeyDocument.mockResolvedValue(keyDocument);
    mocks.unlockPrivateKeyWithFallback.mockReturnValue(unlock.promise);
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = userA;
      mocks.emitAuthState(userA);
      return { user: userA };
    });
    await renderAuthProvider();

    let oldLoginPromise!: Promise<UserProfile>;
    act(() => {
      oldLoginPromise = currentAuth.loginRosterUser(rosterFor("user-a"), "password");
    });
    await waitFor(() => expect(mocks.unlockPrivateKeyWithFallback).toHaveBeenCalledOnce());

    await act(async () => {
      await currentAuth.signOut();
    });
    mocks.startAuthSession("user-a");
    mocks.auth.currentUser = userA;
    act(() => mocks.emitAuthState(userA));
    await waitFor(() => expect(currentAuth.profile?.uid).toBe("user-a"));

    unlock.resolve(privateKey);
    await act(async () => {
      await expect(oldLoginPromise).rejects.toThrow("로그인 세션이 만료되었거나 사용자가 비활성화되었습니다.");
    });
    expect(mocks.writeSessionPrivateKey).not.toHaveBeenCalled();
    expect(currentAuth.privateKey).toBeNull();
  });

  it("removes an idle-refresh key write that completes after sign-out", async () => {
    const idleWrite = deferred<number | null>();

    mocks.getUserProfile.mockResolvedValue(profileFor("user-a"));
    mocks.getUserKeyDocument.mockResolvedValue(keyDocument);
    mocks.unlockPrivateKeyWithFallback.mockResolvedValue(privateKey);
    mocks.writeSessionPrivateKey
      .mockResolvedValueOnce(1)
      .mockReturnValueOnce(idleWrite.promise);
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = userA;
      mocks.emitAuthState(userA);
      return { user: userA };
    });
    await renderAuthProvider();

    await act(async () => {
      await expect(currentAuth.loginRosterUser(rosterFor("user-a"), "password"))
        .resolves.toMatchObject({ uid: "user-a" });
    });
    await waitFor(() => expect(mocks.writeSessionPrivateKey).toHaveBeenCalledTimes(2));

    await act(async () => {
      await currentAuth.signOut();
    });
    idleWrite.resolve(2);

    await waitFor(() => expect(mocks.deleteSessionPrivateKey).toHaveBeenCalledWith("user-a", 2));
    expect(currentAuth.privateKey).toBeNull();
  });

  it("does not create an app session for a different persisted Firebase user", async () => {
    const signIn = deferred<{ user: User }>();

    mocks.signInWithEmailAndPassword.mockReturnValue(signIn.promise);
    mocks.getUserProfile.mockResolvedValue(profileFor("user-b"));
    await renderAuthProvider();

    let loginPromise!: Promise<UserProfile>;
    act(() => {
      loginPromise = currentAuth.loginRosterUser(rosterFor("user-a"), "password");
    });
    mocks.auth.currentUser = userB;
    act(() => mocks.emitAuthState(userB));
    await waitFor(() => expect(mocks.firebaseSignOut).toHaveBeenCalled());

    signIn.reject(new Error("invalid password"));
    await act(async () => {
      await expect(loginPromise).rejects.toThrow("invalid password");
    });
    expect(mocks.startAuthSession).not.toHaveBeenCalledWith("user-b");
    expect(currentAuth.privateKey).toBeNull();
  });

  it("does not trust a same-user Firebase observer before the password succeeds", async () => {
    const signIn = deferred<{ user: User }>();

    mocks.signInWithEmailAndPassword.mockReturnValue(signIn.promise);
    await renderAuthProvider();

    let loginPromise!: Promise<UserProfile>;
    act(() => {
      loginPromise = currentAuth.loginRosterUser(rosterFor("user-a"), "wrong-password");
    });
    await waitFor(() => expect(mocks.signInWithEmailAndPassword).toHaveBeenCalledOnce());
    mocks.auth.currentUser = userA;
    act(() => mocks.emitAuthState(userA));
    await waitFor(() => expect(mocks.onAuthStateChanged).toHaveBeenCalledOnce());

    expect(mocks.startAuthSession).not.toHaveBeenCalled();
    expect(mocks.getUserProfile).not.toHaveBeenCalled();
    expect(mocks.readSessionPrivateKey).not.toHaveBeenCalled();

    signIn.reject(new Error("invalid password"));
    await act(async () => {
      await expect(loginPromise).rejects.toThrow("invalid password");
    });
    expect(mocks.firebaseSignOut).toHaveBeenCalledOnce();
    expect(currentAuth.profile).toBeNull();
    expect(currentAuth.privateKey).toBeNull();
  });

  it("serializes password changes so key bundles cannot cross", async () => {
    const reauthentication = deferred<undefined>();

    mocks.getUserProfile.mockResolvedValue(profileFor("user-a"));
    mocks.getUserKeyDocument.mockResolvedValue(keyDocument);
    mocks.unlockPrivateKeyWithFallback.mockResolvedValue(privateKey);
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = userA;
      mocks.emitAuthState(userA);
      return { user: userA };
    });
    await renderAuthProvider();
    await act(async () => {
      await currentAuth.loginRosterUser(rosterFor("user-a"), "password");
    });
    mocks.reauthenticateWithCredential.mockReturnValueOnce(reauthentication.promise);

    let firstChange!: Promise<void>;
    act(() => {
      firstChange = currentAuth.changePassword("password", "next-password-a");
    });
    await waitFor(() => expect(mocks.reauthenticateWithCredential).toHaveBeenCalledOnce());

    await expect(currentAuth.changePassword("password", "next-password-b"))
      .rejects.toThrow("비밀번호를 변경하고 있습니다.");
    expect(mocks.reauthenticateWithCredential).toHaveBeenCalledOnce();

    reauthentication.reject(new Error("stop first change"));
    await act(async () => {
      await expect(firstChange).rejects.toThrow("stop first change");
    });
  });

  it("ignores a stale profile result after an account switch", async () => {
    const profileA = deferred<UserProfile | null>();
    const profileB = deferred<UserProfile | null>();

    mocks.getUserProfile.mockImplementation((uid: string) => (uid === "user-a" ? profileA.promise : profileB.promise));
    mocks.getUserKeyDocument.mockResolvedValue(keyDocument);
    mocks.signInWithEmailAndPassword.mockImplementation(async () => {
      mocks.auth.currentUser = userA;
      mocks.emitAuthState(userA);
      return { user: userA };
    });
    await renderAuthProvider();

    let loginPromise!: Promise<UserProfile>;
    act(() => {
      loginPromise = currentAuth.loginRosterUser(rosterFor("user-a"), "password");
    });
    await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledWith("user-a"));

    mocks.startAuthSession("user-b");
    mocks.auth.currentUser = userB;
    act(() => mocks.emitAuthState(userB));
    await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledWith("user-b"));
    profileB.resolve(profileFor("user-b"));
    profileA.resolve(profileFor("user-a"));

    await act(async () => {
      await expect(loginPromise).rejects.toThrow("사용자 프로필 또는 암호화 키를 불러오지 못했습니다.");
    });
    await waitFor(() => expect(currentAuth.profile?.uid).toBe("user-b"));
    expect(mocks.unlockPrivateKeyWithFallback).not.toHaveBeenCalled();
    expect(currentAuth.firebaseUser?.uid).toBe("user-b");
    expect(currentAuth.privateKey).toBeNull();
  });
});
