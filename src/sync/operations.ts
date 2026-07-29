import type { ApiResponseMeta, RolayApiClient } from "../api/client";
import type {
  BatchOperationsResponse,
  OperationResult,
  TreeOperation
} from "../types/protocol";

interface OperationsQueueConfig {
  apiClient: RolayApiClient;
  getDeviceId: () => string;
  log: (message: string) => void;
  onTrace?: (workspaceId: string, operation: TreeOperation, reason: string, meta: ApiResponseMeta) => void;
  onAfterApply?: (workspaceId: string, reason: string, eventCursor: number | null) => Promise<void> | void;
}

export class OperationsQueue {
  private readonly apiClient: RolayApiClient;
  private readonly getDeviceId: () => string;
  private readonly log: (message: string) => void;
  private readonly onTrace?: (workspaceId: string, operation: TreeOperation, reason: string, meta: ApiResponseMeta) => void;
  private readonly onAfterApply?: (
    workspaceId: string,
    reason: string,
    eventCursor: number | null
  ) => Promise<void> | void;
  private chain: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  constructor(config: OperationsQueueConfig) {
    this.apiClient = config.apiClient;
    this.getDeviceId = config.getDeviceId;
    this.log = config.log;
    this.onTrace = config.onTrace;
    this.onAfterApply = config.onAfterApply;
  }

  enqueue(
    workspaceId: string,
    operation: Omit<TreeOperation, "opId">,
    reason: string
  ): Promise<BatchOperationsResponse> {
    this.pendingCount += 1;
    const queued = async (): Promise<BatchOperationsResponse> => {
      const opWithId: TreeOperation = {
        ...operation,
        opId: createOperationId()
      };

      this.log(`Sending ${operation.type} (${opWithId.opId}) for ${reason}.`);
      const response = await this.apiClient.applyBatchOperations(workspaceId, {
        deviceId: this.getDeviceId(),
        operations: [opWithId]
      });
      if (response._meta) {
        this.onTrace?.(workspaceId, opWithId, reason, response._meta);
      }

      const failed = response.results.find((result) => result.status !== "applied");
      for (const result of response.results) {
        this.log(describeResult(result));
      }

      const eventCursor = response.results.reduce<number | null>((highestCursor, result) => {
        if (typeof result.eventSeq !== "number") {
          return highestCursor;
        }
        return highestCursor === null ? result.eventSeq : Math.max(highestCursor, result.eventSeq);
      }, null);
      if (failed || eventCursor !== null) {
        await this.onAfterApply?.(workspaceId, reason, failed ? null : eventCursor);
      }

      if (failed) {
        throw new RolayOperationError(workspaceId, opWithId, failed);
      }

      return response;
    };

    const task = this.chain.then(queued, queued);
    const trackedTask = task.finally(() => {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
    });
    this.chain = trackedTask.then(() => undefined, () => undefined);
    return trackedTask;
  }

  isIdle(): boolean {
    return this.pendingCount === 0;
  }

  async waitForIdle(): Promise<void> {
    await this.chain;
  }
}

export class RolayOperationError extends Error {
  readonly workspaceId: string;
  readonly operation: TreeOperation;
  readonly result: OperationResult;

  constructor(workspaceId: string, operation: TreeOperation, result: OperationResult) {
    super(`Rolay server returned ${result.status} for ${operation.type}: ${result.reason ?? "unknown"}`);
    this.name = "RolayOperationError";
    this.workspaceId = workspaceId;
    this.operation = operation;
    this.result = result;
  }
}

function createOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `rolay-op-${Date.now()}`;
}

function describeResult(result: OperationResult): string {
  if (result.status === "applied") {
    return `Operation ${result.opId} applied at event ${result.eventSeq ?? "?"}.`;
  }

  const suggested = result.suggestedPath ? ` Suggested path: ${result.suggestedPath}.` : "";
  return `Operation ${result.opId} ${result.status}: ${result.reason ?? "unknown"}.${
    suggested
  }`;
}
