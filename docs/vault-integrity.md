# Vault 이름 및 폴더 트리 무결성

## 보안 경계

QuickMemo 서버와 Firestore Rules는 복호화된 파일·폴더 이름 또는 Vault
암호화 키를 알 수 없다. 따라서 다음 두 명제를 동시에 만족하는 서버측
검증은 불가능하다.

1. 서버가 이름을 추측할 수 없어야 한다.
2. 서버가 임의의 암호문 두 개가 같은 이름인지 스스로 판정해야 한다.

또한 Firestore Rules에는 재귀 탐색과 collection query가 없으므로,
`parentId` 그래프의 임의 깊이 순환을 Rules만으로 판정할 수 없다. QuickMemo는
이 제약을 client metadata 신뢰로 우회하지 않는다. 폴더 구조 변경은 기존
Vercel service-account API 경계에서 검증하고, Rules는 서버 전용 중앙 트리를
상수 비용으로 조회한다. 합리적인 hard cap 32 안에서는 깊은 중첩을 지원한다.

## Blind name index v1

`src/features/vault/vaultIntegrity.ts`는 클라이언트에만 있는 무작위 Vault
AES key를 HMAC-SHA-256 key로 가져와 다음 값을 MAC 한다.

```text
["quickmemo/vault-name", 1, targetType, parentId, canonicalName]
```

- 이름은 NFC, trim, case-fold 후 파일 종류에 맞는 확장자를 붙인다.
- `parentId`가 MAC 안에 있어 다른 폴더의 같은 이름은 서로 연결되지 않는다.
- Firestore에는 43자 base64url fingerprint만 저장할 수 있다.
- 이 방식은 서버에게 같은 부모 안의 이름 충돌 여부만 누설한다. 원문과
  전역 이름 빈도는 누설하지 않는다.
- 서버는 HMAC key가 없으므로 fingerprint와 암호화된 이름이 실제로
  대응하는지는 검증할 수 없다. 즉 정상 QuickMemo 클라이언트 사이의
  동시 생성 race는 transaction으로 막을 수 있지만, 인증된 소유자가
  변조한 SDK로 거짓 fingerprint를 쓰는 것까지 암호학적으로 강제하지는
  못한다. 이 한계는 기밀성 유지를 위해 의도적으로 수용한다.

### 안전한 도입 순서

1. 소유자별 무작위 index key를 RSA-OAEP로 감싸 `vaultIntegrity/{uid}`에
   1회 저장한다. 평문 key는 잠금 해제 세션 메모리에만 둔다.
2. 잠금 해제 후 기존 dual-read 폴더와 Vault entry를 모두 복호화하고
   `planVaultNameMigration`으로 v1 claim을 계산한다.
3. 기존 충돌이 하나라도 있으면 자동 덮어쓰기나 임의 삭제를 하지 않고
   사용자에게 rename 목록을 제시한다.
4. 충돌이 없는 claim만 revision-aware transaction으로 대상 문서와 함께
   생성한다. claim 문서 ID는 fingerprint, payload는 target ID/type과
   parent ID만 가진다.
5. rename/move는 새 claim 생성, 대상 revision 변경, 이전 claim 삭제를
   한 transaction에 묶는다. 새 claim이 이미 다른 target을 가리키면
   transaction을 실패시킨다.
6. 모든 활성 문서가 v1 claim을 가진 것이 확인되기 전까지는 기존 복호화
   스캔을 병행한다. 마이그레이션 완료 표시를 먼저 쓰지 않는다.

위 transaction/Rules 결합은 Firestore emulator golden fixture가 준비되기
전에는 production enforcement로 활성화하지 않는다. 특히 claim lifecycle을
대상 문서와 상호 검증하지 않은 채 claim collection만 추가하면 orphan claim
또는 이름 재사용 불가 상태가 생기므로 금지한다.

## Folder authority v3

`noteFolders`의 lineage v3 필드는 경로 표시와 ZIP export를 위한 파생 metadata다.
권한 판정에는 사용하지 않는다.

```ts
interface VaultFolderLineageV3 {
  vaultAncestorIds: string[];
  vaultLineageDepth: number;        // 0...32
  vaultLineageGeneration: number;
  vaultLineagePath: string;
  vaultLineageVersion: 3;
}
```

권위 구조는 owner별 서버 전용 `vaultFolderTrees/{uid}` 문서다. 각 node에는
opaque folder ID, opaque parent ID, `selfActive`, 파생 `active`, generation만
있으며 이름·경로·본문·key·name fingerprint는 없다. 브라우저 SDK는 owner라도
이 문서를 읽거나 쓸 수 없다.

```ts
interface VaultFolderTreeNode {
  parentId: string | null;
  selfActive: boolean;
  active: boolean;
  generation: number;
}
```

`/api/vault-folders`는 same-origin, Firebase ID token, active-user, App Check를
검증한 뒤 기존 service-account Firestore REST transaction을 사용한다. 전체
tree에서 missing parent, self/2-node/3-node cycle, depth 32 초과, forged active를
검증한다. 중앙 map은 보수적으로 암호화 폴더 2,000개와 JSON 700KB를 cap으로
두며 `nodes` indexing을 끈다. Cloud Functions나 유료 queue/database는 추가하지
않는다.

Firestore Rules는 client lineage 대신 중앙 문서의 `nodes[folderId].active`를
한 번 조회한다. 깊이 2 이상 note write도 Rules의 1,000-expression 제한 아래서
동작하며, tombstoned ancestor 아래의 create/update/restore는 실패 폐쇄한다.

### 생성·이동·휴지통·복원·가져오기 계약

- bootstrap은 tree가 없을 때만 bounded owner folder projection으로 최초 tree를
  만든다. 기존 tree가 invalid/stale이면 자동 덮어쓰지 않는다.
- create/import/legacy cutover는 authoritative parent가 존재하고 active인지
  확인한 뒤 tree, folder, opaque name claim을 한 transaction에 쓴다.
- rename/order 변경은 folder revision과 claim precondition을 확인한다.
- parent 변경은 전체 제안 tree를 검증한다. root→child, child→root, subtree
  이동을 허용하지만 descendant 아래 이동과 depth 32 초과는 원자적으로 거부한다.
- trash는 대상 `selfActive=false`와 모든 descendant의 파생 `active=false`를
  중앙 문서 한 번의 write로 반영한다. descendant 문서 순차 rewrite가 없으므로
  중간에 일부만 활성인 상태가 생기지 않는다.
- restore는 active parent를 요구하고 독립적으로 삭제된 descendant의
  `selfActive=false`를 보존한다.
- ambiguous create 응답 재시도는 저장된 암호문, wrapped key, parent, claim,
  import binding, revision-one lineage가 모두 같은 exact after-state일 때만 성공한다.
- entry import 응답 재시도도 encrypted title/body/wrapped keys/content identity와
  `lastMutationId`가 가리키는 encrypted create history까지 일치해야 한다.

ancestor move 뒤 descendant folder 문서의 파생 lineage는 즉시 rewrite하지 않아도
권한에 영향을 주지 않는다. 중앙 tree는 같은 transaction에서 완전히 갱신되며,
UI의 runtime path/trash 분류는 현재 `parentId`를 순회한다. 파생 lineage를 다시
저장하는 maintenance는 export metadata 정리일 뿐 보안 전제 조건이 아니다.

상세 위협 모델, 용량 제한, 장애/복구 계약과 검증 항목은
`docs/vault-folder-tree-security.md`를 기준으로 한다.
