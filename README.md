# QuickMemo

Firebase와 Vercel 기반의 실시간 암호화 메모·일정관리 웹앱입니다. 개인/공유 노트, 일정 매트릭스, 반복 업무·습관, 관리자 사용자 관리를 하나의 업무 화면에서 다룹니다.

## 기술 구성

- React 19, Vite, TypeScript
- Firebase Auth, Firestore, Firestore Rules, Firebase Storage Rules, Firebase Emulator
- Vercel Static Hosting, Vercel Serverless API, Vercel Cron
- TipTap 기반 리치 텍스트 편집기
- Web Crypto API 기반 클라이언트 암호화
- `@dnd-kit` 기반 일정/반복 업무 Drag & Drop
- Intl dangi calendar 기반 한국 공휴일 계산과 보완 공휴일 매핑

## 주요 기능

- `/setup`: 첫 관리자 계정을 생성합니다.
- `/login`: 원형 사용자 버튼으로 빠르게 사용자 계정을 선택하고 로그인합니다.
- `/admin`: 관리자가 사용자 생성, 권한, 색상, 원 안 글자, 표시 순서, 사용자 삭제를 관리합니다.
- `/app`: 개인 노트와 선택 사용자 공유 노트를 작성하고 실시간으로 동기화합니다.
- 노트 편집기는 표, 체크리스트, 이미지, PDF/DOCX/HWP 미리보기, 글자 크기·색상 서식, 기본 줄간격, 선택 영역 유지, 표 안 커서 안정화를 지원합니다.
- 설정에서 기본 시작 화면과 일정관리 기본 탭을 저장할 수 있습니다.
- Firebase Auth와 Firestore Rules로 활성 사용자와 소유자 중심 권한을 검증합니다.

### 일정관리

- `할 일`: 오늘, 내일, 다음 7일, 이후, 날짜 없음, 최근 완료 그룹으로 업무를 관리합니다. 각 그룹 안에서는 가장 임박한 일정이 먼저 보이고, 기간이 지난 활성 일정은 날짜가 빨간색으로 표시됩니다. 업무별 진행률은 얇은 막대로 표시됩니다.
- `달력`: 월간 달력에서 일정 범위와 한국 법정공휴일, 대체공휴일, 2026년 지방선거 같은 보완 공휴일을 함께 확인합니다.
- `매트릭스`: `오늘까지 해야 할 일`, `1순위 업무`, `2순위 업무`, `업무 목록`, `대기 업무` 5개 섹션으로 업무를 관리합니다. 각 섹션은 같은 비율을 유지하고, 많은 항목은 내부 스크롤로 처리합니다.
- `매트릭스` Drag & Drop: 섹션 간 이동 시 도착 섹션에 맞게 중요/긴급 값이 자동 조정됩니다. 오늘 이전이거나 오늘을 포함하는 일정은 `오늘까지 해야 할 일`로 분류되고, 날짜 범위가 오늘을 포함하면 기존 범위를 유지합니다.
- `매트릭스` 날짜 그룹: `1순위 업무`, `2순위 업무`, `업무 목록`, `대기 업무`는 `다음 3일`, `그 이후`, `날짜 없음` 접힘 그룹을 제공합니다.
- `매트릭스` 정렬: 동일한 `startDate`를 가진 활성 일정끼리만 수동 순서 변경을 저장합니다.
- `반복`: 매일 반복되는 업무·습관을 `오전`, `오후`, `기타`로 나누어 관리합니다. 프리셋 아이콘, 날짜별 원형 완료율, 체크인 버튼, 총 체크인 수, 월별 체크인 비율, 연속 기록, 월간 출석 달력을 제공합니다.
- `반복` 업무: 업무별 색상/아이콘/구분을 수정할 수 있고, 더블클릭으로 상세를 열어 설명, 매일 초기화되는 체크리스트, 진행률을 관리합니다.
- `반복` Drag & Drop: 업무 행을 끌어서 오전/오후/기타를 바꾸거나 같은 구분 안에서 순서를 조정할 수 있습니다.
- `완료`: 완료된 일정을 기간, 날짜, 우선순위, 내용 기준으로 조회합니다.

