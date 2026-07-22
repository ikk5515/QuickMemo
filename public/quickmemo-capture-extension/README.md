# QuickMemo 자료 캡처 확장 프로그램

현재 탭의 제목, `http(s)` URL, 사용자가 선택한 텍스트와 `article`/`main` 안의 구조화된 텍스트 블록만 QuickMemo 자료실로 전달하는 Chrome Manifest V3 확장 프로그램입니다. 원본 HTML, 스타일, 이미지, 쿠키 또는 로그인 정보는 수집하지 않습니다.

## 빌드와 설치

이 폴더는 origin placeholder가 포함된 원본 템플릿이므로 그대로 설치하면 안 됩니다. `npm run build`는 현재 운영 origin에 맞춘 설치용 결과물을 `dist/quickmemo-capture-extension`에 함께 생성합니다. 운영 도메인이 바뀌면 빌드 스크립트의 origin도 함께 변경해야 합니다.

```bash
npm run build
```

다른 origin용 결과물은 `node scripts/build-library-extension.mjs --origin https://quickmemo.example.com`으로 별도 생성할 수 있습니다. 결과물은 `dist/quickmemo-capture-extension` 폴더와 `dist/quickmemo-capture-extension.zip`에 만들어집니다. ZIP을 풀고 Chrome의 `chrome://extensions`에서 개발자 모드를 켠 뒤, 풀린 폴더를 “압축해제된 확장 프로그램을 로드합니다”로 설치합니다.

운영 origin은 HTTPS만 허용합니다. `http://localhost`와 `http://127.0.0.1`은 로컬 개발 빌드에서만 허용됩니다. 운영 도메인이 바뀌면 새 origin으로 다시 빌드하고 확장 프로그램을 다시 로드해야 합니다.

## 최소 권한

| 권한 | 사용 목적 |
| --- | --- |
| `activeTab` | 사용자가 확장 버튼을 누른 현재 탭에만 일회성 접근 |
| `alarms` | 2분 뒤 서비스 워커가 멈춰 있어도 임시 캡처를 삭제 |
| `scripting` | 버튼 클릭 시 `capture.js`를 한 번 실행 |
| `storage` | 캡처 본문을 2분 동안 `storage.session`에 임시 보관 |

`host_permissions`, 상시 `content_scripts`, `tabs` 권한은 사용하지 않습니다. 시크릿 창과 `chrome://` 같은 제한 페이지에서는 캡처하지 않습니다.

## 본문이 URL에 남지 않는 핸드오프

확장 프로그램은 캡처 본문을 URL fragment, query string, 서버 로그 또는 웹 저장소에 넣지 않습니다. 핸드오프 순서는 다음과 같습니다.

1. `capture.js`가 텍스트 payload를 만들고 서비스 워커가 다시 크기와 schema를 검증합니다.
2. 서비스 워커가 256비트 임의 nonce로 `chrome.storage.session`에 payload를 저장하고 2분 뒤 삭제하는 일회성 alarm을 등록합니다.
3. `/library#capture=<nonce>&extension=<extension-id>`를 엽니다. fragment에는 nonce와 확장 프로그램 ID만 있으며 본문은 없습니다.
4. `/library`가 확장 프로그램에 외부 메시지를 보내 nonce를 한 번 소비합니다.
5. 서비스 워커는 빌드 시 고정한 정확한 origin과 `/library` 경로를 확인하고, session 항목을 먼저 삭제한 뒤 payload를 반환합니다.
6. 웹앱은 응답을 다시 엄격히 검증하고 화면에서 fragment를 제거한 뒤 기존 자료실 암호화 저장 흐름으로 넘깁니다.

웹 페이지는 확장 프로그램의 `storage.session`을 직접 읽을 수 없습니다. 따라서 `/library` 소비자는 아래 계약을 구현해야 합니다. `parseLibraryCaptureHandoffFragment`와 `normalizeLibraryCaptureExtensionResponse`는 `src/lib/libraryCapture.ts`에 있습니다.

```ts
const handoff = parseLibraryCaptureHandoffFragment(window.location.hash);
if (handoff) {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  const response = await new Promise<unknown>((resolve, reject) => {
    window.chrome.runtime.sendMessage(
      handoff.extensionId,
      { type: "quickmemo.consumeCapture", nonce: handoff.nonce },
      (value: unknown) => window.chrome.runtime.lastError ? reject(new Error("캡처 연결 실패")) : resolve(value)
    );
  });

  const payload = normalizeLibraryCaptureExtensionResponse(response);
  // 사용자에게 미리 보여준 후 기존 client-side 암호화 저장 경로로 전달합니다.
}
```

동시에 같은 nonce가 요청되면 한 요청만 성공합니다. 만료, 브라우저 재시작, 확장 서비스 워커 오류가 있으면 다시 캡처해야 합니다. `storage.session`의 평문 payload는 일회성 alarm으로 2분 뒤 삭제되고, 정상 소비 시 alarm과 함께 즉시 삭제됩니다.

## 데이터 및 보안 경계

- 제목은 300자, URL은 4,096자, 선택 텍스트는 10만 자, 본문은 최대 400개 블록/35만 자, 전체 JSON은 UTF-8 기준 512KiB로 제한합니다.
- URL fragment와 인증 정보로 보이는 query parameter를 제거합니다.
- private key, OAuth token, Bearer token, JWT 형태가 감지된 텍스트는 캡처하지 않으며 서비스 워커 검증에서도 거부합니다.
- raw HTML을 읽거나 보관하지 않습니다. `textContent`를 정규화한 `heading`, `paragraph`, `quote`, `list-item`, `code` 블록만 전달합니다.
- 확장 프로그램에는 Firebase/Vercel 자격 증명이나 QuickMemo 로그인 토큰을 넣지 않으며 Firestore에 직접 쓰지 않습니다.
- 저장 시에는 웹앱의 로그인 사용자, 활성 사용자, 소유자 확인과 client-side 암호화 규칙을 그대로 거쳐야 합니다.

## 알려진 제한

- 읽을 본문은 `article`을 우선하고 없으면 `main`을 사용합니다. 이 영역이 없는 페이지에서는 선택 텍스트와 제목/URL만 전달될 수 있습니다.
- 로그인 벽, 동적 로딩 전 상태, 캔버스에 그린 글자, 이미지 속 문자와 스캔 PDF는 자동 캡처하지 않습니다.
- PDF 본문 추출은 웹앱의 별도 `libraryPdfText` 경로가 담당하며, 이 확장 프로그램은 PDF 파일이나 바이너리를 저장하지 않습니다.
