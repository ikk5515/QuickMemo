import { afterAll, beforeAll, describe, it } from "vitest";
import {
  apiHeaders,
  clearSecureShareEmulators,
  configureSecureShareApiEmulatorEnvironment,
  cookiePairs,
  createEmulatorOwner,
  listEmulatorCollection,
  metadataBinding,
  seedSecureShare,
  startSecureShareApiHarness,
  writeEmulatorDocuments,
  type SecureShareApiHarness
} from "./helpers/secureShareApiEmulator.js";

const describeEmulator =
  process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? describe
    : describe.skip;

const benchmarkMode =
  process.env.SECURE_SHARE_BENCHMARK_MODE === "legacy" ? "legacy" : "current";
const configuredSampleCount = Number.parseInt(
  process.env.SECURE_SHARE_BENCHMARK_SAMPLES ?? "12",
  10
);
const sampleCount = Number.isSafeInteger(configuredSampleCount)
  ? Math.min(18, Math.max(5, configuredSampleCount))
  : 12;

interface FirestoreMetrics {
  conflictResponses: number;
  documentReads: number;
  pending: Promise<void>[];
  rollbackRequests: number;
  successfulWrites: number;
  transactionCommits: number;
  transactionStarts: number;
  writeAttempts: number;
}

interface BenchmarkSample {
  conflictResponses: number;
  documentReads: number;
  latencyMilliseconds: number;
  rollbackRequests: number;
  successfulWrites: number;
  transactionCommits: number;
  transactionStarts: number;
  writeAttempts: number;
}

interface ParticipantSession {
  bindingCookie: string;
  csrfToken: string;
  participantCookie?: string;
  sessionCookie: string;
}

interface BenchmarkSummary {
  latencyMilliseconds: {
    p50: number;
    p95: number;
  };
  reads: {
    p50: number;
    p95: number;
  };
  rollbacks: number;
  samples: number;
  transactionConflicts: number;
  transactionStarts: {
    p50: number;
    p95: number;
  };
  writeAttempts: {
    p50: number;
    p95: number;
  };
  writes: {
    p50: number;
    p95: number;
  };
}

const originalFetch = globalThis.fetch;
let activeMetrics: FirestoreMetrics | null = null;

function emptyMetrics(): FirestoreMetrics {
  return {
    conflictResponses: 0,
    documentReads: 0,
    pending: [],
    rollbackRequests: 0,
    successfulWrites: 0,
    transactionCommits: 0,
    transactionStarts: 0,
    writeAttempts: 0
  };
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function requestJson(init?: RequestInit) {
  if (typeof init?.body !== "string") {
    return null;
  }
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firestoreRequestUrl(value: string) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  if (!host) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.host === host && url.pathname.includes("/documents")
      ? url
      : null;
  } catch {
    return null;
  }
}

function countQueryDocuments(response: Response, metrics: FirestoreMetrics) {
  const pending = response.clone().json()
    .then((body: unknown) => {
      const rows = Array.isArray(body)
        ? body
        : (
            body
            && typeof body === "object"
            && Array.isArray((body as { documents?: unknown }).documents)
              ? (body as { documents: unknown[] }).documents
              : []
          );
      const documents = rows.filter((row) =>
        row
        && typeof row === "object"
        && (
          Object.prototype.hasOwnProperty.call(row, "document")
          || Object.prototype.hasOwnProperty.call(row, "name")
        )
      );
      metrics.documentReads += Math.max(1, documents.length);
    })
    .catch(() => undefined);
  metrics.pending.push(pending);
}

/*
 * These counters are deterministic emulator request-cost proxies, not Firebase
 * billing exports. A point GET counts as one read even when the document is
 * missing, batchGet counts every requested document, and a query/list counts
 * returned documents with a minimum of one read. Successful commit write
 * entries are "writes"; all requested commit entries, including a failed
 * transaction attempt, are "writeAttempts". A 400/409 transaction commit is
 * recorded separately as a conflict so retry amplification remains visible.
 */