### 보안 설계

- 노트 본문, 일정 제목/상세, 반복 업무 제목/상세는 클라이언트에서 암호화된 뒤 Firestore에 저장됩니다.
- 반복 체크인은 통계에 필요한 최소 메타데이터(`ownerUid`, `habitId`, `date`, `checkedAt`)만 저장합니다.
- 반복 업무 아이콘은 앱 내부 enum 프리셋만 사용하며 외부 이미지 URL이나 업로드 권한을 만들지 않습니다.
- 관리자 사용자 삭제 API는 대상 사용자를 먼저 비활성화한 뒤 노트, 공유, 첨부, 일정, 반복 업무와 체크인을 정리합니다.
- GitHub Actions 운영 배포는 trusted `push` 기반 CI 완료만 Vercel production 배포로 이어지도록 보호합니다.
- CI는 민감 파일 추적 여부와 실제 비밀값 형태의 env assignment를 검사합니다.
- Vercel 응답에는 CSP, HSTS, frame 차단, MIME sniffing 차단, Permissions-Policy 같은 기본 보안 헤더를 설정합니다.

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

Firestore/Storage Emulator는 Java Runtime이 필요합니다.

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

Firebase Cloud Functions 없이 동작하도록 구성되어 있으므로 Blaze 요금제가 없어도 Firestore Rules 배포와 Vercel 프론트엔드 배포로 사용할 수 있습니다. 단, Firestore TTL field override나 일부 관리형 인덱스 설정은 Firebase billing이 필요할 수 있고, 관리자가 다른 사용자의 비밀번호를 강제로 변경하려면 Admin SDK가 실행되는 신뢰할 수 있는 서버가 필요합니다.

### 임시 공유 만료 cleanup

임시 공유 문서와 공유 첨부 파일은 Vercel Cron cleanup과 Firestore TTL 설정으로 정리합니다.

- Vercel Cron cleanup: Firebase billing 없이도 `/api/cleanup-public-shares`가 하루 한 번 서비스 계정 OAuth로 만료된 공유와 공유 첨부 파일을 삭제합니다. 이 경로는 소유자가 다시 로그인하거나 NotesPage를 열지 않아도 동작합니다.
- Firestore TTL: `firestore.indexes.json`에는 `attachments.expiresAt`, `publicNoteShares.expiresAt` TTL field override가 포함되어 있습니다. 프로젝트 요금제나 권한 때문에 TTL 배포가 실패하면 Firestore Rules/Indexes 배포 로그를 확인하고, 필요한 경우 Firebase Console에서 TTL을 별도로 켜거나 Rules만 먼저 배포하세요.

Vercel 운영 환경에는 아래 값을 설정합니다. `FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON`에는 서비스 계정 JSON 전체를 넣거나, `FIREBASE_CLEANUP_CLIENT_EMAIL`과 `FIREBASE_CLEANUP_PRIVATE_KEY`를 나누어 넣을 수 있습니다. 서비스 계정 JSON을 저장소 파일로 두지 말고 Vercel Environment Variable에만 넣으세요.

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

관리자 화면의 사용자 삭제는 브라우저에서 바로 Firebase Auth 사용자를 삭제하지 않고 `/api/delete-managed-user` Vercel API를 통해 처리합니다. 이 API는 현재 로그인한 관리자의 Firebase ID 토큰을 Identity Toolkit `accounts:lookup`으로 확인하고, Firestore의 `users/{uid}`에서 `isActive`와 `isAdmin`을 다시 검증한 뒤 대상 사용자를 비활성화하고 Auth 계정과 앱 문서를 삭제합니다.

이 기능도 위의 `FIREBASE_CLEANUP_*` 서비스 계정 환경 변수를 같이 사용합니다. 삭제 대상의 노트, 공유, 첨부 파일 cleanup queue, 일정, 반복 업무, 반복 체크인, 사용자 키와 공개 로그인 문서를 함께 정리합니다. Vercel Production 환경에 해당 변수가 없거나 서비스 계정에 Firebase Auth 사용자 삭제 권한이 없으면 관리자 화면에 실패로 표시됩니다.

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

