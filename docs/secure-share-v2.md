# QuickMemo Secure Share v2

Secure Share v2 adds server-enforced access policy to QuickMemo public links
without changing the existing end-to-end content encryption boundary.

## Compatibility and feature flags

- Existing shares without `schemaVersion: 2` remain legacy v1 shares.
- New v2 shares are never bulk-migrated from v1.
- The content key remains in the URL fragment. Standard links use
  `/share/{shareId}#key={43-character-key}` and compact links use
  `/s/{24-character-token}#{43-character-key}`. Fragments are not sent in HTTP
  requests and must not be copied into a query string, path, cookie, log,
  `localStorage`, `sessionStorage`, server database, or external URL shortener.
- `VITE_SECURE_SHARE_COMPACT_URL_ENABLED=true` changes only newly reconstructed
  links whose internal ID is exactly `ss2_` plus a 24-character base64url
  token. The compact parser is always present so turning the generation flag
  off does not break links already issued. Existing long v2 and all legacy v1
  links remain on `/share/` and keep the `#key=` fragment.
- Browsers normalize dot segments, backslashes, and an empty query delimiter
  before the SPA can inspect `location`. QuickMemo therefore enforces the
  canonical final pathname, one exact 24-character compact token, no non-empty
  query, and one exact fragment form. Such browser-equivalent spellings can
  resolve only to that same final share ID; they cannot escape the application
  origin, select an unvalidated ID, move the content key out of the fragment,
  or weaken the server access policy. Generated links always use the canonical
  form.
- `SECURE_SHARE_V2_ENABLED=true` is required before any v2 server operation.
- `VITE_SECURE_SHARE_V2_ENABLED=true` is also required before the owner UI is
  shown.
- `VITE_READONLY_NOTE_RENDERER_V2_ENABLED`,
  `VITE_SECURE_SHARE_DIRECT_ENTRY_ENABLED`, and
  `VITE_UNIFIED_SELECT_UI_ENABLED` are default-on Production rollback flags
  after their staged rollout; exact `false` remains a rollback.
- `VITE_SECURE_SHARE_COMPACT_URL_ENABLED` is intentionally stricter: only the
  exact build-time value `true` generates new compact links. Missing or
  `false` keeps standard `/share/` generation while the always-present parser
  continues to accept compact links already issued. Because `VITE_` values are
  embedded at build time, changing this flag requires a new Production
  deployment.
- Live sync requires both
  `VITE_SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED` and the server-only
  `SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED`. Its reviewed Production source
  defaults in the client, Secure Share API, and Blob attachment API are
  enabled together only after the active Vercel WAF rule is verified. A true
  environment value cannot bypass an off source default; exact false can
  still roll back a source-enabled release.
- Disabling the read-only renderer flag keeps the sanitizer, element
  allowlist, and size/depth/node limits active, but restores legacy empty
  paragraph rendering. Disabling the select flag keeps the native
  `<select>` behavior and caller classes, but removes the unified
  `app-select` theme class.
- `SECURE_SHARE_EMAIL_ENABLED=true` is required before OTP delivery is
  available. It must remain false until the selected SMTP account,
  password/app password, matching From address, provider health, and actual
  receipt are verified on the exact Production SHA. The normal proof is the in-app
  `stage` → `send-test` → six-digit `confirm-test` flow; an approved automated
  mailbox smoke is optional.
- Email false does not disable Core v2. Existing email-gated policies and
  sessions fail closed with `email_feature_unavailable`; they are never
  downgraded to a link-only or authenticated-users policy.
- Comment participant identity is independently gated by
  `SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED=true`. Partial network display
  additionally requires `SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED=true` and the
  share owner's `showCommenterIpPrefix` policy. All three checks fail closed.
- `SECURE_SHARE_MAX_PARTICIPANTS_PER_SHARE` defaults to and is clamped at
  1,000. Lowering it blocks only new participant allocation; existing
  participants retain their assigned number and comment capability.
- Turning the server flag off makes every v2 API fail closed while leaving v1
  shares unchanged.

The first compatibility deployment must keep Core and email flags false.

## Access modes

`accessMode` is one of:

- `anyone_with_link`
- `allowed_emails`
- `authenticated_users`

Password and email verification are independent AND conditions. An
`allowed_emails` policy always requires email verification. An
`authenticated_users` policy requires a non-anonymous, active QuickMemo user;
if email verification is also selected, the verified mailbox condition must
also pass.

QuickMemo login identifiers can be synthetic service addresses. A synthetic
login address is not proof of mailbox ownership and must not silently satisfy
an OTP requirement. For `anyone_with_link` and `allowed_emails`, enabling email
verification always requires the share OTP even when the browser also has a
verified Firebase user session.

## Direct entry and live content synchronization

When `VITE_SECURE_SHARE_DIRECT_ENTRY_ENABLED` is enabled, a link-only share
with no remaining user gate opens its encrypted body automatically after
metadata validation. An authenticated owner or administrator preview also
opens automatically without consuming a one-time share. Direct entry does not
weaken or skip a gate: password and OTP fields and the QuickMemo login action
are shown immediately and still require the corresponding user action. A
one-time link no longer has a separate client confirmation checkbox; the
server still grants and consumes its one-time access atomically. After a
required login completes, access may continue automatically only after the
server rechecks the authenticated policy.

Setting `VITE_SECURE_SHARE_DIRECT_ENTRY_ENABLED=false` restores the explicit
viewer open action for otherwise automatic link-only and owner-preview paths.
It does not disable Core v2, change server authorization, or downgrade a
password, OTP, login, or one-time policy.

`VITE_SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED` gates both the owner's active
share-content refresh path and the open viewer's revision checks, while
`SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED` independently rejects the live-only
owner update and revision API actions when the server gate is off. The viewer
starts with four nominal 2.5-second revision intervals while the document is
visible. Consecutive unchanged checks then back off through four 15-second
intervals, four 30-second intervals, and a steady 60-second interval. Each
scheduled delay has bounded plus or minus 10 percent jitter to avoid
synchronized bursts. Polling stops completely while the document is hidden or
the browser is offline. A content change, focus, `online` event, or transition
back to visible resets the rapid window; focus, `online`, and visible
transitions also trigger an immediate deduplicated check.