function installFirestoreMetrics() {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const metrics = activeMetrics;
    const url = firestoreRequestUrl(requestUrl(input));
    const requestBody = url ? requestJson(init) : null;
    const response = await originalFetch(input, init);

    if (!metrics || !url) {
      return response;
    }

    if (url.pathname.endsWith(":batchGet")) {
      const documents = Array.isArray(requestBody?.documents)
        ? requestBody.documents.length
        : 0;
      metrics.documentReads += documents;
      if (requestBody?.newTransaction) {
        metrics.transactionStarts += 1;
      }
    } else if (url.pathname.endsWith(":runQuery")) {
      countQueryDocuments(response, metrics);
    } else if (url.pathname.endsWith(":commit")) {
      const writes = Array.isArray(requestBody?.writes)
        ? requestBody.writes.length
        : 0;
      metrics.writeAttempts += writes;
      if (response.ok) {
        metrics.successfulWrites += writes;
        if (typeof requestBody?.transaction === "string") {
          metrics.transactionCommits += 1;
        }
      } else if ([400, 409].includes(response.status)) {
        metrics.conflictResponses += 1;
      }
    } else if (url.pathname.endsWith(":rollback")) {
      metrics.rollbackRequests += 1;
    } else if ((init?.method ?? "GET").toUpperCase() === "GET") {
      if (url.searchParams.has("pageSize")) {
        countQueryDocuments(response, metrics);
      } else {
        metrics.documentReads += 1;
      }
    }

    return response;
  };
}

function uninstallFirestoreMetrics() {
  globalThis.fetch = originalFetch;
}

function quantile(values: number[], percentile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)
  );
  return sorted[index] ?? 0;
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function summarize(samples: BenchmarkSample[]): BenchmarkSummary {
  return {
    latencyMilliseconds: {
      p50: rounded(quantile(samples.map((sample) => sample.latencyMilliseconds), 0.5)),
      p95: rounded(quantile(samples.map((sample) => sample.latencyMilliseconds), 0.95))
    },
    reads: {
      p50: quantile(samples.map((sample) => sample.documentReads), 0.5),
      p95: quantile(samples.map((sample) => sample.documentReads), 0.95)
    },
    rollbacks: samples.reduce((total, sample) => total + sample.rollbackRequests, 0),
    samples: samples.length,
    transactionConflicts: samples.reduce(
      (total, sample) => total + sample.conflictResponses,
      0
    ),
    transactionStarts: {
      p50: quantile(samples.map((sample) => sample.transactionStarts), 0.5),
      p95: quantile(samples.map((sample) => sample.transactionStarts), 0.95)
    },
    writeAttempts: {
      p50: quantile(samples.map((sample) => sample.writeAttempts), 0.5),
      p95: quantile(samples.map((sample) => sample.writeAttempts), 0.95)
    },
    writes: {
      p50: quantile(samples.map((sample) => sample.successfulWrites), 0.5),
      p95: quantile(samples.map((sample) => sample.successfulWrites), 0.95)
    }
  };
}

async function measure(operation: () => Promise<void>): Promise<BenchmarkSample> {
  const metrics = emptyMetrics();
  activeMetrics = metrics;
  const startedAt = performance.now();
  try {
    await operation();
  } finally {
    activeMetrics = null;
  }
  const latencyMilliseconds = performance.now() - startedAt;
  await Promise.all(metrics.pending);
  return {
    conflictResponses: metrics.conflictResponses,
    documentReads: metrics.documentReads,
    latencyMilliseconds,
    rollbackRequests: metrics.rollbackRequests,
    successfulWrites: metrics.successfulWrites,
    transactionCommits: metrics.transactionCommits,
    transactionStarts: metrics.transactionStarts,
    writeAttempts: metrics.writeAttempts
  };
}

