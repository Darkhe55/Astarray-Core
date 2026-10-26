/** GUI-03-05：本地 zip 工具包安装。 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { ToolPackageLifecycleService } from "../../../packages/core/src/toolkit/tool-package-lifecycle-service.js";
import { ToolPackageZipInstaller } from "../../../packages/core/src/toolkit/tool-package-zip-installer.js";

const directories: string[] = [];
async function createZip(): Promise<{ zipPath: string; baseDirectory: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "astarray-tool-zip-"));
  directories.push(root);
  const packageDirectory = path.join(root, "package");
  await mkdir(path.join(packageDirectory, "src"), { recursive: true });
  await writeFile(
    path.join(packageDirectory, "astarray-tool-package.json"),
    JSON.stringify({
      schemaVersion: 1,
      toolPackageId: "probe-tool",
      version: 1,
      entrypoint: "src/index.js",
      declaredSideEffects: ["file-write"],
      declaredDependencies: [],
      permissionRequirements: ["process.execute-sandboxed"],
    }),
    "utf8",
  );
  await writeFile(path.join(packageDirectory, "src", "index.js"), "export {};\n", "utf8");
  const zipPath = path.join(root, "package.zip");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Compress-Archive -Path '" +
        packageDirectory.replace(/'/g, "''") +
        "\\*' -DestinationPath '" +
        zipPath.replace(/'/g, "''") +
        "' -Force",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return { zipPath, baseDirectory: path.join(root, "state") };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("本地 zip 工具包安装", () => {
  it("① 预览并安装，默认不启用", async () => {
    const { zipPath, baseDirectory } = await createZip();
    const installer = new ToolPackageZipInstaller({ baseDirectory });
    const preview = installer.preview(zipPath);
    expect(preview.manifest.toolPackageId).toBe("probe-tool");
    expect(preview.contentHash.startsWith("sha256:")).toBe(true);
    const result = await installer.install({ zipPath, isConfirmed: true });
    expect(result.installPath).toContain("probe-tool");
    const lifecycle = new ToolPackageLifecycleService({ baseDirectory });
    const snapshot = await lifecycle.list();
    expect(snapshot.versions).toHaveLength(1);
    expect(snapshot.locks).toHaveLength(0);
  });

  it("② 未确认拒绝安装", async () => {
    const { zipPath, baseDirectory } = await createZip();
    const installer = new ToolPackageZipInstaller({ baseDirectory });
    await expect(installer.install({ zipPath, isConfirmed: false })).rejects.toThrow(
      "明确确认",
    );
  });
});
