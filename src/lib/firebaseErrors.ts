const authErrorMessages: Record<string, string> = {
  "auth/configuration-not-found":
    "Firebase Authentication 설정을 찾지 못했습니다. Firebase Console > Build > Authentication에서 시작하기를 누르고, Sign-in method에서 Email/Password를 활성화한 뒤 다시 시도하세요.",
  "auth/operation-not-allowed":
    "로그인 제공업체가 비활성화되어 있습니다. Firebase Console > Authentication > Sign-in method에서 필요한 제공업체를 활성화하세요.",
  "auth/unauthorized-domain":
    "현재 접속 도메인이 Firebase Auth 승인 도메인에 없습니다. Firebase Console > Authentication > Settings > Authorized domains에 로컬/배포 도메인을 추가하세요.",
  "auth/account-exists-with-different-credential": "이미 다른 로그인 방식으로 가입된 이메일입니다. 기존 방식으로 로그인한 뒤 Google 연결을 진행하세요.",
  "auth/cancelled-popup-request": "이미 진행 중인 Google 로그인 창이 있습니다.",
  "auth/credential-already-in-use": "이 Google 계정은 이미 다른 사용자에 연결되어 있습니다.",
  "auth/email-already-in-use": "이미 같은 로그인 별칭을 가진 사용자가 있습니다. 다시 시도하세요.",
  "auth/invalid-api-key": ".env.local의 Firebase API key가 올바르지 않습니다.",
  "auth/invalid-credential": "비밀번호를 확인해주세요.",
  "auth/invalid-email": "로그인 식별자 형식이 올바르지 않습니다.",
  "auth/network-request-failed": "네트워크 연결을 확인한 뒤 다시 시도하세요.",
  "auth/popup-blocked": "브라우저가 Google 로그인 팝업을 차단했습니다. 팝업 허용 후 다시 시도하세요.",
  "auth/popup-closed-by-user": "Google 로그인 창이 닫혔습니다.",
  "auth/provider-already-linked": "이미 Google 로그인이 연결되어 있습니다.",
  "auth/too-many-requests": "짧은 시간에 요청이 너무 많았습니다. 잠시 뒤 다시 시도하세요.",
  "auth/user-disabled": "비활성화된 사용자입니다.",
  "auth/weak-password": "비밀번호는 6자 이상이어야 합니다.",
  "auth/wrong-password": "비밀번호를 확인해주세요."
};

function errorCode(error: unknown) {
  if (typeof error === "object" && error && "code" in error) {
    return String((error as { code?: unknown }).code);
  }

  return "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}

export function firebaseAuthErrorMessage(error: unknown, fallback: string) {
  const code = errorCode(error);
  const message = errorMessage(error);

  if (authErrorMessages[code]) {
    return authErrorMessages[code];
  }

  if (message.includes("CONFIGURATION_NOT_FOUND") || message.includes("configuration-not-found")) {
    return authErrorMessages["auth/configuration-not-found"];
  }

  return message || fallback;
}
