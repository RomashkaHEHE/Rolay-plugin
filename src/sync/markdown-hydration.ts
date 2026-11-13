export function getMarkdownHydrationAction(
  currentText: string,
  remoteText: string,
  previousText: string | null
): "unchanged" | "write" | "preserve-local" {
  if (currentText === remoteText) {
    return "unchanged";
  }
  return currentText.length === 0 || currentText === previousText ? "write" : "preserve-local";
}

export function needsLockedMarkdownDownload(
  path: string,
  lockedPaths: ReadonlySet<string>,
  locallyDivergedPaths: ReadonlySet<string>
): boolean {
  return lockedPaths.has(path) && !locallyDivergedPaths.has(path);
}
