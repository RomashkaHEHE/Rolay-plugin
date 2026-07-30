import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = await mkdtemp(path.join(tmpdir(), "rolay-plugin-tests-"));
const entryPoints = [
  path.join(testsDirectory, "operations.test.ts"),
  path.join(testsDirectory, "snapshot-refresh.test.ts"),
  path.join(testsDirectory, "transfer-progress.test.ts")
];

try {
  const buildResult = await esbuild.build({
    entryPoints,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outdir: outputDirectory,
    entryNames: "[name]",
    write: true
  });

  if (buildResult.errors.length > 0) {
    process.exitCode = 1;
  } else {
    const outputFiles = entryPoints.map((entryPoint) =>
      path.join(
        outputDirectory,
        `${path.basename(entryPoint, path.extname(entryPoint))}.js`
      )
    );
    const testResult = spawnSync(process.execPath, ["--test", ...outputFiles], {
      stdio: "inherit"
    });
    process.exitCode = testResult.status ?? 1;
  }
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
