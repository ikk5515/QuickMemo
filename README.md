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
6. `.firebaserc.example`을 `.firebaserc`로 복사하고 프로젝트 ID를 넣습니다. `.firebaserc`는 로컬/운영 프로젝트 식별자를 담을 수 있어 git에 올리지 않습니다.

```bash
cp .firebaserc.example .firebaserc
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

이 앱은 `src/lib/firebase.ts`에서 `.env.local` 값을 읽어 Firebase 앱, Auth, Firestore를 초기화합니다. Firestore 컬렉션은 앱 사용 중 클라이언트와 Firestore Rules 검증으로 생성됩니다.

Firebase Cloud Functions 없이 동작하도록 구성되어 있으므로 Blaze 요금제가 없어도 Firestore Rules/Indexes 배포와 Vercel 프론트엔드 배포로 사용할 수 있습니다. 단, Firebase Auth 제한 때문에 관리자가 다른 사용자의 비밀번호를 강제로 변경하려면 Admin SDK가 실행되는 신뢰할 수 있는 서버가 필요합니다.

### 임시 공유 만료 cleanup

임시 공유 문서는 Vercel Cron cleanup으로 만료 데이터를 정리합니다.

- Vercel Cron cleanup: Firebase billing 없이도 `/api/cleanup-public-shares`가 하루 한 번 서비스 계정 OAuth로 만료된 공유와 공유 첨부 파일을 삭제합니다. 이 경로는 소유자가 다시 로그인하거나 NotesPage를 열지 않아도 동작합니다.
- Firestore TTL: billing이 꺼진 프로젝트에서는 TTL field override 배포가 403으로 실패하므로 기본 배포 파일에는 TTL을 켜지 않습니다. billing이 활성화된 별도 환경에서 TTL을 보조 안전장치로 쓰려면 운영자가 콘솔이나 별도 인덱스 설정으로 켜야 합니다.

Vercel 운영 환경에는 아래 값을 설정합니다. `FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON`에는 서비스 계정 JSON 전체를 넣거나, `FIREBASE_CLEANUP_CLIENT_EMAIL`과 `FIREBASE_CLEANUP_PRIVATE_KEY`를 나누어 넣을 수 있습니다.

```bash
CRON_SECRET=at-least-16-random-characters
FIREBASE_CLEANUP_PROJECT_ID=your-firebase-project-id
FIREBASE_CLEANUP_CLIENT_EMAIL=cleanup-account@your-firebase-project-id.iam.gserviceaccount.com
FIREBASE_CLEANUP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
PUBLIC_SHARE_CLEANUP_BATCH_SIZE=50
PUBLIC_SHARE_CLEANUP_MAX_DELETES=1000
```

Vercel Hobby 플랜은 Cron이 하루 한 번 실행되므로 `vercel.json`의 schedule도 일 1회로 맞춰져 있습니다. cleanup 함수는 `publicShareCleanupQueue.expiresAt <= now`인 queue 문서를 조회해 해당 공유 첨부 파일, 원본 공유 문서, cleanup queue를 함께 삭제합니다. 서비스 계정에는 Firestore 문서 조회/삭제와 Firebase Auth 사용자 조회/삭제에 필요한 최소 IAM 권한만 부여하세요.

### 관리자 사용자 삭제

관리자 화면의 사용자 삭제는 브라우저에서 바로 Firebase Auth 사용자를 삭제하지 않고 `/api/delete-managed-user` Vercel API를 통해 처리합니다. 이 API는 현재 로그인한 관리자의 Firebase ID 토큰을 Identity Toolkit `accounts:lookup`으로 확인하고, Firestore의 `users/{uid}`에서 `isActive`와 `isAdmin`을 다시 검증한 뒤 대상 Auth 계정과 앱 문서를 삭제합니다.

이 기능도 위의 `FIREBASE_CLEANUP_*` 서비스 계정 환경 변수를 같이 사용합니다. Vercel Production 환경에 해당 변수가 없거나 서비스 계정에 Firebase Auth 사용자 삭제 권한이 없으면 앱 문서는 삭제되지 않고 관리자 화면에 실패로 표시됩니다.

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

## 민감 파일 관리

아래 파일은 로컬 또는 배포 환경별 비밀값과 프로젝트 메타데이터를 담을 수 있으므로 git과 Vercel 업로드에서 제외합니다.

- `.env`, `.env.*` 단, 공유용 빈 템플릿인 `.env.example`만 추적합니다.
- `.firebaserc` 단, `.firebaserc.example`만 추적합니다.
- `.vercel/`, `.firebase/`, `.runtimeconfig.json`
- Firebase 서비스 계정 JSON, `*-firebase-adminsdk-*.json`, `*credentials*.json`, `*secret*.json`
- 개인 키와 인증서 파일: `*.pem`, `*.p12`, `*.pfx`, `*.key`, `*.crt`, `*.cert`
- 패키지 매니저 인증 파일: `.npmrc`, `.yarnrc`, `.pnpmrc`

실수로 실제 비밀값을 커밋했다면 단순 삭제만으로는 충분하지 않습니다. 해당 키를 Firebase/Vercel/Google Cloud에서 즉시 폐기 또는 재발급하고, 필요한 경우 git 히스토리 정리 절차를 별도로 진행하세요. CI는 `npm run security:gitignore-guard`로 민감 파일 패턴이 추적되는지 확인합니다.

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
