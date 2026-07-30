import type { RolayApiClient } from "../api/client";
import type {
  ClientErrorBreadcrumb,
  ClientErrorContext,
  ClientErrorReport
} from "../types/protocol";
import {
  createClientErrorReport,
  enqueueClientErrorReport,
  sanitizeDiagnosticText
} from "./client-error";

interface ClientErrorReporterConfig {
  apiClient: RolayApiClient;
  getPendingReports: () => ClientErrorReport[];
  replacePendingReports: (reports: ClientErrorReport[]) => void;
  canSend: () => boolean;
  getContext: () => ClientErrorContext;
  getBreadcrumbs: () => ClientErrorBreadcrumb[];
  log: (message: string) => void;
}

const CAPTURE_FLUSH_DELAY_MS = 2_000;
const DELIVERY_UNAVAILABLE_RETRY_MS = 60_000;
const MAX_REPORTS_PER_BATCH = 5;
const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000
] as const;

export class ClientErrorReporter {
  private readonly config: ClientErrorReporterConfig;
  private flushHandle: number | null = null;
  private flushScheduledAt: number | null = null;
  private flushPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private started = false;
  private stopped = false;

  constructor(config: ClientErrorReporterConfig) {
    this.config = config;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    if (this.config.getPendingReports().length > 0) {
      this.scheduleFlush(0);
    }
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    if (this.flushHandle !== null) {
      window.clearTimeout(this.flushHandle);
      this.flushHandle = null;
      this.flushScheduledAt = null;
    }
  }

  capture(scope: string, message: string, error?: unknown): void {
    try {
      const occurredAt = new Date().toISOString();
      const report = createClientErrorReport({
        occurredAt,
        scope,
        message,
        error,
        context: this.config.getContext(),
        breadcrumbs: this.config.getBreadcrumbs()
      });
      const reports = enqueueClientErrorReport(
        this.config.getPendingReports(),
        report
      );
      this.config.replacePendingReports(reports);
      this.scheduleFlush(CAPTURE_FLUSH_DELAY_MS);
    } catch (captureError) {
      console.warn(
        `[Rolay] diagnostics: Failed to queue client error report: ${getErrorMessage(captureError)}`
      );
    }
  }

  notifyDeliveryAvailable(): void {
    if (!this.started || this.stopped) {
      return;
    }
    this.consecutiveFailures = 0;
    this.scheduleFlush(0);
  }

  private scheduleFlush(delayMs: number): void {
    if (
      !this.started ||
      this.stopped ||
      this.config.getPendingReports().length === 0
    ) {
      return;
    }

    const scheduledAt = Date.now() + Math.max(0, delayMs);
    if (
      this.flushHandle !== null &&
      this.flushScheduledAt !== null &&
      this.flushScheduledAt <= scheduledAt
    ) {
      return;
    }
    if (this.flushHandle !== null) {
      window.clearTimeout(this.flushHandle);
    }

    this.flushScheduledAt = scheduledAt;
    this.flushHandle = window.setTimeout(() => {
      this.flushHandle = null;
      this.flushScheduledAt = null;
      void this.flush();
    }, Math.max(0, delayMs));
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.flushPromise) {
      return;
    }
    if (this.config.getPendingReports().length === 0) {
      return;
    }
    if (!this.config.canSend() || globalThis.navigator?.onLine === false) {
      this.scheduleFlush(DELIVERY_UNAVAILABLE_RETRY_MS);
      return;
    }

    const batch = this.config.getPendingReports().slice(0, MAX_REPORTS_PER_BATCH);
    const delivery = this.deliverBatch(batch);
    this.flushPromise = delivery;
    try {
      await delivery;
    } finally {
      if (this.flushPromise === delivery) {
        this.flushPromise = null;
      }
    }
  }

  private async deliverBatch(batch: ClientErrorReport[]): Promise<void> {
    try {
      const response = await this.config.apiClient.submitClientErrors({
        reports: batch
      });
      if (this.stopped) {
        return;
      }
      if (response.accepted !== batch.length) {
        throw new Error(
          `Server accepted ${response.accepted} of ${batch.length} client error reports.`
        );
      }

      const sentById = new Map(batch.map((report) => [report.reportId, report]));
      const remaining = this.config.getPendingReports().filter((current) => {
        const sent = sentById.get(current.reportId);
        return (
          !sent ||
          current.lastOccurredAt !== sent.lastOccurredAt ||
          current.occurrenceCount !== sent.occurrenceCount
        );
      });
      this.config.replacePendingReports(remaining);
      this.consecutiveFailures = 0;
      this.config.log(
        `Delivered ${batch.length} client error report(s) as server request ${response.requestId}.`
      );
      if (remaining.length > 0) {
        this.scheduleFlush(0);
      }
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.consecutiveFailures += 1;
      const retryDelay = getRetryDelay(this.consecutiveFailures);
      this.config.log(
        `Client error delivery failed; retrying automatically in ${Math.round(
          retryDelay / 1_000
        )}s: ${sanitizeDiagnosticText(getErrorMessage(error), 500)}`
      );
      this.scheduleFlush(retryDelay);
    }
  }
}

function getRetryDelay(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(0, consecutiveFailures - 1),
    RETRY_DELAYS_MS.length - 1
  );
  return RETRY_DELAYS_MS[index];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