function setParticipantFeatures(enabled: boolean) {
  process.env.SECURE_SHARE_PARTICIPANT_IDENTITY_ENABLED = enabled ? "true" : "false";
  process.env.SECURE_SHARE_COMMENT_IP_PREFIX_ENABLED = enabled ? "true" : "false";
}

function responseCookie(response: Response, marker: "qmsp_" | "qmss_") {
  return cookiePairs(response).find((candidate) =>
    candidate.slice(0, candidate.indexOf("=")).includes(marker)
  );
}

function sessionCookies(session: ParticipantSession) {
  return [
    session.bindingCookie,
    session.participantCookie,
    session.sessionCookie
  ].filter((cookie): cookie is string => Boolean(cookie)).join("; ");
}

async function jsonResponse(response: Response) {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Benchmark request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function accessRequest(input: {
  bindingCookie: string;
  harness: SecureShareApiHarness;
  networkSuffix: number;
  participantCookie?: string;
  shareId: string;
  unlockAttemptId: string;
}) {
  const cookie = [input.bindingCookie, input.participantCookie]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=access`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: "POST",
      headers: apiHeaders(input.harness.origin, {
        bindingCookie: cookie,
        networkSuffix: input.networkSuffix
      }),
      body: JSON.stringify({
        displayName: "Ignored benchmark label",
        unlockAttemptId: input.unlockAttemptId
      })
    }
  );
  return { body: await jsonResponse(response), response };
}

async function openSession(input: {
  harness: SecureShareApiHarness;
  networkSuffix: number;
  participantEnabled: boolean;
  shareId: string;
}): Promise<ParticipantSession> {
  setParticipantFeatures(input.participantEnabled);
  const metadata = await metadataBinding(input.harness.origin, input.shareId, {
    networkSuffix: input.networkSuffix
  });
  const access = await accessRequest({
    bindingCookie: metadata.bindingCookie,
    harness: input.harness,
    networkSuffix: input.networkSuffix,
    shareId: input.shareId,
    unlockAttemptId: `bench_open_${input.shareId}_${input.networkSuffix}`
  });
  const sessionCookie = responseCookie(access.response, "qmss_");
  const participantCookie = responseCookie(access.response, "qmsp_");
  if (!sessionCookie || (input.participantEnabled && !participantCookie)) {
    throw new Error("Benchmark session cookies were not issued");
  }
  return {
    bindingCookie: metadata.bindingCookie,
    csrfToken: String(access.body.csrfToken),
    ...(participantCookie ? { participantCookie } : {}),
    sessionCookie
  };
}

async function commentRequest(input: {
  body?: Record<string, unknown>;
  harness: SecureShareApiHarness;
  method: "GET" | "POST";
  session: ParticipantSession;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=comments`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: input.method,
      headers: apiHeaders(input.harness.origin, {
        bindingCookie: sessionCookies(input.session),
        csrfToken: input.method === "POST" ? input.session.csrfToken : undefined
      }),
      ...(input.body ? { body: JSON.stringify(input.body) } : {})
    }
  );
  await jsonResponse(response);
}

