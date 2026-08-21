# Vault assets and Canvas security boundary

- Vault assets use the same per-entry AES-GCM key, wrapped key, revision and
  encrypted history envelope as Markdown, Canvas and Base entries. No asset
  bytes, name or MIME type are written to a separate plaintext index.
- The current Firestore-backed `asset-v1` format accepts at most 350 KiB of raw
  bytes. This is an intentional envelope limit after base64, JSON, AES-GCM and
  history expansion. A larger ZIP asset fails the write-free import plan; it is
  never silently skipped or uploaded through another storage provider.
- ZIP export decodes only an authenticated `asset-v1` body and writes the exact
  original bytes and vault-relative path. Invalid payloads block export.
- Canvas embeds PNG, JPEG and WebP only when their signatures match the claimed
  MIME type. PDF requires a `%PDF-` signature and opens in a blob-backed empty
  sandbox. SVG, HTML and unknown or mismatched data remain download-only.
- Blob URLs are created only after decryption in memory and revoked when the
  preview changes or unmounts, including Vault lock/navigation.
- Web cards accept credential-free `http:` and `https:` URLs only. They never
  auto-load third-party content or widen CSP `frame-src`; users may explicitly
  open them in a `noopener noreferrer` and no-referrer browsing context.

This is a bounded P0 implementation, not a claim of complete Obsidian asset or
Canvas parity. Larger encrypted assets need a separately reviewed zero-cost,
quota-safe storage design before the 350 KiB limit can be raised.
