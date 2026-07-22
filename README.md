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
- `/schedule`: 할 일, 달력, 매트릭스와 완료 내역을 관리합니다.
- `/schedule/recurring`: 반복 업무, 날짜별 체크인과 월간 통계를 관리합니다.
- 노트 편집기는 표, 체크리스트, 이미지, PDF/DOCX/HWP 미리보기, 글자 크기·색상 서식, 기본 줄간격, 선택 영역 유지, 표 안 커서 안정화를 지원합니다.
- 설정에서 기본 시작 화면과 일정관리 기본 탭을 저장할 수 있습니다.
- Firebase Auth와 Firestore Rules로 활성 사용자와 소유자 중심 권한을 검증합니다.

### 사용자별 기능 권한

- 관리자는 사용자 생성 또는 관리자 탭의 사용자 카드에서 `노트`, `자료실`, `일정관리` 사용 권한을 각각 부여할 수 있습니다. 관리자 계정은 운영 중 잠기지 않도록 세 기능을 항상 사용할 수 있습니다.
- 권한 정보는 비공개 `users/{uid}.featureAccess`에만 저장하며 로그인 전 공개 목록인 `publicLoginRoster`에는 노출하지 않습니다. 이 필드가 없는 기존 사용자는 하위 호환을 위해 세 기능을 모두 사용할 수 있습니다.
- 메뉴 숨김뿐 아니라 직접 URL, Firestore Rules, Firebase Storage Rules, Google Calendar 서버 API, Vercel Blob 첨부파일 API에서 같은 권한을 다시 확인합니다. 잘못된 형태의 권한 문서는 허용하지 않습니다.
- 권한 해제는 노트, 자료, 일정 또는 Google 연결을 삭제하지 않습니다. 다시 허용하면 기존 데이터가 복원됩니다. 노트 권한 없이 자료실만 허용된 사용자는 저장한 링크와 클립을 계속 사용할 수 있지만 노트에서 가져오는 첨부파일은 표시하지 않습니다.

### 일정관리

- `할 일`: 오늘, 내일, 다음 7일, 이후, 날짜 없음, 최근 완료 그룹으로 업무를 관리합니다. 각 그룹 안에서는 가장 임박한 일정이 먼저 보이고, 기간이 지난 활성 일정은 날짜가 빨간색으로 표시됩니다. 업무별 진행률은 얇은 막대로 표시됩니다.
- `달력`: 월간 달력에서 일정 범위와 한국 법정공휴일, 대체공휴일, 2026년 지방선거 같은 보완 공휴일을 함께 확인합니다.
- `매트릭스`: `오늘까지 해야 할 일`, `1순위 업무`, `2순위 업무`, `업무 목록`, `대기 업무` 5개 섹션으로 업무를 관리합니다. 각 섹션은 같은 비율을 유지하고, 많은 항목은 내부 스크롤로 처리합니다.
- `매트릭스` Drag & Drop: 섹션 간 이동 시 도착 섹션에 맞게 중요/긴급 값이 자동 조정됩니다. 오늘 이전이거나 오늘을 포함하는 일정은 `오늘까지 해야 할 일`로 분류되고, 날짜 범위가 오늘을 포함하면 기존 범위를 유지합니다.
- `매트릭스` 날짜 그룹: `1순위 업무`, `2순위 업무`, `업무 목록`, `대기 업무`는 `다음 3일`, `그 이후`, `날짜 없음` 접힘 그룹을 제공합니다.
- `매트릭스` 정렬: 동일한 `startDate`를 가진 활성 일정끼리만 수동 순서 변경을 저장합니다.
- `반복 업무`: 독립 페이지에서 매일 반복되는 업무·습관을 `오전`, `오후`, `기타`로 나누어 관리합니다. 프리셋 아이콘, 날짜별 원형 완료율, 체크인 버튼, 총 체크인 수, 월별 체크인 비율, 연속 기록, 월간 출석 달력을 제공합니다.
- `반복 업무` 상세: 업무별 색상/아이콘/구분을 수정할 수 있고, 더블클릭으로 상세를 열어 설명, 매일 초기화되는 체크리스트, 진행률을 관리합니다.
- `반복 업무` Drag & Drop: 업무 행을 끌어서 오전/오후/기타를 바꾸거나 같은 구분 안에서 순서를 조정할 수 있습니다.
- `완료`: 완료된 일정을 기간, 날짜, 우선순위, 내용 기준으로 조회합니다.

