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
5. Build > Authentication > Sign-in method에서 Email/Password를 활성화합니다.
6. `.firebaserc.example`을 `.firebaserc`로 복사하고 프로젝트 ID를 넣습니다.

```bash
cp .firebaserc.example .firebaserc
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

이 앱은 `src/lib/firebase.ts`에서 `.env.local` 값을 읽어 Firebase 앱, Auth, Firestore를 초기화합니다. Firestore 컬렉션은 앱 사용 중 클라이언트와 Firestore Rules 검증으로 생성됩니다.

Functions 없이 동작하도록 구성되어 있으므로 Blaze 요금제가 없어도 Firestore Rules/Indexes 배포와 Vercel 프론트엔드 배포로 사용할 수 있습니다. 단, Firebase Auth 제한 때문에 관리자가 다른 사용자의 비밀번호를 강제로 변경하는 기능은 제공하지 않습니다.

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