Firestore Rules에는 다음 주요 컬렉션의 owner-only 접근과 데이터 형식 검증이 포함되어 있습니다.

- `users`, `userPreferences`, `userKeys`, `publicLoginRoster`
- `notes`, `noteFolders`, `activeNotes`, 노트 첨부/히스토리/상태 문서
- `publicNoteShares`, `publicShareCleanupQueue`
- `scheduleTasks`
- `recurringHabits`, `recurringHabitCheckIns`

## 민감 파일 관리

아래 파일은 로컬 또는 배포 환경별 비밀값과 프로젝트 메타데이터를 담을 수 있으므로 git과 Vercel 업로드에서 제외합니다.

- `.env`, `.env.*` 단, 공유용 빈 템플릿인 `.env.example`만 추적합니다.
- `.firebaserc` 단, `.firebaserc.example`만 추적합니다.
- `.vercel/`, `.firebase/`, `.runtimeconfig.json`
- Firebase 서비스 계정 JSON, `*-firebase-adminsdk-*.json`, `*credentials*.json`, `*secret*.json`
- 개인 키와 인증서 파일: `*.pem`, `*.p12`, `*.pfx`, `*.key`, `*.crt`, `*.cert`
- 패키지 매니저 인증 파일: `.npmrc`, `.yarnrc`, `.pnpmrc`

실수로 실제 비밀값을 커밋했다면 단순 삭제만으로는 충분하지 않습니다. 해당 키를 Firebase/Vercel/Google Cloud에서 즉시 폐기 또는 재발급하고, 필요한 경우 git 히스토리 정리 절차를 별도로 진행하세요.

CI는 `npm run security:gitignore-guard`로 민감 파일 패턴, private key block, Firebase service account 형태, Google/GitHub/Slack/AWS 토큰 패턴, 실제 값이 들어간 주요 secret env assignment를 검사합니다. 예제 파일의 빈 값과 명시적 placeholder는 허용합니다.

## Vercel 배포 준비

Vite SPA 라우팅을 위해 `vercel.json`에 모든 경로를 `/index.html`로 보내는 rewrite를 추가했습니다. Vercel 프로젝트 설정의 Environment Variables에 `.env.local`과 같은 `VITE_...` 값을 Production/Preview 환경별로 넣으면 됩니다. 운영 환경에는 cleanup과 관리자 삭제 API가 사용하는 `CRON_SECRET`, `FIREBASE_CLEANUP_*` 값도 함께 설정합니다.

Firebase Hosting을 쓰지 않고 Vercel에 프론트엔드를 올려도 됩니다. 단, Firestore Rules와 Indexes는 Firebase에 별도로 배포되어 있어야 합니다.

## GitHub 작업

CI는 `.github/workflows/ci.yml`에 추가되어 PR과 `main`/`master` push마다 다음을 실행합니다.

- lint
- typecheck
- functions-free security guard
- sensitive-file gitignore guard
- unit tests
- Firestore Rules tests
- production build

운영 Vercel 배포는 `.github/workflows/vercel-production.yml`에서 CI가 성공한 `master` push에 대해서만 실행합니다. 이 workflow는 `workflow_run.event == 'push'`, 같은 저장소의 head repository, `head_branch == 'master'` 조건을 모두 확인해 PR branch가 production deploy를 트리거하지 못하게 합니다.

자동 PR 생성을 하려면 GitHub CLI가 필요합니다.

```bash
brew install gh
gh auth login
```

설치 후 이 저장소에서 다시 요청하면 현재 변경사항을 브랜치로 커밋하고 원격에 push한 뒤 draft PR까지 열 수 있습니다.

## 검증

```bash
npm run security:functions-guard
npm run security:gitignore-guard
npm run lint
npm run typecheck
npm test
npm run test:rules
npm run build
```

`npm run test:rules`는 Firebase Firestore/Storage Emulator와 Java Runtime이 필요합니다.
