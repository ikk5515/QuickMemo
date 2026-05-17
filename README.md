# QuickMemo

Firebase 기반의 실시간 암호화 메모 웹앱입니다.

## 주요 기능

- 첫 관리자 생성 화면(`/setup`)
- 원형 사용자 버튼 + 숫자 키 빠른 로그인(`/login`)
- 관리자 전용 사용자 생성, 권한, 색상, 원 안 글자, 순서, 비밀번호 초기화(`/admin`)
- 개인 노트와 선택 사용자 공유 노트(`/app`)
- Firestore 실시간 구독 기반 동기화
- Web Crypto API 기반 클라이언트 노트 암호화
- Firebase Auth, Firestore Rules, Cloud Functions 기반 권한 제어

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
6. Functions를 배포하려면 Blaze 요금제가 필요할 수 있습니다.
7. `.firebaserc.example`을 `.firebaserc`로 복사하고 프로젝트 ID를 넣습니다.

```bash
cp .firebaserc.example .firebaserc
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions,hosting
```

이 앱은 `src/lib/firebase.ts`에서 `.env.local` 값을 읽어 Firebase 앱, Auth, Firestore, Functions를 초기화합니다. Firestore 컬렉션은 앱 사용 중 Cloud Functions와 클라이언트가 자동으로 생성합니다.

### Firebase App Check

운영 배포 전에는 Firebase Console > App Check에서 웹 앱을 등록하고 reCAPTCHA Enterprise site key를 발급한 뒤 아래 값을 설정하세요.

```bash
VITE_RECAPTCHA_ENTERPRISE_SITE_KEY=...
```

값이 있으면 앱이 App Check 토큰 자동 갱신을 켭니다. 처음에는 Firebase Console에서 모니터링 모드로 트래픽을 확인한 뒤 Firestore/Functions enforcement를 켜는 흐름을 권장합니다.

## Firebase 배포 준비

```bash
cp .firebaserc.example .firebaserc
npm run build
npx firebase-tools deploy
```

첫 관리자 생성과 사용자 관리는 Cloud Functions에서 처리됩니다. 전역 Firebase CLI가 없어도 `npx firebase-tools`로 실행할 수 있습니다.

## Vercel 배포 준비

Vite SPA 라우팅을 위해 `vercel.json`에 모든 경로를 `/index.html`로 보내는 rewrite를 추가했습니다. Vercel 프로젝트 설정의 Environment Variables에 `.env.local`과 같은 `VITE_...` 값을 Production/Preview 환경별로 넣으면 됩니다.

Firebase Hosting을 쓰지 않고 Vercel에 프론트엔드를 올려도 됩니다. 단, Cloud Functions와 Firestore Rules는 Firebase에 별도로 배포되어 있어야 합니다.

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
