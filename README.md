# QuickMemo

Firebase 기반의 실시간 암호화 메모 웹앱입니다.

## 주요 기능

- 첫 관리자 생성 화면(`/setup`)
- 원형 사용자 버튼 + 숫자 키 빠른 로그인(`/login`)
- 관리자 전용 사용자 생성, 권한, 색상, 원 안 글자, 순서 관리(`/admin`)
- 개인 노트와 선택 사용자 공유 노트(`/app`)
- Firestore 실시간 구독 기반 동기화
- Web Crypto API 기반 클라이언트 노트 암호화
- Firebase Auth와 Firestore Rules 기반 권한 제어

## 로컬 실행

```bash
npm install
cp .env.example .env.local
npm run dev
```

`.env.local`에는 Firebase 웹 앱 설정을 넣습니다. Firebase Emulator를 사용할 때는:

```bash
VITE_USE_FIREBASE_EMULATORS=true
npm run emulators
```

Firestore Emulator는 Java Runtime이 필요합니다.

## Firebase DB 연결

1. Firebase Console에서 프로젝트를 만듭니다.
2. 프로젝트 설정 > 일반 > 내 앱에서 웹 앱을 추가합니다.
3. Firebase가 보여주는 `firebaseConfig` 값을 `.env.local`에 넣습니다.

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_USE_FIREBASE_EMULATORS=false
```

4. Build > Firestore Database에서 데이터베이스를 만들고 production mode로 시작합니다.
5. Build > Authentication에서 시작하기를 누른 뒤 Sign-in method에서 Email/Password를 활성화하고 저장합니다.
6. `.firebaserc.example`을 `.firebaserc`로 복사하고 프로젝트 ID를 넣습니다.

```bash
cp .firebaserc.example .firebaserc
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

이 앱은 `src/lib/firebase.ts`에서 `.env.local` 값을 읽어 Firebase 앱, Auth, Firestore를 초기화합니다. Firestore 컬렉션은 앱 사용 중 클라이언트와 Firestore Rules 검증으로 생성됩니다.

Functions 없이 동작하도록 구성되어 있으므로 Blaze 요금제가 없어도 Firestore Rules/Indexes 배포와 Vercel 프론트엔드 배포로 사용할 수 있습니다. 단, Firebase Auth 제한 때문에 관리자가 다른 사용자의 비밀번호를 강제로 변경하려면 Admin SDK가 실행되는 신뢰할 수 있는 서버가 필요합니다.

### Auth 설정 오류 해결

첫 관리자 생성 중 `Firebase: Error (auth/configuration-not-found)`가 나오면 Firebase Auth가 아직 초기화되지 않은 상태입니다.

1. Firebase Console > Build > Authentication으로 이동합니다.
2. `시작하기`가 보이면 먼저 클릭합니다.
3. Sign-in method 탭에서 Email/Password 제공업체를 열고 첫 번째 Email/Password 토글을 활성화한 뒤 저장합니다.
4. Project settings > General > Your apps의 Web app config가 `.env.local`의 `VITE_FIREBASE_*` 값과 같은 프로젝트인지 확인합니다.
5. 로컬 서버를 재시작한 뒤 `/setup`에서 첫 관리자를 다시 생성합니다.

이 오류는 Firestore Rules나 DB 연결 문제가 아니라 `accounts:signUp` 요청을 처리할 Firebase Authentication 설정이 프로젝트에 없을 때 발생합니다.

### 관리자 비밀번호 강제 변경

다른 사용자의 Firebase Auth 비밀번호를 관리자가 강제로 변경하는 기능은 브라우저나 Firestore Rules만으로 안전하게 구현할 수 없습니다. 사용자의 현재 비밀번호 없이 Auth 계정을 수정하려면 Firebase Admin SDK의 관리자 권한이 필요하고, 이 SDK는 서비스 계정 권한을 쓰기 때문에 클라이언트 앱이나 Firestore 문서에 둘 수 없습니다.

선택지는 두 가지입니다.

- Spark/무료 유지: 관리자가 새 사용자의 초기 비밀번호만 설정하고, 기존 사용자는 본인 비밀번호로 로그인합니다. 비밀번호를 잊은 경우에는 관리자가 계정을 새로 만들거나 별도 복구 절차를 둡니다.
- 강제 변경 유지: Firebase Cloud Functions, Cloud Run, 자체 서버 같은 신뢰할 수 있는 백엔드에 Admin SDK를 두고 관리자 권한을 검증한 뒤 `updateUser(uid, { password })`를 호출합니다. Cloud Functions 배포는 Blaze 요금제가 필요합니다.

Firestore DB에 새 비밀번호를 저장해서 우회하는 방식은 권장하지 않습니다. Firebase Auth의 세션/해시/토큰 시스템과 분리되어 실제 로그인 비밀번호가 바뀌지 않고, 평문 또는 복호화 가능한 비밀번호를 DB에 두게 되어 보안 위험이 커집니다.

### Firebase App Check

운영 배포 전에는 Firebase Console > App Check에서 웹 앱을 등록하고 reCAPTCHA Enterprise site key를 발급한 뒤 아래 값을 설정하세요.

```bash
VITE_RECAPTCHA_ENTERPRISE_SITE_KEY=...
```

값이 있으면 앱이 App Check 토큰 자동 갱신을 켭니다. 처음에는 Firebase Console에서 모니터링 모드로 트래픽을 확인한 뒤 Firestore enforcement를 켜는 흐름을 권장합니다.

## Firebase 배포 준비

```bash
cp .firebaserc.example .firebaserc
npm run build
npx firebase-tools deploy --only firestore:rules,firestore:indexes,hosting
```

전역 Firebase CLI가 없어도 `npx firebase-tools`로 실행할 수 있습니다. Vercel을 프론트엔드로 사용할 예정이면 Firebase Hosting 배포는 생략하고 Firestore Rules/Indexes만 배포하면 됩니다.

## Vercel 배포 준비

Vite SPA 라우팅을 위해 `vercel.json`에 모든 경로를 `/index.html`로 보내는 rewrite를 추가했습니다. Vercel 프로젝트 설정의 Environment Variables에 `.env.local`과 같은 `VITE_...` 값을 Production/Preview 환경별로 넣으면 됩니다.

Firebase Hosting을 쓰지 않고 Vercel에 프론트엔드를 올려도 됩니다. 단, Firestore Rules와 Indexes는 Firebase에 별도로 배포되어 있어야 합니다.

## GitHub 작업

CI는 `.github/workflows/ci.yml`에 추가되어 PR과 `main`/`master` push마다 다음을 실행합니다.

- lint
- typecheck
- unit tests
- Firestore Rules tests
- production build

자동 PR 생성을 하려면 GitHub CLI가 필요합니다.

```bash
brew install gh
gh auth login
```

설치 후 이 저장소에서 다시 요청하면 현재 변경사항을 브랜치로 커밋하고 원격에 push한 뒤 draft PR까지 열 수 있습니다.

## 검증

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Firestore Rules 통합 테스트:

```bash
npm run test:rules
```

이 명령은 Firebase Firestore Emulator와 Java Runtime이 필요합니다.
