# Zero-cost platform evidence — 2026-08-22

This is a point-in-time release check. It contains no account identifier,
credential, token, private project content, or decrypted Vault metadata.

- Firebase Console showed the QuickMemo project on **Spark**, described by the
  console as **free ($0/month)**. The check was read-only; no billing setting or
  plan was changed.
- The Vercel team API showed the production project team on **Hobby**. The
  check was read-only; no subscription or marketplace integration was changed.
- `scripts/security-no-billing-guard.mjs` rejects paid-provider SDKs, payment
  routes, billing configuration, Cloud Functions, and paid automatic fallback
  in the tracked application surface.
- QuickMemo must fail with an explicit quota/availability error when a free
  allowance is exhausted. It must never upgrade a plan or switch to a paid
  provider automatically.

Account plans are external state and can change independently of Git. Repeat
both read-only checks immediately before every production activation.
