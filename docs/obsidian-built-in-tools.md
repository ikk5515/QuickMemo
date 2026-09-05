# QuickMemo 내장 지식 도구

> 2026-09-05 변경: Base·Kanban·Canvas 생성 및 전용 편집 화면은 제거되었습니다. 아래 호환성 기록 중 해당 UI 설명은 과거 구현에 대한 기록입니다. 기존 암호화 파일의 원문 열람·내보내기와 안전한 파싱 경로만 유지합니다. 현재 사용자 기능은 [README](../README.md)를 참고하세요.

QuickMemo는 외부 Obsidian Community Plugin 바이너리를 실행하지 않는다. 아래 기능은 기존
클라이언트 E2EE Vault 안에서 동작하도록 별도로 구현한 내장 도구다. 정본과 변경 이력은 기존
암호화 `markdown-v1` 노트에 저장되며, 별도 서버·API 키·유료 서비스·새 데이터베이스가 없다.

이 문서에서 `호환`은 파일 의미와 핵심 작업 흐름을 안전하게 옮긴다는 뜻이지, Obsidian Core나
Community Plugin의 API·화면·파일 형식을 전부 복제한다는 뜻이 아니다. 권장 사용 흐름은
`빠른 입력 → 얕은 폴더와 Properties로 정리 → 링크·MOC로 연결 → 검색·백링크·Local Graph로 회수
→ Base/Dataview로 결과 작성`이다. Graph는 링크 구조를 점검하는 보조 화면이며 폴더나 검색을
대체하는 기본 탐색기가 아니다. 이 역할 구분은
[WikiDocs의 Obsidian 활용 가이드 00–11장](https://wikidocs.net/book/19675)을 검토해 적용했으며,
실제 지원 범위의 기준은 이 문서와 테스트다.

PARA, MOC, Evergreen Note는 폴더·속성·링크를 일관되게 사용하는 **권장 워크플로**다. QuickMemo가
노트를 자동으로 PARA 영역에 분류하거나, MOC를 자동 생성하거나, 노트를 Evergreen 상태로 판정하는
자동 ontology가 아니다. 사용자가 자신의 언어와 기준으로 이름·속성·링크를 선택한 결과만 정본
Markdown과 지식 연결로 남는다.

PARA의 `Archive`는 완료된 프로젝트와 계속 참고할 지식을 보관하는 일반 폴더다. 삭제된 항목을
숨겼다가 되살리는 QuickMemo `휴지통`과 같은 의미로 사용하지 않는다. 또한 Firestore E2EE 동기화와
같은 저장 계층의 File Recovery는 독립 백업이 아니다. 장기 보관에는 별도로 Vault ZIP을 내보내고,
실제 복구 가능 여부를 주기적으로 확인한다. 자동 독립 암호화 백업·보존 정책·전체 복구 훈련 UI는
아직 제공하지 않는다.

## Markdown 편집 보기

- `소스`: 정본 Markdown을 직접 편집한다.
- `라이브 프리뷰`: CodeMirror 한 화면에서 비활성 줄의 제목, 강조, inline code, Wiki/표준 링크,
  태그, 작업 체크박스, 인용문과 콜아웃 marker를 꾸며 보여 준다. 선택한 줄은 항상 편집 가능한 원문을
  드러내며 한글 IME 조합 중에는 모든 치환 장식을 잠시 해제한다. 선택과 겹치지 않는 완결된 표,
  fenced code/Mermaid/Dataview, display math, 여러 줄 callout, 이미지·embed는 sanitize된 block widget으로
  표시하고, 커서를 옮기면 원문으로 돌아간다. 깊게 섞인 중첩 문법, 브라우저별 IME/selection geometry,
  모든 modifier gesture까지 Obsidian과 pixel 단위로 같다는 뜻은 아니다.
- `읽기`: sanitize된 렌더링을 읽기 전용으로 보여 준다. 현재 ACL 범위에서
  해석된 내부 노트 링크는 지연 hover와 keyboard focus Page Preview를
  제공한다. External·unresolved·접근 불가 링크는 내용을 미리 보여 주지
  않는다. CodeMirror `라이브 프리뷰`의 해석된 내부 링크도 같은 Page Preview
  경계와 지연 동작을 사용한다.

세 보기 모두 같은 `markdown-v1` 정본을 사용하며 보기 전환이 별도 HTML 정본을 만들지 않는다.

## 링크, 연결되지 않은 언급, 검색 결과 인덱스와 MOC

- Backlinks는 실제 internal link와 제목/alias의 연결되지 않은 평문 언급을 분리해 보여 준다.
  언급은 문맥·파일·행·열을 제공하며 검색, 정렬, 파일별 접기/펼치기를 지원한다.
- 언급 탐지는 Markdown 본문만 대상으로 하고 frontmatter, fenced/inline code, 기존 링크, 외부 URL,
  대상 노트 자신, Canvas 및 다른 비-Markdown 소스는 제외한다.
- `링크 만들기`는 현재 초안에서 같은 occurrence가 여전히 같은 offset에 있는지 다시 확인한 뒤
  path-qualified Wikilink로 바꾼다. 사용자가 그 사이에 작성한 다른 내용과 초안의 `baseRevision`을
  유지하며, 위치나 대상 경로가 바뀌었으면 덮어쓰지 않고 재시도를 안내한다.
- 중복 파일명/alias, heading/block, embed, unresolved, tag, Canvas file-card, Local/Global Graph의
  고정 fixture 결과는 signed/notarized Obsidian 1.13.7 oracle과 exact compare했다. 이 비교는 캡처한
  의미 fixture의 근거이며, 모든 비표준 문법·미공개 상호작용·향후 버전까지 동일하다는 뜻은 아니다.
- 명령 팔레트의 `현재 검색 결과 인덱스 만들기`는 현재 필터 결과를 새 암호화 Markdown 노트로
  만든다. 중복 경로를 제거하고 경로순으로 정렬한 뒤 실제 상대 Markdown internal link를 기록하므로
  저장 후 Graph·Backlinks·Outgoing Links에 정상 연결로 반영된다.
- 검색 결과 인덱스는 최대 500개 링크를 포함한다. 초과 결과는 조용히 버리지 않고 노트 안의 warning
  callout과 완료 상태에 생략 개수를 표시한다. 이 기능은 추천 ontology나 자동 주제 분류가 아니라
  현재 사용자가 선택한 검색식의 명시적 materialization이다. 목적·핵심 질문·읽기 순서·대표 링크를
  자신의 언어로 선별하는 실제 MOC는 사용자가 별도 Markdown 노트로 작성한다.

## Daily Notes Calendar

- 파일 탐색기 아래 월간 달력에서 이전 달, 오늘, 다음 달로 이동한다.
- 날짜를 누르면 Daily Notes 설정에 지정한 폴더의 `YYYY-MM-DD.md`를 열고, 없으면 같은 이름으로
  만든다. 지정 폴더가 없거나 삭제되면 루트를 안전한 기본값으로 사용한다.
- Daily Notes 설정에서 고정 폴더와 Markdown 템플릿을 선택한다. 새 Daily Note에만 템플릿을
  적용하며 이미 존재하는 노트는 덮어쓰지 않는다.
- Daily Note가 있는 날짜를 점으로 표시한다.
- 주간 노트는 ISO 주차, 월간 노트는 연월을 기준으로 열거나 생성하며, 해당 기간의 Daily Note
  링크를 모아 시간축을 잃지 않게 한다.
- 새 encrypted name reservation을 다시 검사하는 동안에는 새 일/주/월 노트 생성을 잠그지만,
  이미 존재하는 일/주/월 노트는 계속 열 수 있다. 달력은 ARIA grid와 roving keyboard focus를 쓴다.
- 달력의 월과 접힘 상태는 다른 워크스페이스 배치처럼 클라이언트에서 암호화해 저장한다.
- 이 달력은 `/schedule`의 일정 달력이나 Google Calendar 동기화와 다른 기능이다. 일정 달력은
  약속·날짜 범위를 관리하고, Daily Notes Calendar는 날짜별 Markdown 기록을 연다.
- 현재 버전은 휴일 API나 Obsidian Calendar Community Plugin 전체 설정 호환을 제공하지 않는다.

## Bases와 Dataview의 역할

- Base는 Properties를 표·카드·목록으로 모아 보고, 지원하는 top-level 속성을 직접 수정하는
  작업 화면이다. 수정 결과는 별도 DB가 아니라 원본 Markdown frontmatter에 반영된다.
- Dataview는 같은 메타데이터를 안전한 선언형 쿼리로 읽어 목록·표·작업·날짜 보고서를 만든다.
  일반 결과 셀은 읽기 전용이다. `TASK`의 checkbox만 owner의 현재 `markdown-v1` 원문에서 같은
  line/text/checked 상태가 여전히 일치할 때 revision-aware 저장으로 토글할 수 있고, 그 외 결과나
  공유·삭제·충돌·경로 변경 중인 원문은 수정하지 않는다.
- 따라서 반복 운영은 Base에서 상태·담당·날짜를 고치고, 대시보드·MOC·주간 보고서는 Dataview로
  읽어 구성하는 방식을 권장한다. 둘 모두 Graph edge를 새로 만들지 않으며, 실제 Markdown
  internal link만 지식 연결로 계산한다.
- Base는 table/card/list, filter/sort/group, summary, typed date/duration/link/file/html/image/icon과
  bounded formula를 지원한다. 내부 link/file 값은 현재 ACL 안에서 해석해 원본을 열 수 있다. 임의
  JavaScript, plugin function/view, 완전한 Moment/locale/timezone, 모든 RegExp·HTML 동작은 지원하지
  않는다. 정확한 함수·상한·fail-closed 진단은
  [`obsidian-bases-compatibility.md`](./obsidian-bases-compatibility.md)를 따른다.

## Dataview 워크플로를 위한 안전 쿼리

Markdown의 `dataview` 코드 블록에서 `LIST`, `TABLE`, `TASK`, `CALENDAR`, `FROM`, `WHERE`,
`SORT`, `GROUP BY`, `LIMIT`을
사용한다. Base와 동일한 메타데이터/필터/정렬 엔진을 사용한다.

```dataview
TABLE status AS "상태", file.mtime AS "수정"
FROM #project AND "Work"
WHERE status = "active"
SORT file.mtime DESC
LIMIT 100
```

```dataview
TASK
FROM #project
WHERE !completed AND contains(text, "검토")
GROUP BY file.folder
```

```dataview
CALENDAR review
FROM #evergreen
SORT review ASC
```

- `FROM`: `#tag`, `"folder"`, `[[note]]`, `AND`, `OR`, `NOT`
- `WHERE`: 안전한 파일/속성 비교와 `contains(property, "text")`
- `SORT`: 최대 8개 안전 속성, `ASC`/`DESC`
- `GROUP BY`: 안전한 파일/속성 하나로 결과 section을 나눈다.
- `TASK`: fenced code 밖의 Markdown task만 읽으며 `completed`, `!completed`,
  `contains(text, "...")` 조건을 지원한다. 결과는 최대 2,000개, 전체 task 원문은 2,000,000자다.
- `CALENDAR`: 날짜 속성 하나를 `YYYY-MM-DD` 기준으로 정렬한 안전한 날짜 목록이며, Community
  Calendar/Dataview의 완전한 interactive month view가 아니다.
- Dataview는 조회 가능한 Markdown 입력이 블록당 500개를 넘으면 쿼리를 실행하지 않고, prefix를
  먼저 잘라 부분 결과를 완전한 보고서처럼 표시하지 않는다. 실행 가능한 입력에서 LIST
  결과는 최대 500개, TABLE은 최대 200행·32열, TASK는 최대 2,000개로 제한한다. 한 문서의
  `dataview` 블록도
  최대 8개다. 이 상한은 비정상 입력의 메모리·연산 폭증을 막는 1차 방어이며, 메인 스레드
  250ms 응답을 보장하는 근거는 아니다. 대형 Vault의 worker 실행과 실제 기기 성능 기준을
  통과하기 전에는 운영 Vault 플래그를 켜지 않는다. 쿼리는 32 KiB/100줄, 논리식은 깊이
  32·노드 256개·분석 시간 100ms로 제한한다.
- Base/Dataview의 `file.links`용 worker projection은 같은 대상 링크를 파일별로 중복 제거하고,
  파일당 256개·응답 전체 4,096개·대상명 1,024자로 제한한다. 이 상한을 넘는 링크는 안전한
  표/목록 projection에서 생략될 수 있다. 정본 Markdown과 Graph·Backlinks·Outgoing Links의
  canonical index는 이 projection 상한으로 잘리지 않는다.
- `dataviewjs`, 사용자 JavaScript, 임의 함수/정규식 표현식, 네트워크 요청은 실행하지 않는다.
- Dataview 전체 문법/계산식/API와 Community Plugin 바이너리 호환은 제공하지 않는다.
- Base는 파일/계산식 열을 제외한 실제 YAML 속성에 한해 편집 콜백을 연결할 수 있고,
  기존 메타데이터의 문자열·숫자·불리언·배열 타입을 유지한다. Dataview의 일반 결과 셀은 같은
  조회 엔진을 사용해도 읽기 전용이며, 위의 검증된 `TASK` checkbox만 제한된 예외다.

## 안전한 Templates

설정에서 선택한 템플릿 폴더(기본 `Templates` 또는 `템플릿`)의 Markdown을 명령 팔레트에서
현재 커서/선택 영역에 삽입하거나 새 노트로 만든다. 선택기는 검색과 키보드 탐색을 지원한다.

- `{{title}}`, `{{path}}`, `{{date}}`, `{{time}}`, `{{date:YYYY-MM-DD}}`, `{{time:HH:mm}}`
- `{{selection}}`, `{{cursor}}`는 편집기가 전달한 현재 선택 영역과 적용 뒤 cursor 위치에만 사용한다.
  선택 범위 치환은 최신 draft의 같은 range를 대상으로 하며 템플릿 실행 결과가 별도 HTML 정본을
  만들지 않는다.
- `{{prompt:질문}}`은 템플릿 선택 화면에서 사용자가 직접 입력한 값만 치환한다. 문서당 prompt는
  최대 20개이며, 입력하지 않은 값은 자동 추측하지 않고 원문 토큰과 경고를 남긴다.
- 날짜·시간 형식은 `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`와 구분자만 허용한다.
- 적용 전에는 길이가 제한된 미리보기를 보여 준다. 경로와 제목은 현재 Vault 문맥에서만 가져오며
  시스템 경로나 다른 사용자의 데이터를 읽지 않는다.
- 알 수 없는 토큰과 `<% ... %>` 스크립트는 실행하거나 삭제하지 않고 원문으로 남긴다.
- Templater의 JavaScript 런타임, 시스템 명령, 파일/네트워크 API는 제공하지 않는다.

## QuickMemo Drawing

리본 또는 명령 팔레트에서 만든 Drawing 노트는 QuickMemo 전용 `drawing-v1` Markdown으로 남는다.
펜, 선, 사각형, 타원, 화살표, 텍스트, 지우개, 실행 취소/다시 실행, 화면 이동, 25%~800%
확대/축소를 제공한다. 선택 도구에서 도형을 누르면 이동·모서리 크기 조절·삭제가 가능하다.

- JSON은 `quickmemo-drawing` fenced block 한 곳에만 저장한다.
- React SVG 도형만 렌더링하고 raw SVG, HTML, `foreignObject`, 원격 이미지를 실행하지 않는다.
- 요소 5,000개, 펜 점 25,000개, 좌표/색/선 굵기/텍스트 길이를 저장 전 다시 검증한다.
- 실행 취소/다시 실행 이력은 두 스택을 합쳐 50개 및 UTF-8 4 MiB로 제한하고 가장 가까운
  이력을 우선 보존한다.
- 포인터 이동·크기 조절은 화면 미리보기만 갱신하고 포인터를 놓을 때 한 번만 원문과 이력을
  저장한다. 방향키(Shift는 10단위), Delete/Backspace, Escape, 두 손가락 확대·이동을 지원한다.
- 현재 검증된 도형을 별도 inert standalone SVG로 내려받을 수 있다. export는 text를 escape하고
  raw SVG/HTML/원격 이미지를 넣지 않으며 원본 암호화 Markdown을 변경하지 않는다.
- 현재 선택은 한 요소씩이며 다중 선택, 회전, 손글씨 인식, 이미지 임베드는 제공하지 않는다.
- 이 형식은 Excalidraw의 `.excalidraw`/`.excalidraw.md` 파일 형식·JSON 구조나 Obsidian
  Excalidraw Plugin과 호환되지 않는다. 이름이나 확장자를 바꿔 호환되는 것처럼 표시하지 않으며,
  지원하지 않는 데이터는 덮어쓰지 않고 읽기 전용 오류로 연다.
- 자유 배치와 파일 연결이 목적이면 JSON Canvas를, 빠른 손그림이 목적이면 QuickMemo Drawing을
사용한다. 두 도구의 역할과 저장 형식은 서로 다르다.

## JSON Canvas

- 파일 카드는 이동 임계값을 넘기지 않은 일반 단일 클릭으로 원본 노트를 즉시 연다. Ctrl/Cmd,
  Shift, Alt가 포함된 클릭은 열기 대신 선택 의도를 유지하고, 키보드 `Enter`로도 선택한 파일 카드를
  열 수 있다.
- 다중 선택, 카드 이동·크기 조절, 선택 복제, 좌/우/상/하/가운데/중앙 정렬, 가로·세로 동일 간격
  배치, 20px grid snap 켜기/끄기, 맨 앞/맨 뒤 z-order, 삭제와 색상 변경을 제공한다. 선택 내부의
  edge는 복제할 때 함께 복제하며 선택 밖 endpoint를 가진 edge는 임의로 복제하지 않는다. 그룹을
  끌거나 복제하면 경계 안에 완전히 들어온 카드도 함께 처리하며, 이 관계는 JSON에 별도 parent 필드를
  쓰지 않고 좌표로만 계산한다. 우클릭·touch long-press 및 `Shift+F10` 메뉴, 전체 선택, Escape,
  방향키 이동을 제공한다. `Shift+1`은 전체 Canvas, `Shift+2`는 선택 항목을 화면에 맞추고,
  trackpad/wheel·가운데 버튼·Space drag로 이동하며 Ctrl/Cmd 또는 Space와 wheel로 제한 범위 안에서
  확대·축소한다. 빈 배경을 double-click하면 그 위치에 빈 텍스트 카드를 만들고, 텍스트 카드는
  sanitize된 Markdown을 표시하다 double-click할 때만 원문 편집으로 전환한다.
- 텍스트·파일·안전한 `http`/`https` 웹 카드, 그룹, 색상, 방향과 label이 있는 edge를 JSON Canvas
  정본에 보존한다. 외부 웹 카드는 실행 가능한 임의 HTML 카드가 아니다. Markdown 파일 카드는
  동일한 sanitize 경계를 거친 10만 자 이하의 inert 미리보기로 표시하며, 링크 실행이나 카드 안
  편집은 하지 않는다. 그룹 배경 이미지는 현재 Vault ACL 안에서 복호화되고 PNG/JPEG/WebP 서명
  검사를 통과한 asset만 blob URL로 표시하며 cover/contain/repeat를 지원한다.
- edge는 label과 네 가지 JSON Canvas 화살표 조합을 편집할 수 있다. double-click으로 label 편집에
  진입하고, 우클릭 메뉴로 source/target 카드에 이동한다. 연결 끝점 drag 재연결은 지원하지만
  빈 공간에 연결해 새 카드를 만들기, drag-disconnect, Obsidian 고유 곡선 routing의 픽셀 동등성은
  아직 지원하지 않는다.
- PDF 카드는 서명 검사된 blob URL과 빈 `sandbox`를 유지한 채 `#page`와 50~400% zoom만 허용한다.
  page는 JSON Canvas `subpath`에 저장하지만 JSON Canvas 1.0에 표준 crop/zoom 필드가 없으므로 zoom은
  세션 UI 상태이고, 실제 PDF 페이지 수를 넘는지 여부와 fragment 지원은 브라우저 PDF viewer에 달려 있다.
- 운영체제 파일 drop은 한 번에 16개, 파일당 기존 inline asset 제한 350 KB 이하만 허용한다. Canvas는
  원시 파일을 직접 저장하지 않고 Vault callback으로 넘기며, callback이 AES-GCM `asset-v1` 저장과 현재 폴더
  경로 확인을 마친 결과만 파일 카드로 만든다. 파일 byte buffer는 저장 시도 후 덮어쓴다. 폴더/directory
  drop과 이 제한보다 큰 첨부는 지원하지 않는다.
- 중첩·겹침 그룹은 별도 `parentId`를 만들지 않는다. 완전히 포함하는 그룹 중 면적이 가장 작은 그룹을
  직접 owner로 선택하고 같은 면적이면 JSON node 순서상 위에 있는 그룹을 사용한다. 외부 그룹 선택은
  이 직접 관계를 재귀적으로 확장한다. Canvas file-card와 Graph의 고정 의미 fixture는 공식 signed
  Obsidian 1.13.7 oracle과 exact compare했지만, 모든 group tie/modifier/long-press/edge routing의
  interaction·pixel 동등성까지 관찰한 것은 아니므로 전체 Canvas parity를 의미하지 않는다.

## Kanban

리본 또는 명령 팔레트에서 만든 `kanban-v1` Markdown은 `##` 제목을 열로, 체크박스 목록을
카드로 사용한다. 열/카드 추가, 이름과 내용 수정, 완료 토글, 삭제, 같은 열 드래그 정렬,
열 선택 이동·재정렬과 한 단계 nested checklist를 제공한다. frontmatter는 그대로 보존한다.

- 카드에는 완료 가능한 한 줄 행동을 적고, 배경·회의록·자료는 `[[원본 노트]]` 링크로 연결하는
  방식을 권장한다. 카드 안의 지원되는 Wikilink는 원본 노트를 즉시 열며, 노트 본문을 카드에
  복제하지 않는다.
- 지원하지 않는 Markdown 블록이 있으면 데이터 손실을 막기 위해 보드 편집을 잠그고 소스
  모드에서 확인하도록 안내한다.
- 각 카드는 정본 Markdown에서 계속 한 줄 `- [ ]`/`- [x]` 항목으로 남는다. 카드에 쓴
  `[[내부 링크]]`는 별도의 키보드 접근 가능한 열기 버튼으로 제공하며, URL scheme이 있는
  대상과 외부 Markdown 링크는 그 버튼으로 열지 않는다.
- `/schedule`에서 기존 Todo·Recurring 화면을 제거해도 Markdown 체크박스 문법과 Kanban 카드는
  제거하지 않는다. 일정 데이터와 노트 안의 작업 표현은 서로 다른 저장 의미를 갖는다.
- 보드는 500 KiB, 50개 열, 2,000개 카드로 제한한다. 손상된 문서의 파싱·화면 진단은
  요약을 포함해 최대 100개만 유지해 오류 목록으로 인한 메모리/DOM 폭증을 막는다.
- 카드 상세 메타데이터, swimlane, WIP 제한, archive, Community Kanban 전체 설정 호환은
  아직 제공하지 않는다.
- Obsidian Community Kanban note는 원본을 즉시 덮어쓰지 않는다. 먼저 호환성/손실 가능성을
  검사하고 사용자가 명시적으로 교체에 동의한 경우에만 지원 subset으로 가져온다. stale inspection
  또는 unknown 구조에서는 현재 보드를 유지한다. 내보내기는 clipboard, 제한된 Markdown textarea,
  로컬 download 경로를 제공하며 compatible marker를 보존한다. 이는 Community Plugin API/binary나
  모든 metadata의 round-trip 호환을 뜻하지 않는다.

## 동기화, File Recovery, 오프라인과 충돌

- Firestore 동기화는 여러 기기의 최신 상태를 맞추는 기능이지 백업이 아니다. 삭제·잘못된 수정도
  동기화될 수 있으므로 Obsidian ZIP 내보내기와 암호화 File Recovery를 함께 사용한다.
- File Recovery는 기존의 암호화 history envelope를 현재 세션 메모리에서만 복호화해 제한된
  미리보기를 보여 준다. 복원은 과거 내용을 새 revision으로 저장하며 서버의 이전 history를
  평문으로 바꾸거나 브라우저 저장소에 캐시하지 않는다.
- 모바일 상태 표시줄은 `저장 중`, `저장됨`, `오프라인-대기`, `저장 실패`, `충돌`을 구분한다.
  오프라인 편집은 메모리의 dirty draft로 유지하고 온라인 복귀 후 재시도한다. 브라우저를 닫아도
  유지되는 무제한 오프라인 저장을 뜻하지 않는다.
- revision 충돌에서는 로컬 초안을 자동 덮어쓰지 않는다. 로컬 내용을 새 노트로 보존하거나 원격
  최신본을 다시 불러오는 선택을 제공한다. Markdown은 추가로 base/local/remote를 비교하는 bounded
  three-way resolver를 열 수 있다. 겹치지 않는 변경은 자동 결합하고 충돌 범위마다 내 편집본/서버
  최신본/둘 다 보존/직접 편집을 선택한 뒤, 저장 직전 local scope와 server revision을 다시 읽어
  확인한다. 이름·폴더도 충돌했거나 문서/작업량 한도를 넘으면 자동 저장하지 않는다. 성공하지 않은
  저장을 `저장됨`으로 표시하지 않는다.

## ZIP 가져오기 복구와 자료실 Inbox 승격

- 중단된 ZIP import를 발견해도 시작 화면에서 자동 rollback하지 않는다. recovery panel에서 서버
  상태를 다시 확인한 뒤 사용자가 명시적으로 rollback을 선택한다. 완료된 import는 삭제하지 않고,
  staging rollback은 다른 탭/기기 실행 여부 확인을 요구하며, 이후 수정된 target은 revision conflict로
  보존한다. job ID, ciphertext, backend 예외 원문은 화면에 노출하지 않는다.
- 자료실에서 검토한 owner item은 `Vault에 저장`으로 server-authoritative `00_Inbox`에 암호화 Markdown
  복사본을 만들 수 있다. source URL은 `http`/`https`만 쓰고 capture time, summary/body/OCR,
  highlights, valid tags를 escape/normalize한다. 원본 Library item은 변경하지 않는다. 응답 유실 재시도는
  deterministic target과 암호화 payload를 확인하며, 성공 후에만 명시적 Vault 열기 동작을 제공한다.
- 이 두 흐름은 cloud-first E2EE 안의 보존/승격 경로다. OS 폴더 watcher, Git 정본, 무제한 offline
  queue, 자동 독립 백업을 의미하지 않는다.

## 추가 Core 도구

Audio Recorder, Footnotes View, immutable-preview Format Converter, revision-safe Note Composer,
sanitized Slides, allowlist/sandbox Web Viewer가 Vault에 lazy wiring되어 있다. 각 mutation은 기존 encrypted
asset/entry adapter와 revision 경계를 사용한다. 세부 입력 상한, 부분 실패 보존, CSP와 iframe 제한은
[`obsidian-core-module-integration.md`](./obsidian-core-module-integration.md)를 따른다.

## AI와 의미 검색 경계

- 종량제 AI API, embedding 서비스, 원격 LLM은 내장 기능이나 자동 fallback으로 사용하지 않는다.
- 의미 검색은 현재 기본 제공 기능이 아니다. 향후 추가하더라도 명시적 opt-in과 로컬/무료 경계를
  통과해야 하며 기본값은 꺼짐이다.
- 의미상 유사도는 internal link가 아니므로 검색 결과를 Graph·Backlinks edge로 추론하지 않는다.
- Discord·AI 내보내기는 메시지별 최대 길이를 지킨 순서 있는 batch로 만든다. 두 개 이상으로
  나뉜 경우 전체 문서를 다시 합쳐 하나의 안전한 메시지로 표시하지 않고, 각 메시지를
  순서대로 복사·전송해야 한다.

## 보안 및 비용 경계

- `eval`, `Function`, 동적 import URL, 사용자 스크립트, 플러그인 네트워크 호출을 사용하지 않는다.
- 복호화된 인덱스와 쿼리 결과는 기존 클라이언트 메모리 경계를 따른다.
- 기존 CSP, sanitizer, Firestore Rules, public share ACL을 우회하지 않는다.
- 위 기능에는 유료 API, 종량제 AI, 외부 SaaS 의존성이 없고 유료 provider로 자동 전환하지
  않는다. Firebase Spark와 Vercel Hobby에서는 포함 쿼터가 소진되면 해당 요청이 실패한다.
  단, 실제 Firebase Billing 연결 여부와 운영 환경변수는 앱 코드가 증명할 수 없으므로 배포
  전 계정 설정을 별도로 확인해야 한다.