async function renameRequest(input: {
  displayName: string;
  harness: SecureShareApiHarness;
  requestId: string;
  session: ParticipantSession;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=participant-me`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: "PATCH",
      headers: apiHeaders(input.harness.origin, {
        bindingCookie: sessionCookies(input.session),
        csrfToken: input.session.csrfToken
      }),
      body: JSON.stringify({
        clientRequestId: input.requestId,
        displayName: input.displayName
      })
    }
  );
  await jsonResponse(response);
}

async function ownerRevokeRequest(input: {
  harness: SecureShareApiHarness;
  idToken: string;
  requestId: string;
  shareId: string;
}) {
  const response = await fetch(
    `${input.harness.origin}/api/public-shares-v2?action=owner-revoke`
    + `&shareId=${encodeURIComponent(input.shareId)}`,
    {
      method: "POST",
      headers: apiHeaders(input.harness.origin, {
        authorization: input.idToken,
        networkSuffix: 210
      }),
      body: JSON.stringify({ idempotencyKey: input.requestId })
    }
  );
  await jsonResponse(response);
}

function commentFields(input: {
  authorIdentityHash?: string;
  authorParticipantId?: string;
  createdAt: Date;
  displayName: string;
  index: number;
  ownerUid: string;
  shareId: string;
}) {
  return {
    authorBadge: "guest",
    authorDisplayName: input.displayName,
    authorDisplayNameSnapshot: input.displayName,
    ...(input.authorIdentityHash
      ? { authorIdentityHash: input.authorIdentityHash }
      : {}),
    ...(input.authorParticipantId
      ? { authorParticipantId: input.authorParticipantId }
      : {}),
    body: `benchmark comment ${input.index}`,
    createdAt: input.createdAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ownerUid: input.ownerUid,
    retentionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    shareId: input.shareId
  };
}

async function seedLegacyComments(shareId: string, ownerUid: string) {
  const now = Date.now();
  await writeEmulatorDocuments(
    Array.from({ length: 20 }, (_, index) => ({
      path: `publicShareComments/${shareId}/items/legacy_${String(index).padStart(4, "0")}`,
      fields: commentFields({
        authorIdentityHash: `legacy_identity_${String(index).padStart(4, "0")}`,
        createdAt: new Date(now - index),
        displayName: `Legacy ${index + 1}`,
        index,
        ownerUid,
        shareId
      })
    }))
  );
}

async function seedParticipantComments(input: {
  distinctParticipants: boolean;
  ownerUid: string;
  participantId: string;
  shareId: string;
}) {
  const now = Date.now();
  const participantDocuments = input.distinctParticipants
    ? Array.from({ length: 19 }, (_, index) => {
        const guestNumber = index + 2;
        const participantId = `p_bench_${String(guestNumber).padStart(4, "0")}`;
        return {
          path: `publicShareParticipants/${input.shareId}/items/${participantId}`,
          fields: {
            displayName: `Bench ${guestNumber}`,
            guestNumber,
            normalizedDisplayName: `bench ${guestNumber}`,
            ownerUid: input.ownerUid,
            participantId,
            schemaVersion: 1,
            shareId: input.shareId,
            status: "active",
            systemDefaultName: `guest${guestNumber}`
          }
        };
      })
    : [];
  const participantIds = [
    input.participantId,
    ...participantDocuments.map((document) =>
      document.path.slice(document.path.lastIndexOf("/") + 1)
    )
  ];
  const comments = Array.from({ length: 20 }, (_, index) => {
    const participantId = input.distinctParticipants
      ? participantIds[index]
      : input.participantId;
    return {
      path: `publicShareComments/${input.shareId}/items/participant_${String(index).padStart(4, "0")}`,
      fields: commentFields({
        authorParticipantId: participantId,
        createdAt: new Date(now - index),
        displayName: `Snapshot ${index + 1}`,
        index,
        ownerUid: input.ownerUid,
        shareId: input.shareId
      })
    };
  });
  await writeEmulatorDocuments([...participantDocuments, ...comments]);
}

async function runPreparedSamples(
  prepare: (index: number) => Promise<() => Promise<void>>
) {
  const samples: BenchmarkSample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const operation = await prepare(index);
    samples.push(await measure(operation));
  }
  return summarize(samples);
}

describeEmulator("Secure Share opt-in performance benchmark", () => {
  let harness: SecureShareApiHarness;

  beforeAll(async () => {
    configureSecureShareApiEmulatorEnvironment();
    installFirestoreMetrics();
    harness = await startSecureShareApiHarness();
    await clearSecureShareEmulators();
  });

  afterAll(async () => {
    activeMetrics = null;
    uninstallFirestoreMetrics();
    await harness?.close();
  });

  it("reports latency and Firestore operation counts without bypassing API guards", async () => {
    const operations: Record<string, BenchmarkSummary> = {};

    setParticipantFeatures(false);
    operations.accessLegacy = await runPreparedSamples(async (index) => {
      const shareId = `bench_access_legacy_${String(index).padStart(3, "0")}`;
      await seedSecureShare({
        oneTimeEnabled: false,
        permissionLevel: "comment",
        shareId
      });
      const metadata = await metadataBinding(harness.origin, shareId, {
        networkSuffix: 10 + index
      });
      return async () => {
        setParticipantFeatures(false);
        await accessRequest({
          bindingCookie: metadata.bindingCookie,
          harness,
          networkSuffix: 10 + index,
          shareId,
          unlockAttemptId: `bench_access_legacy_attempt_${String(index).padStart(3, "0")}`
        });
      };
    });

    operations.commentCreateLegacy = await runPreparedSamples(async (index) => {
      const shareId = `bench_comment_legacy_${String(index).padStart(3, "0")}`;
      const seed = await seedSecureShare({
        oneTimeEnabled: false,
        permissionLevel: "comment",
        shareId
      });
      void seed;
      const session = await openSession({
        harness,
        networkSuffix: 40 + index,
        participantEnabled: false,
        shareId
      });
      return async () => {
        setParticipantFeatures(false);
        await commentRequest({
          body: {
            body: `legacy benchmark ${index}`,
            clientRequestId: `bench_comment_legacy_request_${String(index).padStart(3, "0")}`
          },
          harness,
          method: "POST",
          session,
          shareId
        });
      };
    });

    const legacyListShareId = "bench_comment_list_legacy";
    const legacyListSeed = await seedSecureShare({
      oneTimeEnabled: false,
      permissionLevel: "comment",
      shareId: legacyListShareId
    });
    const legacyListSession = await openSession({
      harness,
      networkSuffix: 70,
      participantEnabled: false,
      shareId: legacyListShareId
    });
    await seedLegacyComments(legacyListShareId, legacyListSeed.ownerUid);
    operations.commentListLegacy20 = await runPreparedSamples(async () => async () => {
      setParticipantFeatures(false);
      await commentRequest({
        harness,
        method: "GET",
        session: legacyListSession,
        shareId: legacyListShareId
      });
    });

    const owner = await createEmulatorOwner(
      `benchmark-${benchmarkMode}@example.test`,
      "benchmark-password-123"
    );
    operations.revoke = await runPreparedSamples(async (index) => {
      const shareId = `bench_revoke_${String(index).padStart(3, "0")}`;
      await seedSecureShare({
        oneTimeEnabled: false,
        ownerUid: owner.localId,
        permissionLevel: "comment",
        shareId
      });
      return async () => {
        await ownerRevokeRequest({
          harness,
          idToken: owner.idToken,
          requestId: `bench_revoke_request_${String(index).padStart(3, "0")}`,
          shareId
        });
      };
    });

    if (benchmarkMode === "current") {
      setParticipantFeatures(true);
      operations.participantCreate = await runPreparedSamples(async (index) => {
        const shareId = `bench_participant_new_${String(index).padStart(3, "0")}`;
        await seedSecureShare({
          oneTimeEnabled: false,
          permissionLevel: "comment",
          shareId
        });
        const metadata = await metadataBinding(harness.origin, shareId, {
          networkSuffix: 90 + index
        });
        return async () => {
          setParticipantFeatures(true);
          await accessRequest({
            bindingCookie: metadata.bindingCookie,
            harness,
            networkSuffix: 90 + index,
            shareId,
            unlockAttemptId: `bench_participant_new_attempt_${String(index).padStart(3, "0")}`
          });
        };
      });

      const reuseShareId = "bench_participant_reuse";
      await seedSecureShare({
        oneTimeEnabled: false,
        permissionLevel: "comment",
        shareId: reuseShareId
      });
      const reuseMetadata = await metadataBinding(harness.origin, reuseShareId, {
        networkSuffix: 120
      });
      const firstAccess = await accessRequest({
        bindingCookie: reuseMetadata.bindingCookie,
        harness,
        networkSuffix: 120,
        shareId: reuseShareId,
        unlockAttemptId: "bench_participant_reuse_initial"
      });
      const reuseParticipantCookie = responseCookie(firstAccess.response, "qmsp_");
      if (!reuseParticipantCookie) {
        throw new Error("Reusable participant cookie was not issued");
      }
      operations.participantReuse = await runPreparedSamples(async (index) => async () => {
        setParticipantFeatures(true);
        await accessRequest({
          bindingCookie: reuseMetadata.bindingCookie,
          harness,
          networkSuffix: 120,
          participantCookie: reuseParticipantCookie,
          shareId: reuseShareId,
          unlockAttemptId: `bench_participant_reuse_attempt_${String(index).padStart(3, "0")}`
        });
      });

      operations.commentCreateParticipant = await runPreparedSamples(async (index) => {
        const shareId = `bench_comment_participant_${String(index).padStart(3, "0")}`;
        await seedSecureShare({
          oneTimeEnabled: false,
          permissionLevel: "comment",
          shareId
        });
        const session = await openSession({
          harness,
          networkSuffix: 130 + index,
          participantEnabled: true,
          shareId
        });
        return async () => {
          setParticipantFeatures(true);
          await commentRequest({
            body: {
              body: `participant benchmark ${index}`,
              clientRequestId:
                `bench_comment_participant_request_${String(index).padStart(3, "0")}`
            },
            harness,
            method: "POST",
            session,
            shareId
          });
        };
      });

      for (const distinctParticipants of [false, true]) {
        const suffix = distinctParticipants ? "different" : "same";
        const shareId = `bench_comment_list_${suffix}`;
        const seed = await seedSecureShare({
          oneTimeEnabled: false,
          permissionLevel: "comment",
          shareId
        });
        const session = await openSession({
          harness,
          networkSuffix: distinctParticipants ? 170 : 169,
          participantEnabled: true,
          shareId
        });
        const [participant] = await listEmulatorCollection(
          `publicShareParticipants/${shareId}/items`
        );
        if (!participant?.participantId) {
          throw new Error("Comment benchmark participant is missing");
        }
        await seedParticipantComments({
          distinctParticipants,
          ownerUid: seed.ownerUid,
          participantId: String(participant.participantId),
          shareId
        });
        operations[
          distinctParticipants
            ? "commentListDifferentParticipants20"
            : "commentListSameParticipant20"
        ] = await runPreparedSamples(async () => async () => {
          setParticipantFeatures(true);
          await commentRequest({
            harness,
            method: "GET",
            session,
            shareId
          });
        });
      }

      operations.rename = await runPreparedSamples(async (index) => {
        const shareId = `bench_rename_${String(index).padStart(3, "0")}`;
        await seedSecureShare({
          oneTimeEnabled: false,
          permissionLevel: "comment",
          shareId
        });
        const session = await openSession({
          harness,
          networkSuffix: 180 + index,
          participantEnabled: true,
          shareId
        });
        return async () => {
          setParticipantFeatures(true);
          await renameRequest({
            displayName: `BenchName${index + 1}`,
            harness,
            requestId: `bench_rename_request_${String(index).padStart(3, "0")}`,
            session,
            shareId
          });
        };
      });
    }

    console.log(`SECURE_SHARE_PERFORMANCE_JSON=${JSON.stringify({
      schemaVersion: 1,
      benchmarkMode,
      sampleCount,
      units: {
        latency: "milliseconds",
        reads: "emulator proxy: point GET including missing = 1; batchGet = requested documents; query/list = returned documents, minimum 1",
        writes: "successful Firestore commit write entries per API request",
        writeAttempts: "all requested Firestore commit write entries, including failed attempts",
        transactionConflicts: "HTTP 400/409 transaction commit responses across all samples",
        rollbacks: "Firestore rollback requests across all samples"
      },
      operations
    })}`);
  });
});
