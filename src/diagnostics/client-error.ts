import type {
  ClientErrorBreadcrumb,
  ClientErrorContext,
  ClientErrorException,
  ClientErrorPlatform,
  ClientErrorReport
} from "../types/protocol";

export const MAX_PENDING_CLIENT_ERROR_REPORTS = 25;
export const MAX_CLIENT_ERROR_BREADCRUMBS = 8;
const CLIENT_ERROR_DEDUPE_WINDOW_MS = 5 * 60_000;
const MAX_REPORT_ID_LENGTH = 128;
const MAX_SCOPE_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_STACK_LENGTH = 6_000;
const MAX_ERROR_FIELD_LENGTH = 128;
const MAX_ACTIVE_FILE_PATH_LENGTH = 1_024;
const MAX_WORKSPACE_IDS = 20;
const MAX_WORKSPACE_ID_LENGTH = 128;

interface CreateClientErrorReportInput {
  occurredAt: string;
  scope: string;
  message: string;
  error?: unknown;
  context: ClientErrorContext;
  breadcrumbs: ClientErrorBreadcrumb[];
}

export function createClientErrorReport(
  input: CreateClientErrorReportInput
): ClientErrorReport {
  return {
    reportId: createClientErrorReportId(),
    firstOccurredAt: input.occurredAt,
    lastOccurredAt: input.occurredAt,
    occurrenceCount: 1,
    scope: sanitizeDiagnosticText(input.scope, MAX_SCOPE_LENGTH),
    message: sanitizeDiagnosticText(input.message, MAX_MESSAGE_LENGTH),
    error: createClientErrorException(input.error),
    context: normalizeClientErrorContext(input.context),
    breadcrumbs: normalizeClientErrorBreadcrumbs(input.breadcrumbs)
  };
}

export function enqueueClientErrorReport(
  reports: ClientErrorReport[],
  incoming: ClientErrorReport
): ClientErrorReport[] {
  const incomingAt = Date.parse(incoming.lastOccurredAt);
  const duplicateIndex = reports.findIndex((report) => {
    const reportAt = Date.parse(report.lastOccurredAt);
    return (
      Number.isFinite(incomingAt) &&
      Number.isFinite(reportAt) &&
      incomingAt - reportAt >= 0 &&
      incomingAt - reportAt <= CLIENT_ERROR_DEDUPE_WINDOW_MS &&
      getClientErrorFingerprint(report) === getClientErrorFingerprint(incoming)
    );
  });

  const nextReports = [...reports];
  if (duplicateIndex >= 0) {
    const duplicate = nextReports[duplicateIndex];
    nextReports[duplicateIndex] = {
      ...duplicate,
      lastOccurredAt: incoming.lastOccurredAt,
      occurrenceCount: Math.min(1_000_000, duplicate.occurrenceCount + 1),
      error: incoming.error,
      context: incoming.context,
      breadcrumbs: incoming.breadcrumbs
    };
  } else {
    nextReports.push(incoming);
  }

  return nextReports
    .sort((left, right) => left.firstOccurredAt.localeCompare(right.firstOccurredAt))
    .slice(-MAX_PENDING_CLIENT_ERROR_REPORTS);
}

export function normalizePendingClientErrorReports(value: unknown): ClientErrorReport[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((report) => normalizePendingClientErrorReport(report))
    .filter((report): report is ClientErrorReport => report !== null)
    .sort((left, right) => left.firstOccurredAt.localeCompare(right.firstOccurredAt));
  return normalized.slice(-MAX_PENDING_CLIENT_ERROR_REPORTS);
}

export function sanitizeDiagnosticText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\u0000/g, "")
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [REDACTED]"
    )
    .replace(
      /("(?:access[_-]?token|refresh[_-]?token|authorization|password|current[_-]?password|new[_-]?password|api[_-]?key|secret)"\s*:\s*")[^"]*(")/gi,
      "$1[REDACTED]$2"
    )
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|authorization|password|current[_-]?password|new[_-]?password|api[_-]?key|secret)\s*[:=]\s*([^\s&,;]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /(https?:\/\/[^/\s:@]+:)[^@\s/]+@/gi,
      "$1[REDACTED]@"
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g,
      "[REDACTED_TOKEN]"
    );
  return redacted.slice(0, Math.max(0, maxLength));
}

