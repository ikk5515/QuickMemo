# Secure Share v2 Playwright E2E

이 테스트는 `quickmemo-share-api-test` Firebase Emulator와 로컬 Vite/API
서버만 사용한다. Production Firebase, Vercel, 실제 사용자, 실제 이메일
Provider에는 연결하지 않는다.

로컬 서버는 다음 안전장치를 적용한다.

- Firestore/Auth host를 loopback Emulator로 강제한다.
- `NODE_ENV=test`인 경우에만 API Emulator 경로를 사용한다.
- Resend 요청은 외부로 보내지 않고 메모리 inbox에서 OTP만 회수한다.
- 첨부 복사는 Vite에서만 주입하는 메모리 Blob adapter를 사용하며,
  예약·암호화 업로드·ready count·active 전환을 Emulator 문서로 검증한다.
- 테스트 시작과 종료 시 Emulator 전용 데이터를 삭제한다.
- seed/control endpoint는 loopback 요청에만 응답한다.

## 실행

Node.js, Java, Firebase Emulator 및 Playwright browser binary가 필요하다.

```bash
npx playwright install chromium webkit
npm run test:e2e
npm run test:e2e:vault
npm run test:e2e:chromium
npm run test:e2e:webkit
```

Playwright가 Firebase Auth/Firestore Emulator와 로컬 서버를 함께 시작한다.
이미 같은 포트의 로컬 Emulator가 실행 중이면 로컬에서는 재사용할 수
있지만, CI에서는 항상 새 프로세스를 요구한다.

## Project matrix

- Chromium 1280×720: 상태 변경을 포함한 Secure Share 전체 시나리오
- Chromium 390×844: dark mode, keyboard, overflow smoke
- Chromium 320×700: dark mode, keyboard, overflow smoke
- WebKit 1280×720: dark mode, keyboard, overflow smoke
- WebKit 390×844: dark mode, keyboard, overflow smoke

실패한 실행만 screenshot, trace, video를 보존한다. `test-results/`,
`playwright-report/`, `blob-report/`는 Git에서 제외된다.

`test:e2e:vault`는 기존 flag=false 서버와 분리된 4174 포트에서
`VITE_OBSIDIAN_VAULT_ENABLED=true`로 실행한다. 1280px, 390px, 320px에서
Emulator 사용자 로그인과 개인 키 복호화, Markdown 암호화 저장, 내부 링크와
태그 인덱싱, Global Graph, 모바일 drawer·44px touch target, reload 뒤 재잠금과
재복호화를 검증한다. 저장된 Firestore 문서에는 평문 Markdown이 없고 암호문과
wrapped key만 존재하는지도 인증된 Emulator 요청으로 확인한다.

## 자동화 범위

- Legacy v1 및 v2 공개 접근
- password 실패/성공
- allowed email OTP 발급, OTP 실패/성공, 비허용 이메일 동일 UI 응답
- authenticated user, anonymous 거부, `email_verified=false` 거부
- global one-time 최초 접근, 동일 세션 새로고침, 새 context 거부
- owner preview 비소비 및 owner 댓글 삭제
- download UI/API 차단, quick-copy 숨김, attachment ID 변조 차단
- comment 권한, HTML/XSS 거부, 작성자 삭제
- save-copy 권한, 첨부 없는 독립 active note, 첨부 복호화·재암호화 및
  reserved/ready/active 전환
- revoke, policy version 변경, expiration에 따른 기존 세션 무효화
- attachment preview dialog의 initial focus, focus trap, Escape, focus return
- console/page error, API 응답 secret/raw Blob URL, horizontal overflow 검사

메모리 adapter는 실제 Vercel Blob 전송 자체를 검증하지 않는다. 실제
Blob transport와 실제 이메일 전달은 각각 별도 통합 환경과 승인된
Production smoke mailbox gate에서 검증한다.