### 보안 설계

- 노트 본문, 일정 제목/상세, 반복 업무 제목/상세는 클라이언트에서 암호화된 뒤 Firestore에 저장됩니다.
- 반복 체크인은 통계와 일별 상태 복원에 필요한 owner-only 메타데이터(`ownerUid`, `habitId`, `date`, `completed`, `progressPercent`, `checkedItemIds`, `checkedAt`)만 저장합니다.
- 반복 업무 아이콘은 앱 내부 enum 프리셋만 사용하며 외부 이미지 URL이나 업로드 권한을 만들지 않습니다.
- 관리자 사용자 삭제 API는 대상 사용자를 먼저 비활성화한 뒤 노트, 공유, 첨부, 일정, 반복 업무와 체크인을 정리합니다.
- GitHub Actions 운영 배포는 trusted `push` 기반 CI 완료만 Vercel production 배포로 이어지도록 보호합니다.
- CI는 민감 파일 추적 여부와 실제 비밀값 형태의 env assignment를 검사합니다.
- Vercel 응답에는 CSP, HSTS, frame 차단, MIME sniffing 차단, Permissions-Policy 같은 기본 보안 헤더를 설정합니다.

### Google Calendar 단방향 동기화

- QuickMemo 계정마다 Google 계정 하나를 별도로 연결합니다. Google 비밀번호는 QuickMemo에 입력하거나 저장하지 않고 Google 공식 OAuth 화면에서만 인증합니다.
- 날짜가 있는 일반 일정의 생성·제목/날짜/시간 수정·삭제를 기본 캘린더에 한 방향으로 반영합니다. 반복 업무는 이 동기화 대상이 아닙니다.
- 연결 전에 만들어 둔 날짜 있는 일정은 연결 팝업에서 사용자가 `기존 일정도 한 번 동기화`를 직접 선택한 경우에만 반영합니다. 과거나 완료된 일정도 포함하며, QuickMemo 사용자 ID와 일정 ID로 만든 고정 Google 이벤트 ID를 재사용해 반복 실행 시 중복 등록을 방지합니다.
- Google에는 일정 제목·날짜·시간만 전송하고, 상세 내용과 체크리스트는 전송하지 않습니다. 이벤트는 `private`로 생성하며 시작 시간만 있으면 종료 시간을 30분 뒤로 설정합니다.
- refresh token은 Vercel 서버에서만 AES-256-GCM으로 암호화해 저장합니다. 브라우저에는 짧은 수명의 access token만 메모리로 전달하며 localStorage/sessionStorage/Firestore 클라이언트 문서에는 토큰을 저장하지 않습니다.
- 연결 해제 시 해당 QuickMemo 계정의 암호화된 자격 증명만 삭제합니다. Google의 프로젝트 단위 권한 철회는 같은 Google 계정을 연결한 다른 QuickMemo 계정까지 끊을 수 있어 자동 실행하지 않습니다. Google 권한 자체를 완전히 철회하면 같은 Google 계정을 사용하는 QuickMemo 연결이 모두 다시 인증을 요구할 수 있습니다.
- Google Calendar 실패가 QuickMemo의 생성·수정·날짜 제거를 롤백하지 않습니다. 성공한 일정 수정본은 내용이 없는 owner-only 동기화 영수증으로 기록하며, 브라우저 종료나 교차 탭 경합으로 영수증이 남지 않은 연결 이후 변경은 다음 일정 화면 진입 때 자동 복구합니다. 빠른 재시도가 끝난 뒤에도 저빈도 복구를 유지하고 온라인·화면 복귀 시 즉시 다시 확인하며, 같은 수정본은 Google에서 다시 PATCH하지 않습니다.
- 전체 일정 삭제는 Google 이벤트가 남는 것을 막기 위해 Google 삭제가 성공하거나 이미 없는 것을 확인한 뒤 QuickMemo 문서와 동기화 영수증을 한 트랜잭션에서 삭제합니다. 원격 선삭제부터 로컬 삭제·원격 재확인·tombstone 정리까지 계정 교체를 막는 서버 workflow lease로 보호하고, 결과가 불확실하면 tombstone을 유지합니다. 중단된 삭제는 연결 세대가 같은 tombstone만 자동 복구해 새로 연결한 다른 Google 계정에 이전 삭제를 적용하지 않습니다.

운영 활성화 절차:

