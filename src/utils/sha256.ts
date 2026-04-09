export async function sha256Hash(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? Uint8Array.from(data) : new Uint8Array(data);

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return normalizeSha256Hash(bytesToBase64(new Uint8Array(digest))) ?? "";
  }

  const nodeRequire = getNodeRequire();
  if (nodeRequire) {
    const { createHash } = nodeRequire("node:crypto") as {
      createHash: (algorithm: string) => {
        update: (value: Uint8Array) => void;
        digest: (encoding?: "hex" | "base64") => string | Uint8Array;
      };
    };
    const hash = createHash("sha256");
    hash.update(bytes);
    const digest = hash.digest("base64");
    return normalizeSha256Hash(typeof digest === "string" ? digest : bytesToBase64(digest)) ?? "";
  }

  throw new Error("No SHA-256 implementation is available in this environment.");
}

export const sha256Hex = sha256Hash;

export function normalizeSha256Hash(hash: string | null | undefined): string | null {
  if (typeof hash !== "string") {
    return null;
  }

  const trimmed = hash.trim();
  if (!trimmed) {
    return null;
  }

  const digest = trimmed.replace(/^sha256:/i, "");
  if (!digest) {
    return null;
  }

  const canonicalBase64 = canonicalizeDigestToBase64(digest);
  if (canonicalBase64) {
    return `sha256:${canonicalBase64}`;
  }

  return `sha256:${digest}`;
}

function getNodeRequire(): ((id: string) => unknown) | null {
  const candidate =
    (globalThis as { require?: (id: string) => unknown }).require ??
    (globalThis as { window?: { require?: (id: string) => unknown } }).window?.require;

  if (typeof candidate === "function") {
    return candidate;
  }

  try {
    return (Function("return typeof require === 'function' ? require : undefined;")() as
      | ((id: string) => unknown)
      | undefined
      | null) ?? null;
  } catch {
    return null;
  }
}

function canonicalizeDigestToBase64(digest: string): string | null {
  const bytes = decodeDigestToBytes(digest);
  if (!bytes || bytes.length !== 32) {
    return null;
  }

  return bytesToBase64(bytes);
}

function decodeDigestToBytes(digest: string): Uint8Array | null {
  if (/^[0-9a-f]{64}$/i.test(digest)) {
    return decodeHexDigest(digest);
  }

  return decodeBase64Digest(digest);
}

function decodeHexDigest(digest: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    return null;
  }

  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    const offset = index * 2;
    bytes[index] = Number.parseInt(digest.slice(offset, offset + 2), 16);
  }
  return bytes;
}

function decodeBase64Digest(digest: string): Uint8Array | null {
  const paddedDigest = padBase64(digest.trim());
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(paddedDigest)) {
    return null;
  }

  const nodeRequire = getNodeRequire();
  if (nodeRequire) {
    try {
      const { Buffer } = nodeRequire("node:buffer") as {
        Buffer: {
          from: (value: string, encoding: "base64") => Uint8Array;
        };
      };
      return Uint8Array.from(Buffer.from(paddedDigest, "base64"));
    } catch {
      return null;
    }
  }

  if (typeof globalThis.atob === "function") {
    try {
      const decoded = globalThis.atob(paddedDigest);
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  return null;
}

function padBase64(value: string): string {
  const remainder = value.length % 4;
  if (remainder === 0) {
    return value;
  }

  return value.padEnd(value.length + (4 - remainder), "=");
}

function bytesToBase64(bytes: Uint8Array): string {
  const nodeRequire = getNodeRequire();
  if (nodeRequire) {
    const { Buffer } = nodeRequire("node:buffer") as {
      Buffer: {
        from: (value: Uint8Array) => { toString: (encoding: "base64") => string };
      };
    };
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(binary);
  }

  throw new Error("No base64 encoder is available in this environment.");
}
