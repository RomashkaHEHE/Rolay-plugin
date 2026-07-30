export type TransferProgressKind = "upload" | "download";
export type TransferProgressActivity = "active" | "queued" | "completed";

export interface TransferProgressAggregate {
  kind: TransferProgressKind;
  completedBytes: number;
  totalBytes: number;
  itemCount: number;
  unfinishedItemCount: number;
  activeItemCount: number;
}

export function mergeTransferProgress(
  existing: TransferProgressAggregate | undefined,
  kind: TransferProgressKind,
  completedBytes: number,
  totalBytes: number,
  activity: TransferProgressActivity
): TransferProgressAggregate {
  const normalizedTotalBytes = Math.max(1, Math.trunc(totalBytes));
  const normalizedCompletedBytes = Math.max(
    0,
    Math.min(Math.trunc(completedBytes), normalizedTotalBytes)
  );
  const unfinished = activity === "completed" ? 0 : 1;
  const active = activity === "active" ? 1 : 0;

  if (!existing) {
    return {
      kind,
      completedBytes: normalizedCompletedBytes,
      totalBytes: normalizedTotalBytes,
      itemCount: 1,
      unfinishedItemCount: unfinished,
      activeItemCount: active
    };
  }

  return {
    kind: existing.kind === "download" || kind === "download" ? "download" : "upload",
    completedBytes: existing.completedBytes + normalizedCompletedBytes,
    totalBytes: existing.totalBytes + normalizedTotalBytes,
    itemCount: existing.itemCount + 1,
    unfinishedItemCount: existing.unfinishedItemCount + unfinished,
    activeItemCount: existing.activeItemCount + active
  };
}

export function formatTransferProgressPercent(state: TransferProgressAggregate): string {
  if (state.totalBytes <= 0) {
    return "0%";
  }

  const percent = Math.round((state.completedBytes / state.totalBytes) * 100);
  return `${Math.max(0, Math.min(100, percent))}%`;
}

export function getTransferProgressActivity(
  state: TransferProgressAggregate
): Exclude<TransferProgressActivity, "completed"> | null {
  if (state.unfinishedItemCount <= 0) {
    return null;
  }

  return state.activeItemCount > 0 ? "active" : "queued";
}