The current revision endpoint performs four Firestore document reads per
normal viewer or owner-preview check; an administrator preview of another
owner's share needs one additional source-owner profile read. At the steady
unchanged 60-second interval, one continuously visible normal tab uses about
5,760 reads per day, plus a small initial backoff allowance (at most about
6,400 reads if every jitter sample were at the shortest bound). This is below
the current [50,000-document-read daily free quota](https://firebase.google.com/docs/firestore/pricing)
for one otherwise idle tab, but the quota is shared by all QuickMemo traffic
and multiple open tabs or continuous content changes multiply the usage.
Production monitoring and the live-sync rollback flag remain required. The
adaptive client schedule is a budget guard, not an abuse-proof server quota or
a quota reservation.

When live sync is enabled, the server rejects the legacy
`source_changed_<uuid>` automatic revoke emitted by an older owner tab while
the source note is still active. Explicit owner revocation remains available,
and deleted, purged, or missing sources may still be revoked and cleaned up.
The current client uses a distinct `source_deleted_<uuid>` mutation for note
deletion so mixed old/new browser bundles cannot turn an ordinary edit into a
destructive share revocation.

Before Production live-sync activation, the deployment workflow reads the
active Vercel Firewall configuration without changing it. It requires an
active, valid, blocking fixed-window rule scoped to
the entire exact `/api/public-shares-v2` path, with no client-controlled
narrowing condition, one IP-only bucket key, and no more than 120 allowed
requests per minute. It must be the first active valid custom rule so an
earlier bypass cannot skip it. The whole path is required because a marker or
query condition could be omitted while still spending a Vercel invocation.
The workflow fails before deploy if this proof is absent or its schema drifts.
Do not silently replace an existing higher-priority rule. Without that
verified platform rule, the trusted client and server Production source
defaults must remain false. While those defaults are off, the same workflow
performs a non-blocking read-only readiness probe so a later live-sync rollout
can be decided from the sanitized deployment log without changing firewall state.
The preflight parses exact literal defaults from all three source gates and
fails closed if a gate is renamed, duplicated, or changed to unknown syntax.

The rapid window normally detects a change within one 2.5-second interval
(2.25 to 2.75 seconds with jitter). After a long unchanged period, the
free-tier backoff deliberately trades immediacy for cost and may take up to
66 seconds to detect the first unexpected change. Focus, visibility, and
connectivity recovery still force an immediate check.

Legacy v1 shares keep their last successfully encrypted snapshot when an
ordinary source-note edit cannot be synchronized or the owner-wrapped key is
not recoverable. Anonymous reads still require an active owner and source
note, a non-revoked unexpired share, and the existing password metadata.
Owner content/generation writes remain bound to the current source revision.
The corresponding Firestore Rules must be deployed before the Vercel client
change; otherwise a revision-drifted v1 snapshot remains unreadable even
though the client no longer revokes it. Current Vercel Blob attachments follow
the same lifecycle-only read rule. Legacy Firebase Storage-only attachments
are outside this rollout because Production Storage Rules are not changed.

Revision checks send a non-secret
`X-QuickMemo-Secure-Share-Revision: 1` marker and the last applied revision
ETag. The custom header forces a cross-origin browser request to preflight,
while the API independently requires `Sec-Fetch-Site: same-origin`, validates
an allowlisted `Origin` when one is present, and retains the bound session and
App Check controls. A normal same-origin GET may omit `Origin`.

A `304 Not Modified` response ends the cycle without a content download or
decryption. Only a changed revision causes the viewer to request the encrypted
content and decrypt the new revision in memory. The ETag is committed only
after the new ciphertext is validated, decrypted, and applied; a failed
content refresh therefore retries the same changed revision. The content key
remains in the URL fragment and is never included in the revision or content
request. Polling uses the existing server session and does not add a public
Firestore listener or permit direct client reads of v2 share documents.

A failed revision or content refresh keeps the last successfully decrypted
body visible and retries on a later polling opportunity; it must not replace
the body with partial ciphertext or persist decrypted content. A later
successful unchanged check clears only the transient delayed-check message,
not a prior content-updated announcement. The server continues to reject an
invalidated session after revoke, expiration, or policy change. On session or
policy invalidation, the viewer removes the stale body, reloads metadata, and
shows the current password, OTP, or login gate before another unlock attempt.
The same browser identity may trigger only one consecutive policy-bootstrap
restart; a second automatic 401 stops on a generic unavailable/login-refresh
state instead of causing an access-request loop. A successful content load or
an actual identity change resets that guard. It does not restore the removed
intermediate confirmation screen, and the fragment key remains browser-local.
Setting
`VITE_SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED=false` stops the owner
live-refresh path and viewer polling. Setting
`SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED=false` also makes both live-only API
actions fail closed. Either rollback preserves existing shares, sessions,
comments, and stored revisions.

Owner content updates keep the share ID, content key envelope, policy,
sessions, comments, and participants unchanged. They use payload-bound
idempotency plus expected content/source revisions and increment only
`contentRevision`. Exact replays return before throttling. A new update less
than 500 ms after the prior committed `contentUpdatedAt` receives `429` with a
bounded `Retry-After`; this uses the share write already required for the
content update and does not create another Firestore rate-bucket write. If a
newer source revision loses a content CAS race, the owner client forces one
owner-details refresh and makes at most one rebased CAS attempt. A second
conflict, an older target source revision, or an inconsistent refresh stops
and waits for the next note save.

## Password boundary

The access password is a server gate, not the encryption key.

- Length: 8 to 128 Unicode characters.
- The value is not trimmed, lower-cased, or normalized before hashing.
- The server uses a versioned `scrypt` record with a random salt and a
  server-only pepper.
- Only the record is stored in `publicSharePolicies`; the password is never
  stored or returned.
- Password reset increments `policyVersion` and invalidates existing sessions.
- Content does not need to be re-encrypted when only the password changes.

The legacy v1 PBKDF2 behavior is retained only for existing v1 links.

## Email OTP

OTP codes are six digits generated by a cryptographically secure random
generator.

- Lifetime: 10 minutes.
- Maximum verification attempts: 5.
- Challenge resend cooldown: 60 seconds.
- A new challenge invalidates an older challenge for the same share and email.
- Only an HMAC digest of the code is stored.
- Public send responses are generic, whether or not an address is allowed.
- A disallowed address is never sent an email.
- Raw addresses are never written to audit logs or viewer responses.

The browser reuses one `clientRequestId` for a logical send attempt. The server
HMACs that identifier and atomically reserves a challenge, delivery, quota,
and `publicShareEmailSendAttempts` record before invoking SMTP outside the
transaction. An exact replay returns the existing generic result without
calling `sendMail` again. A new challenge receives a new OTP and invalidates
the previous code. The stored send-attempt and delivery documents contain only
digests and bounded state; they never contain the raw address, OTP, or SMTP
credentials.

Eligible and suppressed requests return the same `202` shape. An independent
2.8–3.2 second response envelope supplies the email adapter only the remaining
time inside that envelope (up to 2.5 seconds). A provider timeout after SMTP
DATA is ambiguous: it is not automatically retried, the reservation moves to
the ambiguous counter, and the user may request a new challenge only after the
cooldown. The OTP value and allowlist result never determine the response
delay. Provider failure remains fail closed and never downgrades the policy.

### Client-side invitation draft

For an `allowed_emails` share, the owner UI requests the operating system's
default mail composer after a share is activated. Editing an existing share
does this only for newly added normalized recipients. The owner management
dialog also provides an explicit `초대 메일 작성` retry action. One recipient
is placed in `To`; two or more recipients are placed only in `Bcc` so the
addresses are not disclosed to one another.

This is a client-only `mailto:` handoff, not a QuickMemo invitation-delivery
API. The composer accepts only a canonical same-origin Secure Share URL whose
parsed share ID matches the selected share. Its fixed plain-text subject and
body contain the full encrypted-share URL, but never the note title, body,
attachments, password, OTP, or other user-controlled HTML. The mail-compose
path does not fetch, persist, or log that URL, and the URL/content key is never
sent to the QuickMemo server by this handoff. The selected mail application,
mail provider, and eventual recipients necessarily receive the full link, so
the owner must review the recipients before sending it.

A composer request is not proof that the message was sent or delivered. The UI
therefore asks the owner to confirm and send in the mail application and keeps
`URL 복사` as a fallback. A missing mail handler, rejected external-protocol
request, oversized `mailto:` URL, or other composer failure never rolls back,
revokes, or weakens the already committed share policy. Recipient lists used
for the retry button are held only in the current unlocked owner lifecycle and
are cleared on account/key changes.

Opening the shared URL still shows the normal email field and explicit OTP send
action. Page load, link preview, crawler access, and mail-provider prefetch must
never request an OTP automatically.

### Managed SMTP provider

Production accepts only `SHARE_EMAIL_PROVIDER=gmail_smtp`. Nodemailer and the
SMTP adapter stay inside the server API boundary and must not enter a browser
bundle. The provider ID and health-document path retain their legacy Gmail
names for data compatibility. Administrator-managed transport is restricted to:

- `smtp.gmail.com` on port 465 with implicit TLS, or port 587 with mandatory
  STARTTLS,
- `smtp-mail.outlook.com` on port 587 with mandatory STARTTLS, or
- `smtp.office365.com` on port 587 with mandatory STARTTLS.

Every profile uses:

- certificate verification enabled and TLS 1.2 or newer,
- `pool=false`, `logger=false`, and `debug=false`,
- file and URL access disabled,
- exactly one recipient and no attachments.

An administrator may select only those exact host/port/TLS profiles. Arbitrary
hosts, IP literals, private or metadata endpoints, port 25, plaintext SMTP,
disabled certificate verification, opportunistic downgrade, and automatic
465-to-587 fallback are prohibited. This allowlist prevents the settings API
from becoming an SSRF or port-scanning primitive.

For Gmail, use two-step verification and a Google-generated app password.
The authenticated username may be either `@gmail.com` or a complete Google
Workspace address such as a school domain; Workspace policy must permit app
passwords. For Outlook.com and Microsoft 365, password-based SMTP is a
compatibility path only: Microsoft may require Modern Auth or disable SMTP
AUTH for the account or tenant. An administrator stages the account and
password/app password through the in-app email settings page. The server
encrypts the credential before storing it and never returns it to the browser.
It is never a `VITE_` value, CLI argument, log field, committed example, or
Vercel API mutation. The authenticated username, From, and SMTP envelope sender
must resolve to the same normalized address. The display name is exactly
`QuickMemo`. `quickmemo-tan.vercel.app` is the application and share origin,
not a mail domain or From alias.

The fixed subject is `QuickMemo 공유 노트 인증번호`. The plain-text body contains
only the six-digit code, its ten-minute lifetime, the ignore-if-unrequested
notice, and `https://quickmemo-tan.vercel.app`. It contains no OTP link, note
title, note body, attachment, recipient list, or user-controlled HTML.

The legacy Resend adapter is reachable only under `NODE_ENV=test` as a
local/CI compatibility mock. It is not a Production provider, fallback, or
automatic migration path.

### Administrator-managed SMTP settings

`POST /api/admin-email-settings` accepts only JSON and the explicit actions
`status`, `stage`, `send-test`, `confirm-test`, `disable`,
`discard-pending`, and `remove`. Every request requires:

- the exact configured same-origin `Origin` and same-site fetch context,
- a Firebase Bearer ID token validated by Identity Toolkit,
- a currently active server-side administrator profile,
- Firebase App Check according to the existing global
  `off`/`monitor`/`enforce` policy (a valid token is mandatory in `enforce`),
  and
- the dedicated admin-email-settings request marker.

Mutations additionally require an `auth_time` no older than five minutes and
an idempotency key, and consume a preconditioned, distributed Firestore rate
bucket. The read-only `status` action does not force a fresh sign-in. The
server writes a bounded redacted audit event containing the actor UID, action,
generation, result, request ID, and retention timestamps only. It never
writes the SMTP account, password, test code, message text, or raw SMTP
response to audit or rate-limit state.

An admin idempotency key is replayable only for the same unexpired canonical
request. A server-secret HMAC binds it to the actor UID, action, and the
normalized action payload: staged host, port, TLS mode and credentials, test
generation, confirmation code, or removal target/generation as applicable. Firestore
stores only that fixed-length digest, never the raw credential or code. A
malformed or expired record, or reuse of the key with a different actor,
action, or payload, fails with `409 conflict`; the administrator must retry
with a new idempotency key.

Every successful action returns the same bounded
`{ ok, settings: { enabled, active, pending }, requestId }` contract.
`settings.enabled` is the effective no-cache runtime readiness, not merely the
stored enable intent: a confirmed `active` slot can therefore be present while
`enabled` remains false when the independent Vercel master switch is off.

The server-only
`SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1` value is a canonical base64url
encoding of exactly 32 random bytes. It is configured once as a protected
Production environment secret and must not be a `VITE_` value. Each credential
slot is encrypted with AES-256-GCM using a fresh 96-bit nonce. The authenticated
additional data binds the ciphertext version to the Firebase project ID, slot
(`pending` or `active`), and random generation. Existing fixed-Gmail version 1
ciphertexts remain readable without reinterpretation; new managed SMTP slots
use version 2. Moving either version between projects, slots, or generations
therefore fails authentication.

`secureShareEmailSettings/current` contains separate `pending` and `active`
slots. Client responses contain only presence, generation, bounded timestamps,
attempt counts, selected non-secret host/port/TLS mode, and masked addresses.
`stage` validates an allowlisted transport, a normalized email account, a
bounded password/app password with no control characters, and an optional
Reply-To, then calls `transporter.verify()`. For Gmail only, the common
four-groups-of-four display form of an app password has its three ASCII spaces
removed. Other passwords are preserved exactly. A stage or verify failure
never replaces the active slot.

`send-test` sends exactly one message to the pending SMTP account itself and
stores only an HMAC of its six-digit code. `confirm-test` accepts that code
only for the same pending generation and therefore verifies access to the
configured mailbox before promotion. It uses an
update-time/generation compare-and-set, a ten-minute expiry, and a five-attempt
limit before re-encrypting the pending credential for the active slot. The
provider-health record is reset and bound to that exact active generation.
Runtime sending rejects missing or mismatched health generations.

Admin test messages reserve and finalize the same global Gmail minute, hour,
rolling-24-hour, and monthly counters as public OTP delivery. A pending
generation permits at most five test messages with a minimum 60-second resend
cooldown. A concurrent `sending` state and any ambiguous SMTP delivery block
another send. Definite failures count against the minute/hour burst guard;
ambiguous delivery counts conservatively against every delivery cap.
Finalization clears the pending quota references atomically. If a process
stops after reservation, an authorized `stage`, `discard-pending`, or pending
`remove` request can recover the reservation only after its bounded test
deadline. Recovery uses the settings update-time precondition to atomically
convert all three reserved quota buckets to ambiguous, clear the reservation
references, and write a redacted recovery audit. A still-live deadline remains
blocked, the confirmed active slot is preserved, and a racing SMTP finalizer
and recovery cannot both account the reservation. The 24-hour cleanup remains
a safety backstop and performs the same conservative accounting before
removing only an expired pending slot.

`disable` keeps the encrypted active slot for a reversible rollback while
turning off effective delivery. `discard-pending` removes only the staged
slot. `remove` can delete the active, pending, or both slots; deleting active
also disables delivery and deletes its provider-health state.
An in-flight pending test cannot be replaced, discarded, or removed before
its deadline.
Unconfirmed pending credentials expire after 24 hours; the active slot is
never automatically deleted.

The Firestore settings, audit, admin rate-limit, and idempotency collections
are explicitly unreadable and unwritable from client Rules. Only the
server-side REST context can access them.
The existing bounded cleanup cron removes expired admin idempotency, rate, and
audit records. No Firebase TTL or additional paid service is required.

Effective email delivery requires both the active, confirmed Firestore slot
and the independent Vercel master kill switch
`SECURE_SHARE_EMAIL_ENABLED=true`. The admin test flow remains usable while
the master switch is false, but public email policies stay fail closed. This
allows a credential to be verified before activation and makes changing the
master flag to false an immediate rollback. Missing/corrupt settings, a
missing encryption key, failed decryption, missing prerequisites, or
Firestore uncertainty disables only email; Core link/password sharing remains
available.

### Provider health

`publicShareEmailProviderHealth/gmail-smtp` is server-only and stores only the
active settings generation plus a
bounded status (`unknown`, `healthy`, `degraded`, or `blocked`), timestamps,
failure count, `blockedUntil`, and a redacted reason code. It never stores a
Gmail address, app password, recipient, OTP, message body, session token, or
raw SMTP response.

Run `transporter.verify()` during the non-interactive Production preflight and
post-deploy smoke, not before every OTP. Runtime `sendMail` results update
health: success recovers health, an authentication failure blocks sending, and
temporary/rate/quota failures set a bounded degraded or blocked interval.
While blocked, email OTP fails closed without bypassing email verification or
switching providers. User responses and logs do not expose the Gmail or SMTP
failure detail.

An SMTP request that began under an older credential generation cannot update
provider health after a rotation. Health finalization re-reads the record,
requires the existing generation to match the send's generation, and uses an
update-time precondition. A late result is ignored after rotation, and a
deleted health record is never recreated by an in-flight request.

### Email quota guard

QuickMemo deliberately stays far below any Gmail account maximum:

- rolling 24 hours: soft 20, hard 30,
- Asia/Seoul calendar month: soft 500, hard 700,
- global burst: 3 SMTP attempts per minute and 20 per hour.

The corresponding environment values may lower these limits but may not raise
them. An upward override fails closed instead of silently expanding the cap.
Conservative hourly shards enforce the rolling windows, and the KST month key
changes at 00:00 Asia/Seoul. The share-and-email 10-per-24-hour guard commits
its current shard together with a preconditioned previous-shard boundary lock,
so concurrent requests cannot cross an hour boundary unnoticed. Reservation
checks include in-flight and ambiguous outcomes so concurrent requests cannot
cross a hard stop. A definite failure moves the reservation to `failedCount`;
an uncertain post-DATA outcome moves it to `ambiguousCount`. Definite failures
do not consume the rolling-delivery or monthly-delivery caps, but the global
minute/hour SMTP-attempt guard is never refunded merely because Gmail later
rejects or times out.

Minute quota buckets are retained for 72 hours, longer than the 48-hour
delivery and send-attempt reservation lifetime. Cleanup therefore cannot
remove a minute bucket in the boundary seconds before its final reserved
delivery becomes eligible for atomic reconciliation. Every expired quota
bucket is also re-read and deleted with an update-time precondition only when
`reservedCount` is exactly zero, so a delayed or backlogged reservation keeps
all accounting buckets intact.

Challenge, send-attempt, delivery, and the current quota buckets commit
together before the single SMTP call. SMTP is never called inside a Firestore
transaction retry. Finalization decreases `reservedCount` exactly once and
increments exactly one outcome counter. Expired challenges, send attempts,
rate buckets, quota buckets, and stale reserved deliveries are reconciled by
the existing bounded Vercel Cron cleanup; clients cannot read or write any of
these collections.

### Staged activation and free-operation boundary

The committed default remains `SECURE_SHARE_EMAIL_ENABLED=false`. Code,
Rules, and disabled Production deployment may ship without Gmail credentials,
but effective delivery must not become active until all pre-activation checks
pass on the exact CI-green Production SHA:

1. The dedicated Gmail account, two-step verification, app password, exact
   From match, port 465 TLS, and provider health are verified without printing
   values.
2. Actual receipt is proven either by the in-app administrator flow
   (`stage` → `send-test` to that same Gmail account → six-digit
   `confirm-test` for the same generation) or by an automated smoke mailbox API
   or read-only IMAP credential that confirms subject, freshness, and OTP
   extraction. SMTP `verify()` or an accepted response alone is insufficient.
3. Static, unit, Rules, quota, concurrency, and cleanup checks pass without
   using a real user note.

After receipt confirmation, an operator may enable the independent Vercel
master switch. Immediately run a synthetic public-share smoke covering wrong
code, correct code, reuse, expiry, resend, quota, revoke, and cleanup. If that
post-activation smoke, provider health, or quota state is uncertain, turn the
master switch off again. Synthetic shares, challenges, isolated attempts,
mailbox test messages where supported, and temporary accounts are removed or
verified under bounded retention. Never decrement or zero a shared usage
bucket to erase a real smoke send; that minimal usage remains part of quota
accounting.

If neither the in-app six-digit confirmation nor automated mailbox evidence
is available, keep the flag false and report email activation as blocked.
Core v2 remains active and is never downgraded.

Personal Gmail SMTP is for personal, non-commercial, low-volume beta operation
only. QuickMemo never purchases a plan, connects billing, raises its caps,
or switches providers automatically. Increased usage requires a separate
review and a manual migration to a transactional email provider.

## One-time semantics

`oneTimeScope` is fixed to `global`.

The link is consumed only by an explicit successful access POST after every
required password, email, and login condition passes. Metadata, HEAD,
prefetch, link previews, failed credentials, owner preview, and health checks
do not consume the link.

The access commit atomically records:

- consumption state,
- the idempotency attempt digest,
- the identity digest,
- the access session digest,
- the unlock grant.

The client reuses one `unlockAttemptId` while retrying. The server combines it
with the share and identity through a server HMAC. A matching retry can be
accepted during the two-minute grace period; another identity or attempt is
rejected.

## Expiration

Preset expiration is calculated from server time:

- one hour,
- one day,
- seven days,
- custom.

Custom expiration must be at least five minutes and at most 365 days from the
server clock. Values are stored in UTC and displayed in the viewer's local
time zone. Cleanup is retention only; every API request synchronously checks
status and expiration.

## Permissions

`permissionLevel` is one of:

- `view`
- `comment`
- `save_copy`

The values are mutually exclusive. Attachment download is a separate
capability.

Comments are plain text, 1 to 2,000 characters. HTML is not accepted. Author
badges are derived from the server session, never from client-supplied role or
email fields. A client-generated request ID is HMAC-bound to the share and
session identity, so a retry of the same body returns the existing comment
instead of creating a duplicate. Control, bidi, and zero-width format
characters used for spoofing are rejected. Successful creation is prepended
locally and deletion removes the local row without refetching the whole page.

### Comment participants and partial network display

Participant numbers are allocated only after every share access gate succeeds.
Metadata, `HEAD`, crawlers, failed passwords or OTPs, owner preview, expired
shares, and revoked shares do not allocate a participant. Within one share the
identity priority is owner, active QuickMemo UID, verified email, then an
anonymous share-scoped random cookie. IP addresses are never an identity key.
The anonymous cookie is `HttpOnly`, `Secure` in Production, `SameSite=Lax`,
and scoped to the Secure Share API path; its value is not exposed to
JavaScript or persisted in web storage. Each newly issued cookie contains a
CSPRNG nonce and a domain-separated server signature. The original browser
binding and access-attempt ID derive only its idempotent issuance identity, so
parallel retries converge while a later browser-binding rotation does not
invalidate the longer-lived participant cookie. When participant identity is
enabled, unsigned or pre-v2 participant-cookie formats fail closed; with the
flag disabled, existing Secure Share v1/v2 behavior is unchanged.

The first successful comment-capable access receives `guest1`, then `guest2`,
without number reuse. Allocation uses one Firestore transaction across the
share/policy snapshot, participant, and per-share counter. Repeated or
concurrent access by the same identity converges on one participant. At the
configured cap a new viewer can still read the share but cannot comment;
existing participants continue to work. Comment pages are capped at 20 and
hydrate current participant names through one bounded batch read, not one read
per comment.

A participant may rename only itself. Names are NFKC-normalized and compared
case-insensitively per share, contain 1–24 graphemes, and accept Korean,
English, Japanese, numbers, spaces, `.`, `_`, and `-`. Control, bidi,
zero-width, HTML/URL-like, excessive combining, `guestN`, owner/admin/system,
localized owner/official markers, and QuickMemo-impersonation forms are
rejected. A persistent name registry
enforces uniqueness. Rename requests use an HMAC-bound `clientRequestId`,
60-second cooldown, three-per-hour and ten-per-day limits, `Retry-After`, and
an audit event; exact retries are idempotent. Separate identity and
share-network attempt buckets bound invalid, unavailable, and otherwise failed
rename requests before they can repeatedly enter the rename transaction.

When every network-display gate is enabled, a new comment may store only a
derived public prefix snapshot: the first two IPv4 octets such as `203.226`,
or the first two normalized IPv6 groups. IPv4-mapped IPv6 is normalized to the
IPv4 rule. Malformed, private, loopback, link-local, multicast, documentation,
benchmark, and other non-public ranges yield no prefix. Production accepts
only Vercel's managed forwarding header; arbitrary forwarded headers and
multi-hop values are ignored. Full IP values are never stored, returned,
logged, placed in DOM attributes or accessibility text, or used for
participant identity. Disabling either the server flag or owner policy omits
the prefix from API responses, including older comment snapshots.

Save-copy requires both a valid share session and an active, non-anonymous
QuickMemo login. Decryption and re-encryption stay in the browser. The content
key is never sent to the server. A copy uses a new note key and independent
attachment objects; comments and audit events are not copied.

Copy-grant issuance is persistently idempotent. The browser keeps one stable
request ID for the copy attempt, while the server stores only a deterministic
HMAC-bound request document in `publicShareCopyGrantRequests`. An exact retry
under the same user, share, policy, and session returns the original signed
grant and exact token expiration without repeating attachment quota work,
rate-limit consumption, or audit creation.

New issuance or renewal reads the share, policy, request document, and current
minute rate bucket in one Firestore read-write transaction. The request,
single rate increment, and deterministic audit event commit atomically.
Concurrent retries therefore converge on one grant. A grant that has expired,
has at most 15 seconds remaining, or belongs to an older valid session/policy
is renewed in the same request document with a higher issuance generation.
Malformed or cross-bound request state fails closed. The signed grant expires
within five minutes and never later than its share or session. A lost commit
response is recovered by rereading the request document; the attachment
download path still validates only the signed grant, current user, session,
and policy and does not read the idempotency document.

## Download and quick-copy limits

When download is disabled:

- the viewer does not show a Download action,
- the direct download API denies the request,
- raw Vercel Blob and Firebase Storage URLs are never returned,
- only allow-listed previews up to the existing 25 MB preview limit are
  proxied inline,
- non-previewable files show metadata only.

This is not DRM. It does not prevent screenshots, camera capture, browser
caching, developer tools, or manual copying of rendered content.

Hiding the body quick-copy button removes QuickMemo's convenience control. It
does not prevent text selection or operating-system copy commands.

## Server-only data

The following collections are denied to every Firebase client by Security
Rules and are accessed only by the server:

- `publicSharePolicies`
- `publicShareRecipients`
- `publicShareAccessSessions`
- `publicShareEmailChallenges`
- `publicShareEmailQuotaBuckets`
- `publicShareEmailDeliveries`
- `publicShareCopyGrantRequests`
- `publicShareSourceGuards`
- `publicShareUnlockGrants`
- `publicShareRateLimits`
- `publicShareComments`
- `publicShareAuditEvents`
- `publicShareParticipants`
- `publicShareParticipantNames`
- `publicShareParticipantRenameRequests`
- `publicShareParticipantCounters`

`publicNoteShares/{shareId}` retains the encrypted content and owner metadata.
For `schemaVersion: 2`, public client reads are denied. Owner display remains
limited to owner-authenticated management flow, and every policy mutation is
server-authorized. Direct client create, update, delete, and schema downgrade
are denied.

Session documents contain token and CSRF digests only. They never contain the
content key, password, OTP, raw email, raw IP, Firebase ID token, cookie, or
authorization header.

Participant documents contain only server-derived identity HMACs, an opaque
participant ID, assigned guest number, current/snapshot display names, bounded
rename counters, and timestamps. The separate name registry contains a
normalized-name HMAC and participant ID. Participant, registry, rename-request,
and counter documents have no independent expiry field; they are deleted only
with the share tree after the current share expiration is rechecked.

Email delivery documents contain only HMAC email identifiers, provider message
ID hashes, quota bucket IDs, lifecycle status, owner/share IDs, and timestamps.
They never store raw recipient addresses, OTP values, or provider credentials.
Delivery idempotency records expire after 48 hours. Daily quota buckets remain
until 45 days after the next UTC day and monthly buckets until 400 days after
the next UTC month so operational reconciliation remains possible. The
authenticated cleanup route deletes expired records in bounded daily batches;
email delivery records receive a dedicated maximum 200-document drain before
the shared retention queues, which is above the app's 80-message daily hard
limit while remaining inside the global cleanup delete/runtime budget.
managed-user deletion removes owner-scoped delivery records but never deletes
the global quota buckets.

Copy-grant request documents are server-only and retain the signed grant,
HMAC request/token identifiers, owner/requester IDs, policy/session binding,
issuance generation, and timestamps. They never store the raw client request
ID, content key, decrypted note data, cookie, Firebase ID token, or CSRF token.
They expire 24 hours after the grant and are removed by expiration cleanup,
share-tree cleanup, owner deletion, or requester-account deletion.

Source-share guard documents use a deterministic server HMAC of the owner UID
and source note ID. They contain no content key or plaintext note data and are
never readable or writable by Firebase clients. Share creation reads the
source note, guard, and the complete bounded source history in one Firestore
transaction. Only an unexpired `pending` or `active` share blocks creation;
`consumed`, `revoked`, expired, or orphaned stale guards are replaced. Revoke
and one-time consumption remove a guard only when it still points to that same
share. Expiration cleanup and managed-user deletion also remove remaining
owner-scoped guards.

## Session and request security

- Session tokens use at least 32 random bytes.
- The browser receives the token only through an `HttpOnly`, `Secure`
  Production cookie with `SameSite=Lax`.
- Cookie names are isolated per share with a server HMAC suffix.
- Every request compares the session and current share `policyVersion`.
- Revoke and policy changes immediately invalidate old sessions.
- Mutation requests require an exact same-origin check and an in-memory CSRF
  value in `X-CSRF-Token`.
- Request methods, content type, size, and allowed JSON fields are checked.
- Responses use `no-store`, `no-referrer`, `nosniff`, same-origin resource
  policy, and generic public errors.
- CORS wildcard and arbitrary Origin reflection are not used.

App Check is defense in depth and never replaces share authorization. Use
`FIREBASE_APP_CHECK_ENFORCEMENT=monitor` before `enforce`; Production
enforcement also requires the verified project number.

## Attachments

V2 attachment preview and download use the session-aware share API. The
legacy `scope=publicShare` Blob GET and Firebase Storage public fallback reject
v2 before streaming.

The server checks:

- session, status, expiration, and policy version,
- current attachment generation,
- attachment ownership by the share,
- preview extension/MIME allow list and size,
- `downloadAllowed`.

Private ciphertext is streamed. Raw storage URLs are not returned. The
existing 150 MB attachment limit, 25 MB preview limit, encrypted filename,
AES-GCM/AES-GCM-CHUNKED metadata, source revision binding, and quota policy
remain in force.

Production does not provision Firebase Storage. New uploads use private Vercel
Blob objects, and the Firebase Storage legacy fallback is disabled unless the
explicit client/server legacy flags are both intentionally enabled. Merely
having a legacy `storagePath` does not initialize or contact an unprovisioned
bucket.

## Free-tier storage guard

`FREE_TIER_MODE=true` enables a server-only global counter at
`systemUsage/blobAttachmentsV1`. Every pending reservation and ready Vercel
Blob attachment counts toward `usedBytes`; upload reservation and the global
counter update share the same Firestore commit and update-time preconditions.
Deletion releases bytes and count at the same idempotent metadata claim.

The default policy uses the official 1,000,000,000-byte included capacity,
warns at 65%, raises the admin warning at 75%, and stops new uploads at the
more conservative 800,000,000-byte operational cap. Existing reads, deletes,
and cleanup remain available. Values are configured once through the
`BLOB_STORAGE_*` server variables rather than duplicated across routes.
If a smaller official allowance creates a distinct 80–85% restricted band,
new uploads above `BLOB_STORAGE_RESTRICTED_UPLOAD_MAX_BYTES` (25,000,000 bytes
by default) are rejected while smaller cleanup-friendly operations remain
available.

Before enabling free-tier mode, reconcile Vercel Blob store totals against
Firestore attachment metadata and seed the server-only counter with the exact
byte and object totals. Missing or malformed counter state blocks new uploads
instead of assuming zero. The app estimate is an operational guard, not a
replacement for the Vercel Usage dashboard.

## Save-copy durability

A saved copy is created as an owner-only personal Note with
`secureShareCopyState=copying`. Normal and deleted-note subscriptions filter
`copying` and `aborted`, so partial copies are not shown as usable Notes.

The attachment API binds every reservation to the copy job ID and atomically
maintains reserved and ready counts on the Note. The client can transition the
Note to `active` only when both server-maintained counts equal the immutable
expected count. This transition is a Firestore transaction and does not weaken
the existing revision-1 create history.

Before activation, failure or cancellation deletes known attachments and
writes an audited revision-2 `aborted` soft delete only after the ready count
reaches zero. A process exit can bypass that in-memory compensation, so the
authenticated client reaper scans owner-scoped jobs and the cleanup Cron
independently scans a bounded global batch of `copying` jobs that have had no
server heartbeat for 24 hours. Both retry activation for fully ready jobs and
otherwise retry attachment cleanup before the audited abort. The Cron validates
the personal-note owner, participant set, copy job ID, attachment owner, and
server-maintained counters. Before any activation, attachment deletion, or
abort, it atomically records a deterministic server-only cleanup claim using
the stale Note's exact Firestore update time. Blob reservation, ready, and
user-delete paths fail closed while that claim exists. A fresh heartbeat or
resumed upload that wins first changes the update time, so the claim fails and
the job is retained without deleting its attachments. A Cron retry resumes only
the exact claim for the same Note, copy job, and revision; successful activation
or audited abort removes the claim. Malformed claims are retained for manual
repair. Ambiguous or racing transitions retain the job for a later recovery
pass instead of overwriting the newer state.

The browser processes at most three copy attachments concurrently. The first
failure aborts sibling download/upload work, waits for in-flight tasks to
settle, and compensates completed attachments in reverse source order.
The same `AbortSignal` is carried from encrypted copy download through Vercel
Blob upload and completion; an upload reservation that loses the cancellation
race is released with a non-aborted cleanup request.

## Owner management pagination

The owner management view requests 20 summaries at a time through the existing
server cursor and loads later pages only when the owner activates the
accessible `더 보기` control. It does not fetch 1,000 shares on mount. Cursor
results are merged by share ID and stale account responses are ignored.
Create and source mutation use a separate `ownerUid + sourceNoteId`
equality-only query. The owner predicate is enforced in Firestore as well as
after decoding, so another tenant cannot consume this history bound. That mode
does not accept a cursor, reads at most 101 documents, filters
owner/schema/status again on the server, and returns `nextCursor: null` only
when the complete owner-scoped history is at most 100 documents. More than 100
matching documents fails closed until retention cleanup or operator repair
restores a bounded complete history.

## Rate limits

Default server-side buckets:

- password: share and IP, 5 attempts per 15 minutes; IP, 20 per hour,
- OTP send: share and email, 3 per 15 minutes and a conservative hourly-sharded
  10 per rolling 24 hours; IP, 20 per hour; share total, 20 per hour,
- SMTP attempts: 3 globally per minute and 20 per hour, plus the
  rolling-24-hour and KST-month hard stops described above,
- OTP verify: 5 per challenge,
- comments: session and share, 5 per minute and 50 per day,
- copy grant: session, 3 per minute,
- owner content update: one newly committed share revision per 500 ms, derived
  from the transaction-checked share `contentUpdatedAt` after exact replay
  detection,
- share create: owner, 20 per hour and 100 per day.

Successful password checks release only the current request's password-failure
reservations. Failed checks keep both the share-and-network and global-network
reservations.

Rate-limit identifiers are HMAC digests. Raw IP and raw email values are not
stored. A `429` response includes a bounded `Retry-After` value without
revealing counters.

## Environment variables

The repository's `.env.example` lists variable names and non-secret safety
defaults only. Secret values belong in the approved Vercel Production secret
workflow.

Never use a `VITE_` prefix for a password pepper, session/cookie/CSRF/OTP/email
or rate-limit HMAC key, the email-settings encryption key, a Gmail/IMAP
credential, or a mailbox address.

Core requires distinct server-only values for `SHARE_PASSWORD_PEPPER`,
`SHARE_SESSION_HMAC_KEY`, `SHARE_COOKIE_NAME_HMAC_KEY`,
`SHARE_CSRF_HMAC_KEY`, and `SHARE_RATE_LIMIT_HMAC_KEY`, plus an exact
`SECURE_SHARE_ALLOWED_ORIGINS` allowlist. `SHARE_OTP_HMAC_KEY`,
`SHARE_EMAIL_HMAC_KEY`, and `SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1` are
email-only while `SECURE_SHARE_EMAIL_ENABLED=false`. `CRON_SECRET` is separate
from both groups. Generate every application HMAC/pepper independently from at
least 32 random bytes (48–64 recommended). The encryption key is the canonical
base64url encoding of exactly 32 random bytes. Configure those application
secrets through stdin or an equivalent non-logging Vercel workflow, and report
only whether each variable exists.

Do not copy an SMTP account, password/app password, From, or Reply-To into
Vercel Production environment variables. Enter them only in the administrator
email settings page. The server accepts only the three reviewed Gmail,
Outlook.com, and Microsoft 365 profiles above, requires their matching TLS
mode, normalizes the address, verifies the transport, and encrypts the pending
slot before it is stored. The `SHARE_SMTP_*`, `SHARE_EMAIL_FROM*`, and
`SHARE_EMAIL_REPLY_TO` names in `.env.example` exist only for local/CI
compatibility tests and remain empty in Production.

Comment participant identity additionally requires a distinct server-only
`SHARE_PARTICIPANT_HMAC_KEY` of at least 32 random bytes. Keep
`SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED=false` and
`SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED=false` until that secret and the
comment/rename Production smoke are verified. Neither flag nor secret uses a
`VITE_` prefix. Prefix hashing uses `SHARE_RATE_LIMIT_HMAC_KEY`; activation
fails closed if that key is shorter than 32 bytes or reuses the password
pepper or session HMAC key.

Email readiness additionally requires all of the following:

- exact `SECURE_SHARE_V2_ENABLED=true`
- exact `SECURE_SHARE_EMAIL_ENABLED=true` as the independent Vercel master
  switch, enabled only after the in-app receipt confirmation below
- the protected `SHARE_EMAIL_SETTINGS_ENCRYPTION_KEY_V1` secret
- distinct `SHARE_OTP_HMAC_KEY`, `SHARE_EMAIL_HMAC_KEY`, and
  `SHARE_RATE_LIMIT_HMAC_KEY` values of at least 32 bytes, with no reuse of
  password/session/cookie/CSRF/participant secrets
- a schema-valid `secureShareEmailSettings/current` document whose stored
  enable intent is true and whose confirmed `active` slot decrypts and
  authenticates for the current project, slot, and generation
- an active slot that resolves to one allowlisted host/port/TLS profile, the
  same normalized SMTP username/From/envelope sender, display name `QuickMemo`,
  and exact free-tier mode
- rolling-24-hour 20/30, KST-month 500/700, and global 3/minute and 20/hour
  caps, or reviewed lower values
- actual receipt proven by `stage` → `send-test` to the staged SMTP address →
  six-digit `confirm-test` for the same generation; an approved automated
  mailbox API or read-only IMAP smoke is optional

The committed example deliberately keeps `SECURE_SHARE_EMAIL_ENABLED=false`
and all raw credential values empty. A confirmed active slot may exist safely
while that switch is false. Do not enable email merely because the
configuration parser or `transporter.verify()` succeeds.

The client behavior flags have non-secret defaults:

- `VITE_READONLY_NOTE_RENDERER_V2_ENABLED=false`
- `VITE_SECURE_SHARE_DIRECT_ENTRY_ENABLED=false`
- `VITE_UNIFIED_SELECT_UI_ENABLED=false`
- `VITE_SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED=false`
- `SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED=false`

The guarded Stage 0 deployment hard-locked all new Production surfaces off in
source. The renderer, direct entry, and unified select defaults were then
enabled in individual guarded source commits and Production deployments. Live
sync was enabled only after the WAF preflight succeeded, with the client,
Secure Share API, and Blob API source locks changed together. Exact lower-case
`false` remains the intentional rollback after each source-enable commit.
Record the resulting deployment SHA, and do not treat a mixed old/new browser
bundle as proof that the flag changed.

Changing a Vercel environment variable requires a new Production deployment
before runtime behavior changes.

## Local validation

Run:

```bash
npm run security:functions-guard
npm run security:gitignore-guard
npm run lint
npm run typecheck
npm test
npm run test:rules
npm run test:integration
npm run test:e2e
npm run build
npm audit
git diff --check
```

Rules tests require Java and the Firebase emulators. A skipped or unavailable
Rules suite is a release blocker.

Before activation, add an actual-browser test matrix covering v1 regression,
all access combinations, OTP delivery, one-time concurrency, refresh,
download bypass, attachment tampering, comments, save-copy cleanup, policy
change, revoke, expiry, 320/390 px mobile layout, dark mode, focus, console,
CSP, and secret-free network responses.

### Opt-in performance benchmark

Run the deterministic local benchmark separately from the default test suite:

```bash
npm run benchmark:secure-share
```

The command starts isolated Auth and Firestore emulators, runs 12 sequential
warm samples by default, and emits `SECURE_SHARE_PERFORMANCE_JSON` plus
`SECURE_SHARE_REACT_PROFILE_JSON`. Override the sample count with
`SECURE_SHARE_BENCHMARK_SAMPLES=5..18`; use
`SECURE_SHARE_BENCHMARK_MODE=legacy` when only the flags-off scenarios are
needed. The `.benchmark.ts` and `.benchmark.tsx` suffixes are not selected by
the default Vitest include pattern, and no latency threshold runs in default
CI.

The counters are emulator request-cost proxies, not Firebase billing exports.
A point document GET, including a missing document, is one read; `batchGet`
counts requested documents; query/list counts returned documents with a
minimum of one read. Writes count successful commit entries, while write
attempts also count entries in failed commits. HTTP 400/409 transaction commit
responses and rollback requests are reported separately.

The following raw result was recorded on 2026-07-29 KST. The flags-off current
rows run the participant and prefix flags as `false` on the feature worktree.
The flags-on rows run both flags as `true`. The pristine baseline used
`origin/master` SHA `1b0db91747b6f1cc05f4de88631c1adc3a400a05` with the same
benchmark harness.

| Worktree / flags | Operation | p50 ms | p95 ms | Reads | Writes | Write attempts | Transaction starts | Conflicts / rollbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| master baseline / off | Access | 25.28 | 49.97 | 10 | 6 | 6 | 0 | 0 / 0 |
| master baseline / off | Comment create | 22.62 | 33.55 | 11 | 5 | 5 | 1 | 0 / 0 |
| master baseline / off | Comment list, 20 | 12.43 | 39.83 | 25 | 0 | 0 | 0 | 0 / 0 |
| master baseline / off | Revoke | 12.78 | 15.68 | 4 | 3 | 3 | 0 | 0 / 0 |
| current / off | Access | 26.59 | 56.44 | 10 | 6 | 6 | 0 | 0 / 0 |
| current / off | Comment create | 24.36 | 34.57 | 11 | 5 | 5 | 1 | 0 / 0 |
| current / off | Comment list, 20 | 12.88 | 39.91 | 25 | 0 | 0 | 0 | 0 / 0 |
| current / off | Revoke | 12.80 | 15.31 | 4 | 3 | 3 | 0 | 0 / 0 |
| current / on | First participant access | 21.61 | 23.63 | 15 | 8 | 8 | 1 | 0 / 0 |
| current / on | Existing participant access | 17.80 | 18.87 | 11 | 6 | 6 | 0 | 0 / 0 |
| current / on | Participant comment create | 19.54 | 21.47 | 12 | 5 | 5 | 1 | 0 / 0 |
| current / on | Comment list, same participant 20 | 12.44 | 13.84 | 26 | 0 | 0 | 0 | 0 / 0 |
| current / on | Comment list, 20 participants | 12.94 | 15.00 | 45 | 0 | 0 | 0 | 0 / 0 |
| current / on | Participant rename | 17.64 | 30.29 | 14 | 6 | 6 | 1 | 0 / 0 |

Against the pristine flags-off baseline, the current flags-off p50/p95 changes
were Access `+5.2%/+12.9%`, comment create `+7.7%/+3.0%`, comment list
`+3.6%/+0.2%`, and revoke `+0.2%/-2.4%`. Firestore operation counts were
unchanged. One 20-comment page costs one bounded participant `batchGet`: the
same-author case adds one read and the all-distinct case adds 20, with no
per-comment request loop.

The paired jsdom React Profiler scenario rendered 20 comments, then renamed
their participant. It recorded 3 initial commits and 3 rename-response commits.
The rename caused no additional content decryption (`2` before and after), no
content refetch (`1` total), and no comment-page refetch (`1` total). Its
measured render duration is diagnostic only because jsdom timing is not a
browser performance result.

The same build reported these focused bundle changes:

| Asset | master raw / gzip kB | current raw / gzip kB | gzip change |
| --- | ---: | ---: | ---: |
| Secure Public Share Viewer | 29.02 / 9.08 | 37.45 / 11.09 | +2.01 kB |
| Secure Share service | 23.75 / 7.88 | 30.19 / 10.11 | +2.23 kB |
| CSS | 261.48 / 40.34 | 263.70 / 40.60 | +0.26 kB |

These warm local emulator results are reproducible regression evidence, but
they do not prove Production p95 latency or free-tier billing. Validate the
Production target separately with synthetic, non-sensitive smoke data and
Vercel/Firebase usage evidence before activation.

## Production rollout

1. Verify the exact GitHub repository, master SHA, Vercel Hobby usage,
   team/project/domain, Firebase Spark project, billing-disabled state, and
   rollback candidate.
2. Deploy the changed Firestore Rules to the explicitly verified Firebase
   project before the frontend so v1 last-good snapshots remain readable
   across source revision drift. Deploy only changed additive indexes when
   present and wait until each is READY; this release adds no index. Do not
   initialize or deploy Firebase Storage.
3. Keep Core server/client and email flags false. Set both legacy Storage flags
   false. After confirming `CRON_SECRET` has no external consumer, generate or
   rotate it together with the distinct Core secrets, exact origin, cleanup
   bounds, free-tier thresholds, and `FREE_TIER_MODE=true`. Batch-set them
   without printing values and retain the Cron value only in the current
   deployment process memory for the later one-time call.
4. Deploy the CI-green guarded master SHA. Until the global counter is seeded,
   new uploads and Save Copy must fail closed with reads/deletes still working.
   This short upload-maintenance window closes the seed/deploy race.
5. Confirm the guarded Production alias/SHA, allow pre-guard requests to drain,
   then obtain two matching Blob plus ready/pending metadata snapshots across a
   short quiet interval. Create `systemUsage/blobAttachmentsV1` with
   `schemaVersion=1`, `accountingMode=ready_and_pending_reservations`, and exact
   bytes/count using an `exists:false` CAS, then read it back. Never blind
   overwrite a mismatch.
6. Snapshot cleanup targets and Blob/metadata totals read-only. With the Cron
   value already active in this deployment, make exactly one authenticated
   POST, then unset the in-memory value.
   A 200 response with `skipped`, `deadlineReached`, or
   `legacyNoteBackfillFailed` is not a completed run. Inspect safe deployment
   logs before deciding whether any retry is warranted.
7. Reconcile Blob, ready/pending metadata, user usage, and the global counter
   again after cleanup. Stop on any mismatch rather than rewriting the counter.
8. Smoke legacy login, notes, autosave, v1 shares, attachments, dark mode,
   schedule, matrix, cleanup authentication, CSP, and 5xx behavior. Confirm
   official Vercel/Firebase usage remains inside the activation gate.
9. Enable only Core server/client, keep email and both participant flags false,
   redeploy the same master SHA, and run the legacy/Core regression smoke.
10. For the first guarded rollout, build one Production deployment with all
    four client rollback flags false and smoke the legacy-compatible paths.
    Enable and redeploy one surface at a time in this order: read-only
    renderer, direct entry, unified select UI, then live synchronization.
    After direct entry, verify link-only, password, OTP, login, one-time, and
    owner-preview paths. After live synchronization, verify changed and
    unchanged ETags, the visible 2.5-second rapid window and 15/30/60-second
    adaptive backoff, hidden/offline pause, focus/online/visible reset,
    bounded jitter, request deduplication, and transient-failure body
    retention. Each reviewed source-enable commit turns its Production default
    on when the environment value is absent, so an environment-driven canary
    that intends an enabled source flag to remain off must set exact `false`.
11. Inject `SHARE_PARTICIPANT_HMAC_KEY` through a non-logging server-only
    workflow, set participant identity and comment IP-prefix flags true, and
    redeploy that same master SHA. Run only synthetic participant allocation,
    rename, uniqueness, comment-prefix/policy-off, revoke, cleanup, mobile,
    accessibility, console, and network-response smoke. Remove every synthetic
    share/account created by the smoke.
12. Keep `SECURE_SHARE_EMAIL_ENABLED=false` while an administrator uses the
    in-app email settings page to stage an allowlisted SMTP profile, account and
    password/app password, send one test to that same mailbox, and confirm the
    received six-digit code for the same generation. An approved mailbox API or
    read-only mailbox check may automate this receipt proof but is not required.
    Enable the independent email flag and redeploy only after that confirmation
    and provider-health checks pass.
    Then run synthetic OTP wrong/correct/reuse/expiry/resend/quota checks and
    remove the synthetic data. Without either the in-app receipt confirmation
    or equivalent automated receipt evidence, leave the flag false.

Do not activate Core if an index is building, any P0/P1 issue remains, a
required check fails, the global counter is absent, or the rollback deployment
is unknown. An absent confirmed email-settings active slot blocks only email
sharing.

## Rollback

For an email-only incident, quota uncertainty, SMTP authentication change, or
mailbox-smoke failure, first set `SECURE_SHARE_EMAIL_ENABLED=false` and
redeploy the last CI-green SHA. Do not weaken an email policy, change it to
link-only, raise a quota, or enable a paid/fallback provider. Keep the
server-only Rules and accounting documents in place. Rotate the Gmail app
password only through the administrator email settings page when exposure is
suspected. Preserve the existing active slot until the replacement generation
passes `send-test` and in-app six-digit confirmation, or equivalent approved
automated receipt evidence. Re-enable email only after that proof and provider
health pass again.

If the issue is limited to automatic entry, first set
`VITE_SECURE_SHARE_DIRECT_ENTRY_ENABLED=false` and redeploy the same guarded
SHA. If the issue is live-update correctness, request volume, or polling,
set both `VITE_SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED=false` and
`SECURE_SHARE_LIVE_CONTENT_SYNC_ENABLED=false`, then redeploy. Confirm the
resulting bundle makes no revision polling request and that the live-only API
returns its generic disabled response. These rollbacks preserve Core v2
server authorization, share data, comments, sessions, and revisions; they
require no Firestore Rules or index rollback.

For a read-only formatting regression, set
`VITE_READONLY_NOTE_RENDERER_V2_ENABLED=false`; the sanitizer and renderer
budgets remain enforced. For a select-theme regression, set
`VITE_UNIFIED_SELECT_UI_ENABLED=false`; controls remain native accessible
selects with their caller-provided classes. Redeploy and verify the exact
Production source SHA after either build-time rollback.

If the issue remains outside those client behaviors, set
`VITE_SECURE_SHARE_V2_ENABLED=false`,
`SECURE_SHARE_V2_ENABLED=false`, `SECURE_SHARE_EMAIL_ENABLED=false`,
`SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED=false`, and
`SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED=false`, then redeploy the same guarded
SHA. Keep `FREE_TIER_MODE=true`, preserve the global and participant counters,
and do not delete participant/name state. This removes v2 UI and makes its API
fail closed without deleting user data or removing the v1 attachment guard.

Record the flags-off guarded deployment as the primary rollback candidate
before enabling Core. Only if the guarded SHA itself breaks compatibility
should the previously recorded pre-guard Vercel deployment be restored; that
exceptional rollback also removes the global upload guard and therefore
requires an upload maintenance window and close monitoring.

This release changes the v1 public-read rule from source-revision equality to
source lifecycle validation so a failed synchronization can serve only the
last successful encrypted snapshot. Owner writes remain revision-bound, and
v2 server-only collections remain denied. It changes no Storage configuration
and adds no index. Keep the reviewed Rules in place during feature rollback;
do not deploy older Rules merely to disable client behavior.

Do not delete v2 documents, comments, copied notes, or indexes as an emergency
rollback shortcut. Confirm login, notes, v1 share, attachments, and the
Production alias after rollback.
