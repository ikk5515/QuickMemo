# AGENTS.md

## 프로젝트 개요

QuickMemo는 Firebase와 Vercel 기반의 실시간 암호화 메모·일정관리 웹앱이다. React 19, Vite, TypeScript, Firebase Auth, Firestore, Firebase Storage Rules, Vercel Serverless API, Vercel Cron, TipTap, Web Crypto API, dnd-kit을 사용한다.

주요 라우트는 `/setup`, `/login`, `/home`, `/app`, `/schedule`, `/admin`, `/share/:shareId`이다. 노트, 일정, 반복 업무의 민감 데이터는 클라이언트 암호화 흐름을 유지해야 한다.

## 절대 커밋 금지 파일

다음 파일과 값은 만들거나 커밋하지 않는다.

- `.env`, `.env.*` (`.env.example`만 예외)
- `.firebaserc` (`.firebaserc.example`만 예외)
- `.vercel/`, `.firebase/`, `.runtimeconfig.json`
- Firebase 서비스 계정 JSON, `*-firebase-adminsdk-*.json`, `*credentials*.json`, `*secret*.json`
- private key 또는 인증서: `*.pem`, `*.p12`, `*.pfx`, `*.key`, `*.crt`, `*.cert`
- package manager auth 파일: `.npmrc`, `.yarnrc`, `.pnpmrc`
- Vercel, Firebase, GitHub token 또는 실제 secret 값

## 보안 원칙

- CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy를 약화하지 않는다.
- `dangerouslySetInnerHTML`, TipTap HTML, public share HTML, attachment preview HTML은 sanitize와 허용 scheme 검증을 유지한다.
- 링크는 `http:`와 `https:`만 허용하고 외부 링크에는 `rel="noopener noreferrer"`를 유지한다.
- 관리자 UI 표시는 보조 수단이다. 관리자 API와 Firestore Rules에서 권한을 다시 검증해야 한다.
- public share는 만료, 비밀번호, content key, owner 검증을 우회할 수 없어야 한다.
- localStorage/sessionStorage에 민감 키나 복호화 가능한 비밀을 저장하지 않는다.
- Firestore Rules와 Storage Rules의 owner-only, shared participant, public share, inactive user, admin-only 검증을 약화하지 않는다.
- 테스트를 통과시키기 위해 보안 테스트, rules 테스트, guard 스크립트를 삭제하거나 느슨하게 만들지 않는다.

## 테스트 명령

변경 후 가능한 한 아래 명령을 모두 실행한다.

```bash
npm run security:functions-guard
npm run security:gitignore-guard
npm run lint
npm run typecheck
npm test
npm run test:rules
npm run build
npm audit
```

`npm run test:rules`는 Firebase Firestore/Storage Emulator와 Java Runtime이 필요하다. 환경 문제로 실행할 수 없으면 실패 원인과 필요한 조치를 남기고 임의로 통과 처리하지 않는다.

## UI/UX 원칙

- 기존 디자인 시스템을 갈아엎지 말고 색상, spacing, typography, focus, hover, disabled 상태의 일관성을 높인다.
- 한국어 UI 문구는 짧고 자연스럽게 쓴다.
- icon-only button에는 `aria-label`을 둔다.
- dialog, modal, tab, form, list, status message에는 적절한 label과 aria 속성을 사용한다.
- 키보드 탐색과 `focus-visible`을 보존한다.
- 모바일에서 topbar, drawer, modal, editor toolbar, schedule matrix가 가로 스크롤 없이 동작해야 한다.
- 색상만으로 상태를 전달하지 않는다.
- 과한 motion은 피하고 필요한 경우 `prefers-reduced-motion`을 고려한다.

## Firebase/Vercel 배포 주의사항

- `master` push는 모든 로컬 검증이 끝난 뒤에만 진행한다.
- Vercel production 배포는 CI가 성공한 `master` push에 대해서만 실행되도록 유지한다.
- GitHub Actions secret 이름(`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`)을 임의로 바꾸지 않는다.
- Firebase Rules, Storage Rules, indexes 변경은 테스트와 문서에 반영한다.
- Vercel API route와 SPA rewrite가 충돌하지 않게 한다.
- Vercel/Firebase/GitHub secret 값은 로그, README, 테스트 snapshot, 커밋 메시지에 남기지 않는다.

## Review Guidelines

- PII와 secret logging이 없는지 먼저 확인한다.
- XSS, authz, Firestore Rules, Storage Rules, public share, Vercel API route를 우선 검토한다.
- CSP 약화, sanitizer 우회, public share 권한 우회, inactive user 접근 허용은 release blocker로 본다.
- 테스트 약화나 보안 guard 우회는 허용하지 않는다.
- dependency 추가는 필요성, bundle 영향, 보안 영향을 설명해야 한다.
- 대용량 첨부, preview, object URL, subscription cleanup은 메모리 누수와 권한 누락 관점에서 검토한다.
