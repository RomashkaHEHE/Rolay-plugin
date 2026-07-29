import assert from "node:assert/strict";
import test from "node:test";
import type { RolayApiClient } from "../src/api/client";
import { OperationsQueue, RolayOperationError } from "../src/sync/operations";
import type {
  BatchOperationsResponse,
  TreeOperation
} from "../src/types/protocol";

test("passes the applied operation event cursor to the refresh callback", async () => {
  const callbacks: Array<[string, string, number | null]> = [];
  const queue = createQueue(
    {
      results: [
        {
          opId: "server-op",
          status: "applied",
          eventSeq: 42
        }
      ]
    },
    (...args) => callbacks.push(args)
  );

  await queue.enqueue("workspace-1", operation(), "local-create");

  assert.deepEqual(callbacks, [["workspace-1", "local-create", 42]]);
});

test("does not refresh after an idempotent applied result without an event", async () => {
  const callbacks: Array<[string, string, number | null]> = [];
  const queue = createQueue(
    {
      results: [
        {
          opId: "server-op",
          status: "applied"
        }
      ]
    },
    (...args) => callbacks.push(args)
  );

  await queue.enqueue("workspace-1", operation(), "identical-server-no-op");

  assert.deepEqual(callbacks, []);
});

test("forces reconciliation after a conflict even if it includes an event cursor", async () => {
  const callbacks: Array<[string, string, number | null]> = [];
  const queue = createQueue(
    {
      results: [
        {
          opId: "server-op",
          status: "conflict",
          eventSeq: 43,
          reason: "entry version changed"
        }
      ]
    },
    (...args) => callbacks.push(args)
  );

  await assert.rejects(
    queue.enqueue("workspace-1", operation(), "rename-conflict"),
    RolayOperationError
  );

  assert.deepEqual(callbacks, [["workspace-1", "rename-conflict", null]]);
});

function createQueue(
  response: BatchOperationsResponse,
  onAfterApply: (
    workspaceId: string,
    reason: string,
    eventCursor: number | null
  ) => void
): OperationsQueue {
  const apiClient = {
    applyBatchOperations: async () => response
  } as unknown as RolayApiClient;

  return new OperationsQueue({
    apiClient,
    getDeviceId: () => "device-1",
    log: () => undefined,
    onAfterApply
  });
}

function operation(): Omit<TreeOperation, "opId"> {
  return {
    type: "create_folder",
    path: "Folder"
  };
}
