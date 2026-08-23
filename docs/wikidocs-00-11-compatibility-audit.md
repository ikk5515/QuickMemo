# WikiDocs 00~11장 기준 QuickMemo 운영 의미 호환성 감사

확인일: **2026-08-23 (KST)**<br>
대상 코드 기준: `a4900608942db18577c08f48405616d9632ed3b6`에서 시작한
`codex/obsidian-plugin-suite` 작업 트리의 현재 통합 상태<br>
원문: [Obsidian 활용 가이드](https://wikidocs.net/book/19675)

## 1. 감사 목적과 판정

이 문서는 기능 이름이 같은지만 확인하지 않는다. WikiDocs가 반복해서 제시하는 다음 흐름이
QuickMemo에서 실제로 이어지는지를 확인한다.

> 빠르게 입력한다 → 원본 Markdown에 자기 언어로 정리한다 → 링크·태그·속성으로 연결한다 →
> Search·Quick Switcher·MOC·Calendar·Base/Dataview·Graph에서 회수한다 → Daily/주간/월간
> 리뷰를 거쳐 재사용 가능한 노트로 승격한다 → 충돌·삭제·장애 뒤에도 복구한다.

### 결론

- **핵심 방향은 맞다.** Markdown 정본, Wikilink/백링크, 태그·Properties, 검색, 검색 북마크,
  Quick Switcher, Graph, Daily/주간/월간 노트, Base/Dataview 역할 분리, Canvas/Drawing 역할
  분리, Markdown-backed Kanban, 암호화 File Recovery가 같은 운영 모델을 향한다.
- **그러나 “Obsidian 및 나열된 Community Plugin 전체 동급”이라고 말하면 안 된다.** Dataview,
  Templater, Drawing, Kanban은 의도적으로 실행 권한과 문법을 줄인 QuickMemo 내장 대체 기능이다.
  Excalidraw/Templater/Dataview/Kanban 플러그인 API·파일 형식 전체 호환이 아니다.
- **WikiDocs의 가장 큰 철학적 차이는 로컬 파일 소유권이다.** QuickMemo는 클라우드 우선 E2EE
  웹 Vault이고, OS 폴더를 직접 정본으로 삼거나 무제한 오프라인 편집을 제공하지 않는다.
  ZIP round-trip은 이식성 수단이지 local-first 증거가 아니다.
- **장기 운영의 가장 큰 미완료는 독립 백업과 복구 훈련이다.** Firestore 동기화와 같은 계층의
  File Recovery만으로는 독립 백업이 아니다. ZIP 내보내기가 있어도 실제 복원 성공 증거와 반복
  가능한 운영 절차가 없으면 “필요한 순간에 반드시 꺼낸다”는 목표를 닫을 수 없다.
- **현재 구현은 안전하게 범위를 줄이는 선택을 대체로 잘 지킨다.** 사용자 JavaScript, 원격 AI,
  임의 웹 실행을 허용하지 않고 ACL 밖 평문을 인덱스에 넣지 않는 방향은 WikiDocs의 플러그인
  다이어트·민감 정보 보호 원칙과 맞는다.

따라서 이 감사의 판정은 **“웹형 E2EE Markdown 지식 워크플로는 연결된 제품 흐름으로 구현,
전체 Community Plugin/API·로컬 파일시스템·미공개 UI/물리 엔진 호환은 의도적 제외”**이다. 운영
배포 완료 여부는 이 의미 감사와 분리해 exact-SHA CI/Firebase/Vercel/smoke 증거로만 판정한다.

## 2. 우선순위 기준

| 우선순위 | 의미 |
| --- | --- |
| **P0** | 데이터 손실·권한 노출·비용 발생 가능성, 운영 배포 증거 부재, 또는 “전체 동급”이라는 외부 주장 자체를 틀리게 만드는 차이. 활성화/동급 표기 전에 반드시 닫거나 명시적으로 제외한다. |
| **P1** | 정본 데이터는 안전하지만 WikiDocs가 설명하는 반복 운영 흐름이나 상호운용이 끊기는 차이. 제한된 내장 기능으로 정확히 이름 붙이면 배포할 수 있으나 호환 완료로 세면 안 된다. |
| **P2** | 자동화·가이드·프리셋·관찰성 개선. 수동 Markdown 운영으로 우회할 수 있다. |

P0 중 “동급 표기 금지” 항목은 QuickMemo 자체의 bounded workflow 배포까지 금지한다는 뜻이
아니다. **범위가 다른 기능을 같은 플러그인으로 표시하거나 local-first/full parity로 홍보하는
것을 금지**한다는 뜻이다.

## 3. 조사 범위와 공개 출처

공개 웹 본문을 2026-08-23에 열어 확인했다. WikiDocs는 계속 수정되는 문서이므로 아래 판정은
확인일 기준이며 이후 수정 시 다시 감사해야 한다.

| 장 | 공개 본문 | 이번 감사에서 추출한 운영 질문 |
| --- | --- | --- |
| 00 이 책을 읽는 법 | [00장](https://wikidocs.net/345765) | 기능 학습이 아니라 오래 유지되는 입력→연결→회수 흐름인가 |
| 01 10분 요약 | [01장](https://wikidocs.net/345766) | 첫 사용자가 최소 구조를 짧게 완주할 수 있는가 |
| 02 PKM과 Obsidian의 철학 | [02장](https://wikidocs.net/345767), [로컬 Markdown과 링크](https://wikidocs.net/345799), [설계 원칙](https://wikidocs.net/345800) | Markdown 소유권, 이식성, 얕은 구조, 링크 중심성이 유지되는가 |
| 03 기본기 완성 | [03장](https://wikidocs.net/345768), [Markdown](https://wikidocs.net/345805), [링크](https://wikidocs.net/345806), [탐색 도구](https://wikidocs.net/345807), [검색 북마크](https://wikidocs.net/345808), [Graph](https://wikidocs.net/345809) | 작성·연결·검색·제목 탐색·명령 실행·Graph 리뷰가 서로 다른 역할을 갖는가 |
| 04 구조화와 운영 시스템 | [04장](https://wikidocs.net/345769), [역할 분담](https://wikidocs.net/345811), [PARA](https://wikidocs.net/345812), [Daily/주기 노트](https://wikidocs.net/345813), [템플릿](https://wikidocs.net/345814), [MOC](https://wikidocs.net/345815), [Evergreen](https://wikidocs.net/345816), [분류 강박](https://wikidocs.net/345817) | 폴더·태그·속성·링크가 중복 책임을 갖지 않고, 임시 기록이 자기 언어의 지식으로 승격되는가 |
| 05 코어 플러그인 마스터 | [05장](https://wikidocs.net/345770), [Bases](https://wikidocs.net/345819), [Bases/Dataview](https://wikidocs.net/345820), [Canvas](https://wikidocs.net/345821), [운영 Core](https://wikidocs.net/345823) | 속성 운영, 조회 보고서, 공간 사고, Workspace/복구가 정본 Markdown과 연결되는가 |
| 06 커뮤니티 플러그인 실전 | [06장](https://wikidocs.net/345771), [Templater](https://wikidocs.net/345825), [Kanban/Calendar](https://wikidocs.net/345828), [Dataview](https://wikidocs.net/345829), [Git/Local Backup](https://wikidocs.net/345831) | 입력·상태·시간·조회·백업이 겹치지 않으며 플러그인 비용/권한을 관리하는가 |
| 07 AI 통합 | [07장](https://wikidocs.net/345833), [AI와 PKM](https://wikidocs.net/345834), [클라우드 LLM](https://wikidocs.net/345838), [하이브리드](https://wikidocs.net/345841), [프롬프트 자산화](https://wikidocs.net/345842) | AI가 선택적 보조 계층이고 입력 범위·외부 전송·비용·검증이 통제되는가 |
| 08 실무 워크플로우 | [08장](https://wikidocs.net/345774), [태스크/프로젝트](https://wikidocs.net/345843) | 입력 노트→작업 노트→정리 노트→재사용 자산이 한 원본을 유지하는가 |
| 09 자동화와 퍼블리싱 | [09장](https://wikidocs.net/345775), [대시보드](https://wikidocs.net/345849), [URI/Web Clipper](https://wikidocs.net/345850), [모바일 자동화](https://wikidocs.net/345851), [Git 다중 기기](https://wikidocs.net/345852) | 외부 입력이 짧고 안전하게 Vault 정본으로 들어오며, 자동화 실패가 조용히 누락되지 않는가 |
| 10 마스터 운영 | [10장](https://wikidocs.net/345776), [리팩터링](https://wikidocs.net/345856), [플러그인 다이어트](https://wikidocs.net/345857), [진화 신호](https://wikidocs.net/345859) | 인박스·깨진 링크·중복 속성·플러그인 의존·복구 가능성을 주기적으로 점검하는가 |
| 11 한계와 우회 패턴 | [11장](https://wikidocs.net/345777), [협업 대안](https://wikidocs.net/345863), [모바일](https://wikidocs.net/345864), [충돌](https://wikidocs.net/345865), [쓰지 말아야 할 때](https://wikidocs.net/345866) | 웹·모바일·동기화·협업 한계를 숨기지 않고 보존/비교/복구 경로를 제공하는가 |

WikiDocs의 설명을 Obsidian 공식 사양으로 취급하지 않았다. Graph/링크의 정확한 결과는 별도의
공식 1.13.7 oracle인 [`obsidian-official-golden-protocol.md`](./obsidian-official-golden-protocol.md)를
우선하고, 이 문서는 **운영 의미와 사용자 흐름**을 감사한다.

## 4. 입력→연결→회수 의미 지도

| 단계 | WikiDocs의 의미 | 현재 QuickMemo 근거 | 판정과 남은 일 |
| --- | --- | --- | --- |
| 빠른 입력 | Inbox/Daily/Web Clipper에서 분류 결정을 미루고 우선 기록 | Daily/주간/월간 생성은 `src/features/calendar/dailyNotes.ts`; 자료실 캡처·검토·Vault 승격은 `LibraryPage.tsx`, `src/features/library`, `src/services/libraryVault*` | **구현.** 검토한 owner item을 server-authoritative `00_Inbox`의 deterministic encrypted Markdown 복사본으로 승격하며 Library 원본은 유지한다. 외부 URL은 `http`/`https`만 허용하고 response-loss retry는 같은 target을 확인한다. |
| 자기 언어로 정리 | 발췌·회의·일지를 그대로 쌓지 말고 주장·해석·결정을 분리 | `markdown-v1` 정본, Source/Live Preview/Reading, Templates | **구현.** 다만 “출처/핵심 문장/내 해석” 템플릿과 Evergreen 승격은 사용자 규칙이며 앱이 대신 판정하면 안 된다. |
| 구조 부여 | 폴더=큰 위치, 태그=느슨한 분류, Properties=상태/날짜, 링크=맥락 | server-only folder tree, Tags, typed top-level Properties, Wikilink/Markdown link, 공통 query AST | **의미 일치.** 폴더 topology는 `vaultFolderTrees/{uid}`와 transaction API가 cycle/depth/tombstone/effective activity를 검증하고 browser direct write를 거부한다. Properties는 안전한 top-level type 중심이며 모든 nested/plugin property editor 호환은 아니다. |
| 연결 | 링크·백링크·heading/block·alias로 다음 맥락에 이동 | `src/features/knowledge/markdown.ts`, `knowledgeIndex.ts`, `LinkOccurrencePanel.tsx`, `pagePreview.ts` | **구현/보정됨.** 반복 occurrence와 graph edge를 구분하고 ACL 밖 대상은 제외한다. official oracle은 별도 문서의 exact comparison을 기준으로 한다. |
| 찾기 | 파일 위치는 Explorer, 제목은 Quick Switcher, 본문은 Search, 동작은 Command Palette | `VaultPage.tsx`, `src/features/vault/navigation`, `VaultSearchPanel.tsx` | **구현.** 검색 북마크, entry/search/graph 북마크도 암호화 workspace envelope에 포함한다. |
| 맥락 회수 | Backlinks/Outgoing/Local Graph/MOC로 “왜 연결했는지” 재발견 | occurrence별 문맥, Local Graph, `moc.ts` 검색 결과 인덱스 | **부분/P1.** 검색 인덱스는 실제 링크를 만들지만 목적·읽는 순서·핵심 링크를 사람이 편집한 MOC는 아니다. 현재 명칭을 “인덱스”로 둔 것은 정확하다. |
| 주기 리뷰 | Daily는 입력, Weekly는 정리/우선순위, Monthly는 패턴 확인 | 결정적 Daily/ISO-week/month 링크 생성 및 Calendar UI | **기반 구현.** 리뷰 질문/승격 큐/미처리 Inbox 지표는 프리셋으로 제공하지 않아 수동 운영이다(P2). |
| 운영/분석 | Base는 속성을 편집하는 작업 화면, Dataview는 선언형 보고서 | `src/features/base`, `src/features/dataview` | **의미 일치, 의도적 bounded 문법.** Base는 typed formula/summary와 table/card/list 편집을 제공한다. Dataview는 LIST/TABLE/TASK/CALENDAR/GROUP BY subset이며 TASK checkbox만 latest line/text/revision 검증 후 owner Markdown을 토글한다. DataviewJS/API는 제외한다. |
| 시각화 | Canvas는 배치·관계 탐색, Drawing은 손그림; 결론은 일반 노트로 돌림 | JSON Canvas와 QuickMemo `drawing-v1` | **도구 역할은 일치.** “선택한 Canvas 결과를 결정/요약 Markdown으로 승격”하는 전용 동작은 없고 수동 링크/노트 작성이다(P2). Drawing은 Excalidraw 호환이 아니다(P1). |
| 실행 | Kanban은 상태, Calendar는 시간, 원본 노트는 한 곳 | Markdown Kanban 카드와 Daily Notes Calendar | **핵심 의미 일치.** 카드 한 줄+원본 링크를 권장한다. Calendar는 일정 앱 대체가 아니라 Daily Note 탐색이다. 속성 날짜를 보여주는 범용 달력은 제공하지 않는다. |
| 재사용/배포 | 같은 Markdown을 글·보고서·외부 채널로 재구성 | Raw/GitHub/Notion/Discord·AI copy profiles, Slides, ZIP | **부분.** 복사/Slides는 있으나 게시 워크플로·Git 저장소·로컬 CLI 정본은 아니다. |
| 복구 | 동기화와 백업을 구분하고, 충돌 때 양쪽을 보존·비교 | encrypted history, Trash, bounded three-way Markdown merge, durable import recovery panel | **앱 내부 보존 흐름 구현, 독립 백업 P0 잔여.** conflict resolver는 non-overlap 자동 병합과 range별 명시 선택 후 remote revision을 재검증한다. import panel은 server recheck/explicit rollback을 분리하고 newer edits를 보존한다. 별도 저장 계층의 restore drill은 여전히 필요하다. |

## 5. 폴더·태그·속성·링크의 역할 계약

QuickMemo 사용자 문구와 템플릿은 다음 계약을 깨면 안 된다.

| 수단 | 맡길 역할 | 맡기지 않을 역할 | QuickMemo 확인 |
| --- | --- | --- | --- |
| 폴더 | 큰 물리 위치, 수명 주기, 내보내기 경로 | 모든 상태·주제·맥락을 깊은 트리 하나로 표현 | server-only central topology와 transaction API가 중첩 이동/rename/trash/restore 및 depth 32를 검증한다. browser lineage는 권한 근거가 아니다. 기본 안내는 얕은 `Projects/Areas/Resources/Archive/Daily/MOCs/Templates` 정도가 적합하다. |
| 태그 | 폴더를 가로지르는 느슨한 묶음, 검색 진입점 | 진행 상태와 날짜의 정본 | inline+YAML tags를 합치고 nested tag를 실제 하나의 태그로 취급한다. 상태는 `status`, 검토일은 `review` property로 유도해야 한다. |
| Properties | 기계가 필터·정렬할 `type/status/created/review/due` | 긴 설명·맥락·사고 과정 | Base/Dataview가 같은 metadata를 사용한다. `status/state/progress` 같은 동의 키를 앱이 자동 합치지는 않으므로 템플릿/운영 규칙이 필요하다. |
| 링크 | “왜 함께 봐야 하는가”라는 맥락과 이동 경로 | 단순 유사도·AI 추정·Canvas 시각 선을 지식 edge로 과장 | 실제 Markdown/Canvas file-card 링크만 Graph edge로 계산하고 유사도/평문 mention은 edge가 아니다. |

최소 스키마를 강제 마이그레이션하면 기존 노트를 깨뜨릴 수 있으므로 `type/status/created`는 권장
템플릿으로 제공하고, Base/Dataview에서 **누락·알 수 없는 값**을 볼 수 있게 하는 편이 맞다.

## 6. Daily, MOC, Evergreen 운영 의미

### Daily/주간/월간

- Daily는 완성 문서가 아니라 당일 입력 인박스다.
- 저녁 또는 주간 리뷰에서 의미 있는 항목만 프로젝트·회의·아이디어·결정·Evergreen 노트로
  옮기거나 링크한다.
- 주간 노트는 Daily 링크만 모은 자동 목록에서 끝나지 않고 “이번 주 결정/막힌 일/다음 주
  우선순위”를 자기 언어로 적어야 한다.
- 월간 노트는 주간 링크를 모으되 반복되는 문제와 살아남은 지식을 기록해야 한다.

`dailyNotes.ts`는 날짜/주차/월 경계를 결정적으로 만들고 링크를 잃지 않게 하는 기반을 제공한다.
그러나 승격 여부를 자동 결정하지 않는 것이 맞다. 대신 P2로 “Daily에서 새 Evergreen/결정 노트로
선택 영역 분리”, “미처리 Daily 링크”, “주간 리뷰 질문 템플릿”을 제공할 수 있다.

### MOC

`src/features/vault/moc.ts`의 `createSearchIndexMarkdown`은 최대 500개 결과를 중복 제거·경로
정렬해 실제 Markdown 링크로 만든다. 생략 수를 숨기지 않는 점도 안전하다. 하지만 이는
**검색 결과 인덱스**이지 MOC가 아니다.

MOC에는 최소한 목적, 범위, 권장 읽기 순서, 핵심 링크, 하위 MOC가 사람의 판단으로 들어가야
한다. UI/문서에서 자동 결과를 “MOC 완성”으로 바꾸지 않는다.

### Evergreen

Evergreen은 파일 형식이나 자동 분류가 아니라 다음 품질 기준이다.

- 자기 언어로 한 가지 주장을 설명한다.
- 제목만 읽어도 핵심이 드러난다.
- 원본 출처와 구분되며 독립적으로 이해할 수 있다.
- 관련 개념·반례·결정 노트에 링크한다.
- 나중에 수정 가능한 살아 있는 노트다.

따라서 앱이 AI 점수나 tag 하나로 Evergreen을 판정해서는 안 된다. QuickMemo가 제공할 수 있는
정확한 보조 기능은 템플릿, “Evergreen 후보” 검색 북마크, orphan/unresolved 검토, Note Composer
분리, MOC 연결 누락 경고 정도다.

## 7. Base/Dataview, Canvas/Drawing, Templates/Kanban/Calendar 비교

| 이름 | WikiDocs에서의 역할 | QuickMemo 실제 범위 | 호환 판정 |
| --- | --- | --- | --- |
| Bases | Properties를 table/list/card로 운영하고 원본 속성을 고침 | 공통 metadata 위에서 typed formula/value/summary, filter/sort/group, 지원 property write-through | **구현된 bounded Core surface.** 정확한 함수와 정규식/HTML/Moment/plugin 경계는 [`obsidian-bases-compatibility.md`](./obsidian-bases-compatibility.md)를 따른다. |
| Dataview | 같은 metadata로 LIST/TABLE/TASK, 조건·날짜 계산·집계 보고서 | `LIST`, `TABLE`, `TASK`, `CALENDAR`, `FROM`, 안전 `WHERE`, `SORT`, `GROUP BY`, `LIMIT`; 500 Markdown 입력 초과 시 fail closed | **핵심 보고 흐름 구현, 문법은 의도적 subset.** TASK checkbox는 source line/text/revision이 같은 owner Markdown에만 write-through한다. 날짜 산술/광범위 식/API/DataviewJS는 없다. “Dataview 안전 조회”로 표시한다. |
| Canvas | 파일·텍스트·이미지/PDF/웹을 공간에 놓고 사고를 외부화 | JSON Canvas 카드/그룹/edge, selection/resize/duplicate/align/gap/snap/z-order, file open, encrypted bounded drop | **주요 workflow 구현.** fully interactive embedded editor, exact PDF crop/page count, folder/large-file drop, every modifier/edge routing/pixel interaction은 제외하거나 별도 보정 대상이다. Canvas 시각 edge를 지식 edge로 추론하지 않는 원칙은 맞다. |
| Drawing/Excalidraw | 손그림·다이어그램; Canvas의 공간 배치와 다른 역할 | 검증된 `quickmemo-drawing` fenced JSON, pen/line/rect/ellipse/arrow/text, selection/move/resize/undo/redo/pan/zoom/pinch, inert SVG export | **QuickMemo Drawing workflow 구현.** `.excalidraw`/`.excalidraw.md`, scene/API/library, 다중 선택/회전/이미지 임베드 호환은 의도적 제외다. |
| Core Templates | 고정 Markdown 골격을 삽입 | Templates 폴더 선택/삽입/새 노트 생성 | 구현. 반복 형식의 기본 수단으로 먼저 권장한다. |
| Templater | date/path/prompt와 필요시 스크립트/파일 작업으로 동적 생성 | title/path/date/time/selection/cursor/prompt safe token, 설정형 template folder, create/insert | **안전한 반복 입력 workflow 구현, API 호환 제외.** `<% ... %>`, 시스템 명령, JS, 파일/네트워크 API는 실행하지 않는다. |
| Kanban | 카드가 머문 상태/병목을 보여 주고 원본 노트를 연다 | Markdown lane/card/checklist, DnD/keyboard 이동, lane reorder, Wikilink, 검사+동의 기반 Obsidian Kanban import, clipboard/textarea/download export | **핵심 workflow 및 명시적 interop 구현.** unknown/unsupported block은 loss conversion하지 않는다. Community Plugin API/전체 설정, WIP/swimlane/archive/모든 metadata round-trip은 제외다. |
| Calendar | Daily Note가 있는/없는 날짜와 시간 흐름을 본다 | 월 달력의 Daily/ISO week/month note 열기·생성, keyboard grid; name-write 잠금 중에도 기존 주·월 노트 열기 | 사용자 요청과 핵심 의미 일치. 일정관리 `/schedule`과 분리한 것이 맞다. 휴일/API/Community Plugin 전체 설정과 property 기반 범용 달력은 별도다. |

Tasks와 반복업무 화면을 일정관리에서 제거한 것은 이 감사에서 결함으로 세지 않는다. Markdown
체크박스, `task:` 검색, Kanban 카드까지 제거하면 오히려 노트 정본의 실행 표현을 잃으므로 현재처럼
별개로 유지해야 한다.

## 8. 검색·Quick Switcher·북마크·Graph

다음 네 도구를 한 검색 상자로 합치지 않은 현재 구조는 맞다.

- **File Explorer:** 위치와 수명 주기를 본다.
- **Search:** 본문·속성·태그·경로·task/line/block/section 조건으로 모은다.
- **Quick Switcher:** 알고 있는 제목/경로를 즉시 연다.
- **Command Palette:** 노트를 찾는 대신 동작을 실행한다.

`VaultSearchQuery` AST, `VaultSearchPanel`, `QuickSwitcher`, `CommandPalette`, encrypted
entry/search/graph bookmark가 이를 뒷받침한다. 검색 북마크는 결과 복사본이 아니라 반복해서
여는 **질문/관점**이어야 하며, 현재 query를 저장하는 방식은 그 의미와 맞는다.

Graph는 지식 시스템 자체가 아니라 구조 점검 화면이다. 현재 구현의 filter/group/display/force,
Local depth/direction, hover/open/drag/zoom은 강하지만 다음 운영 루틴이 더 중요하다.

1. orphan, unresolved, 특정 project query를 주간 Graph 북마크로 연다.
2. 이상한 노드를 발견하면 실제 노트의 링크·제목·속성을 수정한다.
3. 예쁜 좌표만 만들고 끝내거나 Canvas의 시각 edge를 지식 edge로 자동 승격하지 않는다.

공식 1.13.7 링크/Graph 결과는
[`obsidian-official-golden-protocol.md`](./obsidian-official-golden-protocol.md)의 signed-app capture와
exact comparison을 근거로 한다. [`obsidian-vault-status.md`](./obsidian-vault-status.md)도 이 oracle의
accepted semantic fixture와 아직 별도인 interaction/representative-device/deployment gate를 구분한다.

## 9. 보안·비용·모바일·충돌·백업 판정

### 보안과 비용

- plaintext knowledge index/query result는 unlock session 메모리 경계에 두고 lock/logout 때
  unmount/폐기하는 구조다.
- Templater/Dataview/Drawing/Web Viewer가 `eval`, 사용자 JS, arbitrary HTML을 실행하지 않는
  제한은 기능 부족이 아니라 보안 계약이다.
- AI/embedding/remote semantic search는 기본 제공하지 않는다. WikiDocs 07장의 AI는 필수가
  아니라 선택적 보조 계층이므로, **무료·보안 원칙 때문에 미탑재한 것은 올바른 범위 결정**이다.
- [`zero-cost-platform-2026-08-22.md`](./evidence/zero-cost-platform-2026-08-22.md)는 당시 Firebase
  Spark/Vercel Hobby의 read-only 확인을 기록하고 `security:billing-guard`가 paid SDK/route/fallback을
  막는다. 다만 계정 요금제는 코드 밖에서 바뀔 수 있으므로 production 활성화 직전에 반드시 다시
  읽기 전용 확인한다. 쿼터 소진 시 실패해야 하며 유료 plan/provider로 자동 전환하면 안 된다.

### 모바일

- responsive drawer, 44px target, 320/390px, WebKit/Chromium, reduced motion 테스트는 좋은 기반이다.
- WikiDocs 11장의 모바일 역할처럼 빠른 캡처·짧은 편집·읽기·사진/음성이 우선이고, 대규모
  구조 변경/Canvas 리팩터링은 데스크톱에 맡기는 안내가 필요하다.
- Playwright WebKit은 실제 Safari가 아니며 물리 iPhone/iPad의 키보드, IME, pinch, long-press,
  메모리 회수, 앱 전환 복귀를 증명하지 않는다. **P1 대표 기기 acceptance**가 남는다.
- 브라우저를 닫아도 보존되는 offline queue가 없으므로 “오프라인 사용 가능”이라고 표기하면
  안 된다. 현재 메모리 dirty draft의 `오프라인-대기`는 탭 생존 중 임시 상태다.

### 충돌

`draftConcurrency.ts`와 `VaultPage.tsx`는 저장 중 추가 편집을 dirty로 보존한다. revision 충돌에서
사용자는 현재 편집본을 별도 암호화 노트로 보존하거나 서버 버전을 다시 불러오거나, bounded
three-way Markdown resolver를 열 수 있다. resolver는 base/local/remote의 겹치지 않는 변경을 자동
결합하고, 충돌 range마다 local/remote/both/manual 선택을 요구한다. 적용 직전 local dirty scope와
remote revision/body/title/folder를 다시 읽고 metadata conflict나 stale result는 저장하지 않는다.
화면을 닫거나 비교하는 것만으로 어느 쪽도 덮어쓰지 않는다.

이 기능은 줄 기반 Markdown merge이며 AST 의미 merge나 모든 대용량 문서 diff가 아니다. 작업량/
본문 제한을 넘으면 전체 버전 보존 선택으로 fail closed한다. 브라우저 종료 전 dirty draft를 영속
보존하지 않는 경계도 UI에 계속 명시해야 한다.

### 백업과 복구

- File Recovery: 같은 서비스 계층의 암호화 revision history다.
- Trash: 삭제된 entry/folder subtree를 revision-aware하게 복원한다.
- ZIP export/import: provider 밖으로 옮길 수 있는 Markdown/Canvas/Base/asset 이식 경로다.
- durable import rollback: 중간 실패와 새 수정 충돌을 fail closed로 보존한다.
- import recovery panel: 시작 시 자동 rollback하지 않고 server recheck와 명시 rollback을 분리하며,
  committed/newer target은 삭제하지 않는다.

이 네 기능은 각각 필요하지만 **Firestore sync/history 자체는 독립 백업이 아니다.** WikiDocs가
Git과 Local Backup을 나누는 이유도 긴 이력·원격 복제·짧은 시점 복구가 다른 실패 영역을 가져야
하기 때문이다. QuickMemo에서 무료/암호화 원칙을 지키는 현실적 P0 수용 기준은 다음과 같다.

1. 사용자가 내려받은 ZIP을 새 빈 테스트 Vault에 import한다.
2. 폴더, `.md`, `.canvas`, `.base`, asset, 링크/alias/tag/Properties 수를 manifest와 비교한다.
3. 원본을 덮어쓰지 않고 실패 시 모든 잔여 항목/잠금 상태를 사용자에게 보여 준다.
4. 복구 훈련 결과와 사용한 app SHA를 민감 정보 없이 기록한다.
5. 월 1회 또는 구조 개편 전 export를 안내하되 브라우저가 자동 다운로드/유료 저장소 업로드를
   몰래 수행하지 않는다.

## 10. 우선순위별 미완료/수정 목록

### P0 — 활성화 또는 전체 동급 표기 전에 닫을 것

| ID | 문제 | 코드/문서 위치 | 수용 기준 |
| --- | --- | --- | --- |
| P0-1 | Community Plugin 전체 호환처럼 보일 수 있음 | `src/features/dataview`, `templater`, `drawing`, `kanban`; `docs/obsidian-built-in-tools.md` | 현재처럼 UI·도움말·릴리스 노트를 “안전한 내장 조회/템플릿/드로잉/보드”로 유지하고, Dataview/Templater/Excalidraw/Kanban API/binary/file-format parity를 완료 항목에 세지 않는다. |
| P0-2 | local-first/full Obsidian 소유권 주장과 cloud-first E2EE 구조가 다름 | `src/App.tsx`, Firestore persistence, ZIP interop | 제품 문구에 cloud-first E2EE와 offline/OS watcher 제외를 표시한다. local-first를 주장하려면 별도 파일시스템 정본·충돌·offline acceptance를 구현한다. ZIP만으로 local-first라 하지 않는다. |
| P0-3 | 독립 백업 및 실제 restore drill 증거 부족 | `VaultHistoryPanel`, `VaultTrashDialog`, Vault ZIP import/export, import recovery | 위 9절의 빈 Vault restore drill을 통과하고 실패/잔여/rollback을 기록한다. File Recovery를 백업으로 표기하지 않는다. |
| P0-4 | 운영 활성화는 코드 존재가 아니라 동일 SHA 증거가 필요 | `docs/obsidian-vault-status.md`, CI/deploy workflow | 전체 guard/lint/type/unit/Rules/API/build/audit/E2E → exact master SHA CI → Firebase Rules/index(변경 시) → 동일 SHA Vercel Production → public smoke → authenticated decrypt/edit/search/Graph/Canvas/recovery smoke를 각각 기록한다. |

### P1 — 안전하지만 운영/상호운용이 끊기는 항목

| ID | 차이 | 현재 안전한 우회 | 필요한 다음 단계 |
| --- | --- | --- | --- |
| P1-1 | Dataview 날짜 산술/함수, broader expressions/API/DataviewJS 없음 | LIST/TABLE/TASK/CALENDAR/GROUP BY + Base | 필요한 선언형 문법만 bounded worker/query surface에 추가하거나 미지원 진단을 유지한다. JS/네트워크 실행은 추가하지 않는다. |
| P1-2 | Templater/QuickAdd recipe 및 `<% ... %>` 호환 없음 | Core Templates와 승인 prompt token | “Templater” 명칭을 호환 의미로 쓰지 않는다. 반복 capture flow가 필요하면 선언형 action recipe를 별도 스키마로 설계한다. |
| P1-3 | Community Kanban advanced board/API/전체 설정 호환 없음 | 검사+동의 기반 supported import와 Markdown export | 현재처럼 unknown/unsupported block과 stale inspection을 덮어쓰지 않는다. WIP/swimlane/archive/metadata가 필요하면 별도 schema와 loss preview로 추가한다. |
| P1-4 | Excalidraw 파일/scene/plugin 호환 없음 | QuickMemo Drawing 또는 JSON Canvas | import/export converter를 별도 손실 경고 방식으로 만들기 전까지 Drawing이라고만 표시한다. |
| P1-5 | Live Preview의 모든 nested cursor/IME/modifier/pixel interaction은 보정되지 않음 | complex inactive block widgets, ACL Page Preview, Source/Reading | actual CodeMirror interaction fixture와 대표 브라우저/IME를 계속 보강하되 private rendering의 pixel parity로 과장하지 않는다. |
| P1-8 | unlimited pane/window 및 multi-window geometry 전체 호환 아님 | 8-pane/5-level recursive split, pointer/keyboard resize, encrypted named workspace, mobile single-pane selector | 현재 safety limit을 UI에 명시한다. OS 새 창 geometry/cross-window sync가 필요하면 별도 encrypted schema와 browser acceptance를 추가한다. |
| P1-9 | 실제 Safari/iPhone/iPad evidence 없음 | 320/390 Playwright Chromium/WebKit | 물리 기기에서 IME, virtual keyboard, pinch/long-press, drawer focus, background/foreground, memory pressure, no-overflow를 기록한다. |
| P1-10 | URI/mobile automation/Git/CLI 정본 연동 없음 | login handoff, Library capture, ZIP copy profiles | 민감 본문을 URL에 싣지 않는 nonce handoff만 허용하고, 자동화는 사용자가 검토하는 Inbox draft에서 끝내도록 설계한다. |
| P1-11 | Calendar가 Daily/주기 노트 중심이고 property date 전체를 보여주지 않음 | Schedule 또는 Base에서 due/publish/review 확인 | 범용 날짜 뷰가 필요하면 원본 property를 읽는 별도 filterable view로 만들고 Daily Calendar와 이름/역할을 섞지 않는다. |
| P1-12 | collaboration은 공유와 실시간 공동 편집이 다름 | encrypted share와 복사/읽기 흐름 | 동일 문서 realtime coauthor/approval/comment를 구현하지 않았다면 “협업 편집”으로 표현하지 않는다. |

### 이번 통합에서 닫힌 과거 차이

- server-only encrypted folder topology와 transaction API가 cycle/depth/tombstone/claim/direct-write
  경계를 통합했다. 최종 release 전 전체 Rules/API gate는 다시 실행하지만 “lineage 구현 전” 상태는 아니다.
- complex Live Preview block widget과 Live Preview/Reading Page Preview 연결이 추가됐다.
- Dataview `TASK`, `CALENDAR`, `GROUP BY`와 revision-safe owner task toggle이 추가됐다.
- Library 검토 항목을 원본 보존형 encrypted `00_Inbox` Markdown으로 승격하는 흐름이 추가됐다.
- revision conflict의 bounded three-way 비교/선택/save-revalidation UI가 추가됐다.
- ZIP import의 startup silent rollback을 없애고 명시적 recovery panel을 추가했다.
- workspace는 두 pane 고정이 아니라 최대 8 pane/5 level recursive split과 encrypted restore로 확장됐다.
- signed/notarized Obsidian 1.13.7 fixture의 link/tag/Graph/Canvas-file exact comparison이 accepted됐다.

### P2 — 유지 가능성을 높이는 독립 개선

- 첫 실행에서 `Inbox/Daily/Projects/Areas/Resources/Archive/MOCs/Templates`를 **선택적으로** 만드는
  온보딩과 “왜 이 구조인가” 한 문단을 제공한다.
- Daily/meeting/project/reading/idea/decision/review의 7개 최소 템플릿과
  `type/status/created/review` 권장 schema를 예제로 제공한다.
- “Daily에서 아직 승격하지 않은 링크”, “orphan/unresolved”, “중복 property key”, “30일간 열지
  않은 plugin view”를 모은 월간 유지보수 화면을 만든다. 자동 삭제/분류는 하지 않는다.
- 검색 결과 인덱스를 만든 직후 목적·핵심 링크·읽는 순서를 작성하도록 MOC 체크리스트를 보여 준다.
- Kanban WIP 규칙과 주간 Calendar 공백을 함께 보는 review template를 제공하되 `/schedule`의
  제거한 Todo/Recurring 기능을 되살리지 않는다.
- Canvas/Drawing 결과에서 “결정 노트 만들기”를 누르면 선택한 카드/도형을 덮어쓰지 않고 링크된
  Markdown 초안을 만든다.
- AI는 계속 opt-in/무료/로컬 경계를 기본으로 한다. 종량제 API나 paid fallback을 편의 기능으로
  넣지 않는다.

## 11. 이미 구현된 항목의 테스트 근거

| 계약 | 코드 근거 | 회귀 근거 |
| --- | --- | --- |
| Daily/ISO week/month links | `src/features/calendar/dailyNotes.ts` | `dailyNotes.test.ts`, `DailyNotesCalendar.test.tsx` |
| safe template title/path/date/time/selection/cursor/prompt, script non-execution | `src/features/templater/templateEngine.ts` | `templateEngine.test.ts`, `TemplatePickerDialog.test.tsx` |
| bounded Dataview LIST/TABLE/TASK/CALENDAR/GROUP BY and safe task toggle | `src/features/dataview/query.ts`, `DataviewBlock.tsx`, `task.ts` | `query.test.ts`, `DataviewBlock.test.tsx`, `task.test.ts` |
| Markdown-backed Kanban + checklist/reorder/safe inspected import/export | `src/features/kanban/model.ts`, `KanbanBoard.tsx` | `model.test.ts`, `KanbanBoard.test.tsx`, `kanbanStyles.test.ts` |
| validated QuickMemo Drawing and inert SVG export | `src/features/drawing` | `model.test.ts`, `geometry.test.ts`, `DrawingView.test.tsx`, `export.test.ts` |
| typed bounded Bases | `src/features/base` | parser/engine/formula/materialization worker/BaseView tests; detailed contract in `obsidian-bases-compatibility.md` |
| search result index is not silently complete | `src/features/vault/moc.ts` | `moc.test.ts` |
| dirty edits survive in-flight save | `src/features/vault/draftConcurrency.ts` | `draftConcurrency.test.ts` |
| recursive 8-pane/5-level split, pin, workspace bounded restore | `workspaceTabs.ts`, `workspaceState.ts`, `WorkspacePaneTree.tsx`, `VaultWorkspaceManager.tsx` | respective `.test.ts(x)` files |
| history/trash plaintext and restore bounds | `VaultHistoryPanel.tsx`, `VaultTrashDialog.tsx` | `VaultHistoryPanel.security.test.tsx`, `VaultTrashDialog.test.tsx` |
| import compensation/rollback conflicts | `importRollback.ts`, `VaultImportRecoveryPanel.tsx` | `importRollback.test.ts`, service/API/Rules suites |
| bounded three-way Markdown conflict merge | `markdownThreeWayMerge.ts`, `VaultDraftConflictResolver.tsx`, VaultPage save adapter | merge/resolver/security tests plus VaultPage integration tests |
| Library item to encrypted Vault Inbox | `src/features/library`, `src/services/libraryVault*`, `LibraryPage.tsx` | Markdown/button/service/readiness/API/Rules focused tests |
| server-only encrypted folder topology | `vaultFolderTrees/{uid}`, `/api/vault-folders`, Rules | folder tree pure/API emulator/Rules suites and `vault-folder-tree-security.md` |
| complex Live Preview and ACL Page Preview | `LivePreviewBlockWidget.tsx`, `inlineLivePreview.ts`, `CodeMirrorMarkdownEditor.tsx`, `pagePreview.ts` | CodeMirror/renderer/page preview/Vault integration tests |
| Core Audio/Footnotes/Converter/Composer/Slides/Web viewer wiring | `src/features/vault/core`, lazy wiring in `VaultPage.tsx` | module tests and `VaultPage.plugins.test.ts`; authenticated browser flow must still be part of release proof |
| official Graph/link/tag oracle | `obsidianGoldenVault*`, oracle scripts | `docs/obsidian-official-golden-protocol.md`, compare test |
| zero paid-provider fallback | `scripts/security-no-billing-guard.mjs` | guard self-test + CI job; external Spark/Hobby plan recheck still required |

이 표의 unit/component test는 **구현 근거**이지 production 성공 증거가 아니다. 실제 배포 완료는
P0-4의 단계별 증거가 모두 있어야 한다.

## 12. 재검증 명령과 감사 완료 조건

이 문서만 추가한 감사에서는 관련 의미 계약의 focused suite와 문서 whitespace를 재검증한다.

```bash
npx vitest run \
  src/features/calendar/dailyNotes.test.ts \
  src/features/calendar/DailyNotesCalendar.test.tsx \
  src/features/templater/templateEngine.test.ts \
  src/features/templater/TemplatePickerDialog.test.tsx \
  src/features/dataview/query.test.ts \
  src/features/dataview/DataviewBlock.test.tsx \
  src/features/kanban/model.test.ts \
  src/features/kanban/KanbanBoard.test.tsx \
  src/features/drawing/model.test.ts \
  src/features/drawing/geometry.test.ts \
  src/features/drawing/DrawingView.test.tsx \
  src/features/vault/moc.test.ts \
  src/features/vault/draftConcurrency.test.ts \
  src/features/vault/workspaceTabs.test.ts \
  src/features/vault/workspaceState.test.ts \
  src/features/vault/importRollback.test.ts \
  src/features/vault/VaultTrashDialog.test.tsx \
  src/features/vault/VaultHistoryPanel.test.ts \
  src/features/vault/VaultHistoryPanel.security.test.tsx \
  src/features/knowledge/query.test.ts \
  src/features/vault/CodeMirrorMarkdownEditor.test.tsx

awk '/[[:blank:]]+$/ { print FNR ":" $0; bad=1 } END { exit bad }' \
  docs/wikidocs-00-11-compatibility-audit.md
```

과거 `21 test files / 131 tests` 결과는 이후 기능 추가 전 snapshot이므로 현재 전체 통과 수로
재사용하지 않는다. 이 문서 갱신에서는 stale claim과 Markdown whitespace/diff만 확인한다.

전체 활성화 판단에는 AGENTS.md의 security guards, lint, typecheck, 전체 test, Rules/API emulator,
build, audit, browser acceptance와 exact-SHA GitHub/Firebase/Vercel/production smoke가 필요하다. 각
단계가 실제로 끝나기 전에는 이 감사가 배포 완료를 대신 선언하지 않는다.