function createClientErrorException(error: unknown): ClientErrorException | null {
  if (error === undefined || error === null) {
    return null;
  }

  const candidate = isRecord(error) ? error : {};
  const name =
    error instanceof Error
      ? error.name || "Error"
      : typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name
        : "Error";
  const stack =
    error instanceof Error
      ? error.stack ?? null
      : typeof candidate.stack === "string"
        ? candidate.stack
        : null;

  return {
    name: sanitizeDiagnosticText(name, MAX_ERROR_FIELD_LENGTH) || "Error",
    stack: stack ? sanitizeDiagnosticText(stack, MAX_STACK_LENGTH) : null,
    code: normalizeOptionalDiagnosticField(candidate.code),
    status: normalizeHttpStatus(candidate.status),
    requestId: normalizeOptionalDiagnosticField(candidate.requestId)
  };
}

function normalizePendingClientErrorReport(value: unknown): ClientErrorReport | null {
  if (!isRecord(value)) {
    return null;
  }

  const reportId = normalizeRequiredString(value.reportId, MAX_REPORT_ID_LENGTH);
  const firstOccurredAt = normalizeDateTime(value.firstOccurredAt);
  const lastOccurredAt = normalizeDateTime(value.lastOccurredAt);
  const scope = normalizeRequiredString(value.scope, MAX_SCOPE_LENGTH);
  const message = normalizeRequiredString(value.message, MAX_MESSAGE_LENGTH);
  const occurrenceCount = normalizeInteger(value.occurrenceCount, 1, 1_000_000);
  const context = normalizePersistedClientErrorContext(value.context);
  if (
    !reportId ||
    !firstOccurredAt ||
    !lastOccurredAt ||
    Date.parse(lastOccurredAt) < Date.parse(firstOccurredAt) ||
    !scope ||
    !message ||
    occurrenceCount === null ||
    !context
  ) {
    return null;
  }

  return {
    reportId,
    firstOccurredAt,
    lastOccurredAt,
    occurrenceCount,
    scope: sanitizeDiagnosticText(scope, MAX_SCOPE_LENGTH),
    message: sanitizeDiagnosticText(message, MAX_MESSAGE_LENGTH),
    error: normalizePersistedClientErrorException(value.error),
    context,
    breadcrumbs: normalizeClientErrorBreadcrumbs(
      Array.isArray(value.breadcrumbs)
        ? value.breadcrumbs
            .map((breadcrumb) => normalizePersistedClientErrorBreadcrumb(breadcrumb))
            .filter((breadcrumb): breadcrumb is ClientErrorBreadcrumb => breadcrumb !== null)
        : []
    )
  };
}

function normalizeClientErrorContext(context: ClientErrorContext): ClientErrorContext {
  return {
    pluginId: "rolay",
    pluginVersion: sanitizeDiagnosticText(context.pluginVersion, 32),
    obsidianVersion: sanitizeDiagnosticText(context.obsidianVersion, 32),
    platform: normalizePlatform(context.platform),
    runtimeOrigin: sanitizeDiagnosticText(context.runtimeOrigin, 256),
    locale: sanitizeDiagnosticText(context.locale, 64),
    userAgent: sanitizeDiagnosticText(context.userAgent, 512),
    online: Boolean(context.online),
    nodeRuntime: Boolean(context.nodeRuntime),
    installationId: sanitizeDiagnosticText(context.installationId, 128),
    activeFilePath: context.activeFilePath
      ? sanitizeDiagnosticText(context.activeFilePath, MAX_ACTIVE_FILE_PATH_LENGTH)
      : null,
    downloadedWorkspaceIds: normalizeWorkspaceIds(context.downloadedWorkspaceIds),
    connectedWorkspaceIds: normalizeWorkspaceIds(context.connectedWorkspaceIds),
    pendingMarkdownCreates: normalizeCounter(context.pendingMarkdownCreates),
    pendingMarkdownMerges: normalizeCounter(context.pendingMarkdownMerges),
    pendingBinaryWrites: normalizeCounter(context.pendingBinaryWrites),
    activeBinaryTransfers: normalizeCounter(context.activeBinaryTransfers)
  };
}