1. Google Cloud Console에서 Google Calendar API를 활성화하고 OAuth 동의 화면을 구성합니다. 앱은 기본 캘린더의 이벤트만 관리하는 최소 권한 `calendar.events.owned`를 요청합니다.
2. 개발과 운영은 Google Cloud 프로젝트와 OAuth 클라이언트를 분리합니다. `웹 애플리케이션` OAuth 클라이언트의 승인된 리디렉션 URI를 정확히 `https://your-domain.example/api/google-calendar-auth`로 등록합니다. OAuth를 시작하는 실제 접속 origin도 이 URI의 origin과 정확히 같아야 하므로, Vercel 미리보기 도메인에서 운영 OAuth를 시작하지 않습니다. 로컬 검증은 개발용 클라이언트에 localhost의 같은 경로를 별도로 등록합니다.
3. External 앱을 `Testing`으로 두면 등록한 테스트 사용자만 접속할 수 있고 Calendar 권한의 refresh token이 7일 후 만료될 수 있습니다. 실사용 전에 앱 홈페이지·개인정보처리방침·지원 연락처를 준비하고 `In production`으로 게시하며, Google이 요구하는 경우 민감한 권한 검증까지 완료합니다. [Google OAuth 운영 준비 안내](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)와 [토큰 만료 안내](https://developers.google.com/identity/protocols/oauth2#expiration)를 기준으로 확인합니다.
4. Vercel Production 환경에 아래 서버 전용 변수를 설정합니다. 이름 앞에 `VITE_`를 붙이면 브라우저 번들에 노출될 수 있으므로 사용하지 않습니다.

```bash
GOOGLE_CALENDAR_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CALENDAR_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_CALENDAR_REDIRECT_URI=https://your-domain.example/api/google-calendar-auth
GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY=your-base64-encoded-32-byte-random-key
GOOGLE_CALENDAR_ALLOWED_ORIGINS=https://your-domain.example
```

암호화 키는 예를 들어 `openssl rand -base64 32`로 새로 생성하고 Vercel 환경 변수에만 보관합니다. 기존 관리 API와 마찬가지로 `FIREBASE_CLEANUP_*` 서비스 계정 설정도 필요합니다.

5. `googleCalendarConnections`, `googleCalendarConnectionEpochs`, `googleCalendarOAuthStates`는 서버 전용이며 클라이언트 읽기·쓰기를 전면 차단합니다. `googleCalendarTaskSyncReceipts`와 `googleCalendarTaskTombstones`에는 토큰이나 일정 내용 없이 소유자·일정 ID·연결 세대·수정 시각만 저장하고, 현재 연결 및 정확한 일정 수정본에 한해서만 owner write를 허용합니다. 10분이 지난 OAuth state는 기존 Vercel 정리 작업이 매일 제한된 배치로 삭제하므로 Firebase 유료 TTL 기능에 의존하지 않습니다. 이 정리 쿼리에 필요한 Firestore Rules와 Indexes를 먼저 배포한 뒤 Vercel Production을 배포합니다.

```bash
npx firebase-tools deploy --only firestore:rules,firestore:indexes
# Firebase Storage를 설정한 프로젝트에서만 실행합니다.
npx firebase-tools deploy --only storage
```

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
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage
```

이 앱은 `src/lib/firebase.ts`에서 `.env.local` 값을 읽어 Firebase 앱, Auth, Firestore를 초기화합니다. Firestore 컬렉션은 앱 사용 중 클라이언트와 Firestore Rules 검증으로 생성됩니다.

Firebase Cloud Functions 없이 동작하도록 구성되어 있으므로 Blaze 요금제가 없어도 Firestore Rules·인덱스와 Vercel 앱을 배포할 수 있습니다. 관리자가 다른 사용자의 비밀번호를 강제로 변경하려면 Admin SDK가 실행되는 별도 신뢰 서버가 필요합니다.

### 임시 데이터 만료 cleanup

임시 공유 문서·공유 첨부 파일·Google Calendar OAuth 상태는 Firestore Rules의 즉시 만료 차단과 Vercel Cron cleanup으로 정리합니다.

- Vercel Cron cleanup: Firebase billing 없이도 `/api/cleanup-public-shares`가 하루 한 번 서비스 계정 OAuth로 만료된 공유와 Google Calendar 인증 상태, 중단된 첨부 예약, 영구 삭제 대기 노트의 첨부·이력·사용자 상태를 제한된 배치로 정리합니다. 삭제가 중단되어도 큐와 tombstone을 남겨 다음 실행에서 안전하게 재시도하며, 소유자가 다시 로그인하거나 NotesPage를 열지 않아도 동작합니다.
- Firestore 만료 인덱스: `publicNoteShares.expiresAt`과 첨부 만료 필드는 cleanup 조회용 인덱스만 유지합니다. TTL 선삭제는 Blob quota·object·하위 문서의 원자적 정리를 건너뛸 수 있어 사용하지 않습니다.
- 공개 첨부 개인정보: 신규·재동기화된 공유의 실제 파일명은 content key로 암호화하고, 익명 문서에는 일반 이름과 확장자·크기·MIME만 둡니다. 기존 공유 첨부는 평문 파일명이 다시 노출되지 않도록 공개 목록에서 숨기며, 소유자가 노트 화면을 열어 자동 마이그레이션하거나 새 링크를 만들면 다시 표시됩니다.

Vercel 운영 환경에는 아래 값을 설정합니다. `FIREBASE_CLEANUP_SERVICE_ACCOUNT_JSON`에는 서비스 계정 JSON 전체를 넣거나, `FIREBASE_CLEANUP_CLIENT_EMAIL`과 `FIREBASE_CLEANUP_PRIVATE_KEY`를 나누어 넣을 수 있습니다. 서비스 계정 JSON을 저장소 파일로 두지 말고 Vercel Environment Variable에만 넣으세요.

```bash
CRON_SECRET=at-least-16-random-characters
FIREBASE_CLEANUP_PROJECT_ID=your-firebase-project-id
FIREBASE_CLEANUP_CLIENT_EMAIL=cleanup-account@your-firebase-project-id.iam.gserviceaccount.com
FIREBASE_CLEANUP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
PUBLIC_SHARE_CLEANUP_BATCH_SIZE=50
PUBLIC_SHARE_CLEANUP_MAX_DELETES=1000
```

Vercel Hobby 플랜은 Cron이 하루 한 번 실행되므로 `vercel.json`의 schedule도 일 1회로 맞춰져 있습니다. 같은 설정에서 Fluid Compute를 명시적으로 활성화하되 함수 실행시간을 더 짧게 덮어쓰지 않아 Vercel의 플랜 기본 제한을 사용합니다. cleanup 함수는 `publicShareCleanupQueue.expiresAt <= now`인 queue 문서를 조회해 해당 공유 첨부 파일, 원본 공유 문서, cleanup queue를 함께 삭제합니다. 서비스 계정에는 Firestore 문서 조회/삭제와 Firebase Auth 사용자 조회/삭제에 필요한 최소 IAM 권한만 부여하세요.

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

전역 Firebase CLI가 없어도 `npx firebase-tools`로 실행할 수 있습니다. Vercel을 프론트엔드로 사용할 예정이면 Firebase Hosting 배포는 생략하고 Firestore Rules/Indexes를 배포합니다. Firebase Storage를 실제로 활성화한 프로젝트에서만 Storage Rules를 추가로 배포합니다.

Rules나 Indexes와 프론트엔드가 함께 바뀌는 릴리스는 Firebase Rules/Indexes를 먼저 배포하고 새 복합 인덱스가 `Ready` 상태인지 확인한 뒤 Vercel 프론트엔드를 배포해야 합니다. `.github/workflows/vercel-production.yml`은 Vercel만 배포하므로 이 순서를 자동으로 대신하지 않습니다.

Firestore Rules에는 다음 주요 컬렉션의 owner-only 접근과 데이터 형식 검증이 포함되어 있습니다.

- `users`, `userPreferences`, `userKeys`, `publicLoginRoster`
- `notes`, `noteFolders`, `activeNotes`, 노트 첨부/히스토리/상태 문서
- `publicNoteShares`, `publicShareCleanupQueue`
- `scheduleTasks`, `googleCalendarTaskSyncReceipts`, `googleCalendarTaskTombstones`
- `recurringHabits`, `recurringHabitCheckIns`

각 기능 컬렉션은 활성 사용자·소유자 검증에 더해 `users/{uid}.featureAccess`를 확인합니다. 노트 권한은 공개 공유 원본과 Storage/Blob 첨부파일에도 적용되고, 일정관리 권한은 Google Calendar 동기화 영수증과 삭제 tombstone에도 적용됩니다.

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
