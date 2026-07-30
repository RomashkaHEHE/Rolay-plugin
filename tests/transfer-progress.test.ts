import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTransferProgressPercent,
  getTransferProgressActivity,
  mergeTransferProgress,
  type TransferProgressAggregate
} from "../src/sync/transfer-progress";

test("keeps completed siblings in a byte-weighted sequential download aggregate", () => {
  let queued: TransferProgressAggregate | undefined;
  queued = mergeTransferProgress(queued, "download", 0, 100, "queued");
  queued = mergeTransferProgress(queued, "download", 0, 100, "queued");
  assert.equal(formatTransferProgressPercent(queued), "0%");

  let halfway: TransferProgressAggregate | undefined;
  halfway = mergeTransferProgress(halfway, "download", 100, 100, "completed");
  halfway = mergeTransferProgress(halfway, "download", 0, 100, "active");
  assert.equal(formatTransferProgressPercent(halfway), "50%");
  assert.equal(getTransferProgressActivity(halfway), "active");
});

test("weights progress by bytes instead of file count", () => {
  let aggregate: TransferProgressAggregate | undefined;
  aggregate = mergeTransferProgress(aggregate, "download", 100, 100, "completed");
  aggregate = mergeTransferProgress(aggregate, "download", 100, 300, "active");

  assert.equal(formatTransferProgressPercent(aggregate), "50%");
});

test("reports queued work as muted until one child becomes active", () => {
  let queued: TransferProgressAggregate | undefined;
  queued = mergeTransferProgress(queued, "upload", 0, 100, "queued");
  queued = mergeTransferProgress(queued, "upload", 0, 100, "queued");

  assert.equal(formatTransferProgressPercent(queued), "0%");
  assert.equal(getTransferProgressActivity(queued), "queued");

  let active: TransferProgressAggregate | undefined;
  active = mergeTransferProgress(active, "upload", 0, 100, "active");
  active = mergeTransferProgress(active, "upload", 0, 100, "queued");
  assert.equal(getTransferProgressActivity(active), "active");
});

test("hides an aggregate only after every item is completed", () => {
  let aggregate: TransferProgressAggregate | undefined;
  aggregate = mergeTransferProgress(aggregate, "download", 100, 100, "completed");
  aggregate = mergeTransferProgress(aggregate, "download", 300, 300, "completed");

  assert.equal(formatTransferProgressPercent(aggregate), "100%");
  assert.equal(getTransferProgressActivity(aggregate), null);
});