function normalizePersistedClientErrorContext(value: unknown): ClientErrorContext | null {
  if (!isRecord(value)) {
    return null;
  }

  const pluginVersion = normalizeRequiredString(value.pluginVersion, 32);
  const obsidianVersion = normalizeRequiredString(value.obsidianVersion, 32);
  const runtimeOrigin = normalizeRequiredString(value.runtimeOrigin, 256);
  const locale = normalizeRequiredString(value.locale, 64);
  const userAgent = normalizeRequiredString(value.userAgent, 512);
  const installationId = normalizeRequiredString(value.installationId, 128);
  if (
    value.pluginId !== "rolay" ||
    !pluginVersion ||
    !obsidianVersion ||
    !runtimeOrigin ||
    !locale ||
    !userAgent ||
    !installationId
  ) {
    return null;
  }

  return normalizeClientErrorContext({
    pluginId: "rolay",
    pluginVersion,
    obsidianVersion,
    platform: normalizePlatform(value.platform),
    runtimeOrigin,
    locale,
    userAgent,
    online: value.online !== false,
    nodeRuntime: value.nodeRuntime === true,
    installationId,
    activeFilePath:
      typeof value.activeFilePath === "string"
        ? value.activeFilePath
        : null,
    downloadedWorkspaceIds: Array.isArray(value.downloadedWorkspaceIds)
      ? value.downloadedWorkspaceIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    connectedWorkspaceIds: Array.isArray(value.connectedWorkspaceIds)
      ? value.connectedWorkspaceIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    pendingMarkdownCreates: normalizeCounter(value.pendingMarkdownCreates),
    pendingMarkdownMerges: normalizeCounter(value.pendingMarkdownMerges),
    pendingBinaryWrites: normalizeCounter(value.pendingBinaryWrites),
    activeBinaryTransfers: normalizeCounter(value.activeBinaryTransfers)
  });
}

function normalizePersistedClientErrorException(
  value: unknown
): ClientErrorException | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const name = normalizeRequiredString(value.name, MAX_ERROR_FIELD_LENGTH);
  if (!name) {
    return null;
  }
  return {
    name: sanitizeDiagnosticText(name, MAX_ERROR_FIELD_LENGTH),
    stack:
      typeof value.stack === "string"
        ? sanitizeDiagnosticText(value.stack, MAX_STACK_LENGTH)
        : null,
    code: normalizeOptionalDiagnosticField(value.code),
    status: normalizeHttpStatus(value.status),
    requestId: normalizeOptionalDiagnosticField(value.requestId)
  };
}

function normalizeClientErrorBreadcrumbs(
  breadcrumbs: ClientErrorBreadcrumb[]
): ClientErrorBreadcrumb[] {
  return breadcrumbs.slice(-MAX_CLIENT_ERROR_BREADCRUMBS).map((breadcrumb) => ({
    at: normalizeDateTime(breadcrumb.at) ?? new Date(0).toISOString(),
    level: breadcrumb.level === "error" ? "error" : "info",
    scope: sanitizeDiagnosticText(breadcrumb.scope, MAX_SCOPE_LENGTH),
    message: sanitizeDiagnosticText(breadcrumb.message, 500)
  }));
}

function normalizePersistedClientErrorBreadcrumb(
  value: unknown
): ClientErrorBreadcrumb | null {
  if (!isRecord(value)) {
    return null;
  }
  const at = normalizeDateTime(value.at);
  const scope = normalizeRequiredString(value.scope, MAX_SCOPE_LENGTH);
  const message = normalizeRequiredString(value.message, 500);
  if (!at || !scope || !message) {
    return null;
  }
  return {
    at,
    level: value.level === "error" ? "error" : "info",
    scope,
    message
  };
}

function getClientErrorFingerprint(report: ClientErrorReport): string {
  return [
    report.context.pluginVersion,
    report.context.installationId,
    report.scope,
    report.message,
    report.error?.name ?? "",
    report.error?.code ?? "",
    report.error?.status ?? ""
  ].join("\u0001");
}

function createClientErrorReportId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  const suffix = randomId ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return sanitizeDiagnosticText(`err_${suffix}`, MAX_REPORT_ID_LENGTH);
}

function normalizeWorkspaceIds(values: string[]): string[] {
  return [...new Set(
    values
      .map((value) => sanitizeDiagnosticText(value.trim(), MAX_WORKSPACE_ID_LENGTH))
      .filter(Boolean)
  )].slice(0, MAX_WORKSPACE_IDS);
}

function normalizePlatform(value: unknown): ClientErrorPlatform {
  switch (value) {
    case "desktop":
    case "android":
    case "ios":
    case "mobile-ui":
      return value;
    default:
      return "unknown";
  }
}

function normalizeOptionalDiagnosticField(value: unknown): string | null {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    return null;
  }
  return sanitizeDiagnosticText(String(value), MAX_ERROR_FIELD_LENGTH);
}

function normalizeHttpStatus(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : null;
}

function normalizeCounter(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0
    ? Math.min(1_000_000, Number(value))
    : 0;
}

function normalizeInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null;
}

function normalizeRequiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.slice(0, maxLength);
}

function normalizeDateTime(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
