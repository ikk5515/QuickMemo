# Vault 이름 및 폴더 트리 무결성

## 보안 경계

QuickMemo 서버와 Firestore Rules는 복호화된 파일·폴더 이름 또는 Vault
암호화 키를 알 수 없다. 따라서 다음 두 명제를 동시에 만족하는 서버측
검증은 불가능하다.

1. 서버가 이름을 추측할 수 없어야 한다.
2. 서버가 임의의 암호문 두 개가 같은 이름인지 스스로 판정해야 한다.

또한 Firestore Rules에는 재귀 탐색과 collection query가 없으므로,
`parentId` 그래프의 임의 깊이 순환을 Rules만으로 판정할 수 없다.
현재 Rules의 자기 참조와 2-node cycle 차단은 방어층이지만 3-node 이상을
완전하게 증명하지 않는다.

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

## Folder ancestry v1

`auditVaultFolderTree`는 잠금 해제 후 소유자의 전체 폴더 snapshot으로 다음을
검사하고, 정상인 경우에만 `{version, depth, ancestorIds}`를 계산한다.

- duplicate ID
- missing parent
- 임의 깊이 cycle
- 최대 깊이 64 초과

이 metadata는 마이그레이션 진단과 client transaction 사전 검증에만 쓴다.
현재 구조에서 이것을 곧바로 Firestore Rules의 권한 근거로 사용하면 안 된다.
상위 폴더 이동 시 모든 하위 폴더 metadata를 원자적으로 갱신할 수 없고,
부분 갱신된 stale ancestry는 false positive뿐 아니라 새 조상을 누락해 이후
cycle을 허용할 수 있기 때문이다.

현재 구현된 방어층은 다음과 같다.

- 공식 클라이언트는 create/move 전에 복호화한 전체 폴더 snapshot과 제안된
  새 상태를 함께 audit하여 자기 ID 재등장, missing parent, 깊이 64 초과를
  실패 처리한다.
- 폴더 이동 transaction은 parent부터 root까지 다시 읽지만, 폴더 생성
  transaction은 immediate parent의 존재·소유자·암호화 상태만 확인한다.
  따라서 동시 생성·이동 race나 변조 SDK까지 포함한 ancestry 불변식은 아직
  모든 경로에서 강제되지 않는다.
- 잠금 해제 직후 전체 tree audit가 실패하면 folder move/migration을 중단하고
  복구 화면만 제공한다.
- Rules는 self-cycle과 직접 2-node cycle을 추가 방어한다.
- 인증된 소유자의 임의 SDK write까지 포함한 arbitrary-depth cycle의 완전한
  서버 강제는 trusted server/Cloud Function 또는 이동 불가 immutable tree
  없이는 불가능하다. 둘 다 현재 E2EE·무과금·Obsidian 동작 계약과 충돌하므로
  구현 완료로 보고하지 않는다.
