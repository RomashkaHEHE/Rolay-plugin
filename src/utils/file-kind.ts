export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path.trim());
}

export function isBinaryPath(path: string): boolean {
  return !isMarkdownPath(path);
}

export function guessMimeTypeFromPath(path: string): string {
  const extension = getLowerCaseExtension(path);
  switch (extension) {
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "zip":
      return "application/zip";
    case "7z":
      return "application/x-7z-compressed";
    default:
      return "application/octet-stream";
  }
}

function getLowerCaseExtension(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return "";
  }

  return fileName.slice(dotIndex + 1).toLowerCase();
}
