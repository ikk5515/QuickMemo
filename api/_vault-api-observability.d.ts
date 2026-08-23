export function logVaultApiRejection(input: {
  action: unknown;
  error: unknown;
  requestId: string;
  route: "/api/vault-folders" | "/api/vault-integrity" | "/api/vault-notes";
  supportedActions: ReadonlySet<string>;
}): void;
