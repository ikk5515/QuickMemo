import type {
  ObsidianVaultManifest,
  ObsidianVaultSourceEntry,
  ObsidianZipOptions,
  VaultInteropErrorCode
} from "./types";
import type { ObsidianVaultZipExport } from "./zip";

export type VaultInteropWorkerOperation = "export" | "import";

export type VaultInteropWorkerRequest =
  | {
      id: string;
      type: "export";
      sources: ObsidianVaultSourceEntry[];
      options: ObsidianZipOptions;
    }
  | {
      id: string;
      type: "import";
      bytes: Uint8Array;
      options: ObsidianZipOptions;
    };
export type VaultInteropWorkerFailure =
  | { kind: "vault"; code: VaultInteropErrorCode }
  | { kind: "worker"; code: "internal-error" | "invalid-request" };

export type VaultInteropWorkerResponse =
  | {
      id: string;
      type: "export-result";
      result: ObsidianVaultZipExport;
    }
  | {
      id: string;
      type: "import-result";
      result: ObsidianVaultManifest;
    }
  | {
      id: string;
      type: "error";
      error: VaultInteropWorkerFailure;
    };
