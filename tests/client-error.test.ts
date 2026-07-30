import assert from "node:assert/strict";
import test from "node:test";

import {
  createClientErrorReport,
  enqueueClientErrorReport,
  MAX_PENDING_CLIENT_ERROR_REPORTS,
  normalizePendingClientErrorReports,
  sanitizeDiagnosticText
} from "../src/diagnostics/client-error";
import { ClientErrorReporter } from "../src/diagnostics/client-error-reporter";
import type { RolayApiClient } from "../src/api/client";
import type {
  ClientErrorBatchRequest,
  ClientErrorContext,
  ClientErrorReport
} from "../src/types/protocol";

function createContext(): ClientErrorContext {
  return {
    pluginId: "rolay",
    pluginVersion: "1.2.24",
    obsidianVersion: "1.8.10",
    platform: "desktop",
    runtimeOrigin: "app://obsidian.md",
    locale: "ru",
    userAgent: "Obsidian/1.8.10",
    online: true,
    nodeRuntime: true,
    installationId: "installation-1",
    activeFilePath: "main/Lecture.md",
    downloadedWorkspaceIds: ["ws_main"],
    connectedWorkspaceIds: ["ws_main"],
    pendingMarkdownCreates: 0,
    pendingMarkdownMerges: 0,
    pendingBinaryWrites: 0,
    activeBinaryTransfers: 0
  };
}

function createReport(
  occurredAt: string,
  requestId = "req-1"
): ClientErrorReport {
  const error = Object.assign(
    new Error('Request failed with Bearer token-secret and {"password":"secret"}'),
    {
      code: "internal_error",
      status: 500,
      requestId
    }
  );
  return createClientErrorReport({
    occurredAt,
    scope: "crdt",
    message: "Refresh failed with accessToken=secret-token",
    error,
    context: createContext(),
    breadcrumbs: [
      {
        at: occurredAt,
        level: "info",
        scope: "auth",
        message: "Authorization: Bearer breadcrumb-secret"
      }
    ]
  });
}

test("client error reports redact credentials and preserve useful exception metadata", () => {
  const report = createReport("2026-07-30T08:00:00.000Z");

  assert.equal(report.message, "Refresh failed with accessToken=[REDACTED]");
  assert.equal(report.error?.code, "internal_error");
  assert.equal(report.error?.status, 500);
  assert.equal(report.error?.requestId, "req-1");
  assert.match(report.error?.stack ?? "", /Bearer \[REDACTED\]/);
  assert.equal((report.error?.stack ?? "").includes('"password":"secret"'), false);
  assert.equal(report.breadcrumbs[0].message.includes("breadcrumb-secret"), false);
});

test("diagnostic redaction covers common header, URL, API key, and JWT forms", () => {
  const diagnostic = sanitizeDiagnosticText(
    [
      "Authorization: Basic YWxpY2U6c2VjcmV0",
      "api_key=key-secret",
      "https://alice:password-secret@example.com/private",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123"
    ].join(" "),
    2_000
  );

  for (const secret of [
    "YWxpY2U6c2VjcmV0",
    "key-secret",
    "password-secret",
    "eyJhbGciOiJIUzI1NiJ9"
  ]) {
    assert.equal(diagnostic.includes(secret), false);
  }
});

test("equal errors aggregate while retaining the newest request correlation", () => {
  const first = createReport("2026-07-30T08:00:00.000Z", "req-1");
  const second = createReport("2026-07-30T08:01:00.000Z", "req-2");
  const aggregated = enqueueClientErrorReport(
    enqueueClientErrorReport([], first),
    second
  );

  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].occurrenceCount, 2);
  assert.equal(aggregated[0].firstOccurredAt, first.firstOccurredAt);
  assert.equal(aggregated[0].lastOccurredAt, second.lastOccurredAt);
  assert.equal(aggregated[0].error?.requestId, "req-2");

  const later = createReport("2026-07-30T08:07:00.000Z", "req-3");
  assert.equal(enqueueClientErrorReport(aggregated, later).length, 2);
});

test("persisted client error queues are normalized, redacted, and bounded", () => {
  const reports = Array.from(
    { length: MAX_PENDING_CLIENT_ERROR_REPORTS + 5 },
    (_, index) => {
      return {
        ...createReport(
          new Date(Date.UTC(2026, 6, 30, 8, index)).toISOString(),
          `req-${index}`
        ),
        reportId: `err-${index}`
      };
    }
  );
  reports[reports.length - 1].message = "Bearer persisted-secret";

  const normalized = normalizePendingClientErrorReports([
    { malformed: true },
    ...reports
  ]);

  assert.equal(normalized.length, MAX_PENDING_CLIENT_ERROR_REPORTS);
  assert.equal(normalized.some((report) => report.reportId === "err-0"), false);
  assert.equal(
    JSON.stringify(normalized).includes("persisted-secret"),
    false
  );
});

test("client error reporter keeps offline errors and clears them only after delivery", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis
  });

  let pendingReports: ClientErrorReport[] = [];
  let deliveryAvailable = false;
  const submitted: ClientErrorBatchRequest[] = [];
  const apiClient = {
    async submitClientErrors(body: ClientErrorBatchRequest) {
      submitted.push(body);
      return {
        accepted: body.reports.length,
        requestId: "req-delivery"
      };
    }
  } as RolayApiClient;
  const reporter = new ClientErrorReporter({
    apiClient,
    getPendingReports: () => pendingReports,
    replacePendingReports: (reports) => {
      pendingReports = reports;
    },
    canSend: () => deliveryAvailable,
    getContext: createContext,
    getBreadcrumbs: () => [],
    log: () => undefined
  });

  try {
    reporter.start();
    reporter.capture("crdt", "Offline reconnect failed", new Error("offline"));
    assert.equal(pendingReports.length, 1);
    assert.equal(submitted.length, 0);

    deliveryAvailable = true;
    reporter.notifyDeliveryAvailable();
    await waitFor(() => submitted.length === 1 && pendingReports.length === 0);

    assert.equal(submitted[0].reports.length, 1);
    assert.equal(submitted[0].reports[0].context.pluginVersion, "1.2.24");
  } finally {
    reporter.stop();
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for client error delivery.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
