/**
 * GUI-03-05：本地 zip 工具包安装。
 *
 * 安全边界：
 * - 只接受本地 zip；
 * - 不执行安装脚本、不联网；
 * - 解压到临时目录并校验路径；
 * - manifest 与内容 hash 校验；
 * - 复制到受控目录后只登记版本，不自动启用。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  cpSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DomainError } from "../core/errors.js";
import { buildRestrictedSubprocessEnvironment } from "../infra/subprocess-environment-allowlist.js";
import { ToolPackageLifecycleService } from "../toolkit/tool-package-lifecycle-service.js";

const MANIFEST_FILE_NAME = "astarray-tool-package.json";
const MAXIMUM_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_FILE_COUNT = 10_000;

export interface ToolPackageManifest {
  readonly schemaVersion: 1;
  readonly toolPackageId: string;
  readonly version: number;
  readonly entrypoint: string;
  readonly declaredSideEffects: string[];
  readonly declaredDependencies: string[];
  readonly permissionRequirements: string[];
}

export interface ToolPackageZipPreview {
  readonly manifest: ToolPackageManifest;
  readonly contentHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface ToolPackageZipInstallResult extends ToolPackageZipPreview {
  readonly installPath: string;
}

function computeHash(rootDirectory: string): {
  contentHash: string;
  fileCount: number;
  totalBytes: number;
} {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  walk(rootDirectory);
  files.sort();
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    const relative = path.relative(rootDirectory, file).split(path.sep).join("/");
    const content = readFileSync(file);
    totalBytes += content.byteLength;
    hash.update(relative);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return {
    contentHash: "sha256:" + hash.digest("hex"),
    fileCount: files.length,
    totalBytes,
  };
}

function validateManifest(value: unknown): ToolPackageManifest {
  if (value === null || typeof value !== "object") {
    throw new DomainError("invalid-task-chain", "manifest 不是对象。");
  }
  const record = value as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1 ||
    typeof record["toolPackageId"] !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(record["toolPackageId"]) ||
    typeof record["version"] !== "number" ||
    !Number.isInteger(record["version"]) ||
    record["version"] < 1 ||
    typeof record["entrypoint"] !== "string" ||
    record["entrypoint"].trim() === ""
  ) {
    throw new DomainError("invalid-task-chain", "manifest 字段非法。");
  }
  const strings = (key: string): string[] => {
    const raw = record[key];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      throw new DomainError("invalid-task-chain", "manifest " + key + " 非法。");
    }
    return raw as string[];
  };
  const entrypoint = record["entrypoint"];
  if (
    path.isAbsolute(entrypoint) ||
    entrypoint.split(/[\\/]/).includes("..")
  ) {
    throw new DomainError("invalid-task-chain", "manifest entrypoint 越界。");
  }
  return {
    schemaVersion: 1,
    toolPackageId: record["toolPackageId"],
    version: record["version"],
    entrypoint,
    declaredSideEffects: strings("declaredSideEffects"),
    declaredDependencies: strings("declaredDependencies"),
    permissionRequirements: strings("permissionRequirements"),
  };
}

function extractZip(zipPath: string, destination: string): void {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            [
              "$ErrorActionPreference = 'Stop'",
              "Expand-Archive -LiteralPath '" +
                zipPath.replace(/'/g, "''") +
                "' -DestinationPath '" +
                destination.replace(/'/g, "''") +
                "' -Force",
            ].join("; "),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 120_000,
            /** SEC-02-07：解压子进程不继承宿主凭据环境。 */
            env: buildRestrictedSubprocessEnvironment({ hostEnvironment: process.env })
              .environment,
          },
        )
      : spawnSync("unzip", ["-q", zipPath, "-d", destination], {
          encoding: "utf8",
          timeout: 120_000,
          /** SEC-02-07：解压子进程不继承宿主凭据环境。 */
          env: buildRestrictedSubprocessEnvironment({ hostEnvironment: process.env })
            .environment,
        });
  if (result.status !== 0) {
    throw new DomainError(
      "invalid-task-chain",
      "zip 解压失败：" + (result.stderr?.trim() || "未知错误"),
    );
  }
}

export class ToolPackageZipInstaller {
  private readonly packagesDirectory: string;
  private readonly lifecycleService: ToolPackageLifecycleService;

  constructor(options: { baseDirectory: string }) {
    const toolPackagesRoot = path.join(options.baseDirectory, "tool-packages");
    this.packagesDirectory = path.join(toolPackagesRoot, "packages");
    this.lifecycleService = new ToolPackageLifecycleService({
      baseDirectory: options.baseDirectory,
    });
  }

  preview(zipPath: string): ToolPackageZipPreview {
    if (!existsSync(zipPath)) {
      throw new DomainError("invalid-task-chain", "zip 不存在: " + zipPath);
    }
    if (statSync(zipPath).size > MAXIMUM_ARCHIVE_BYTES) {
      throw new DomainError("invalid-task-chain", "zip 超过大小上限。");
    }
    const staging = path.join(
      path.dirname(zipPath),
      ".astarray-tool-staging-" + String(Date.now()),
    );
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      extractZip(zipPath, staging);
      const manifestPath = path.join(staging, MANIFEST_FILE_NAME);
      if (!existsSync(manifestPath)) {
        throw new DomainError("invalid-task-chain", "zip 缺少 " + MANIFEST_FILE_NAME);
      }
      const manifest = validateManifest(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      );
      const hashed = computeHash(staging);
      if (hashed.fileCount > MAXIMUM_FILE_COUNT) {
        throw new DomainError("invalid-task-chain", "工具包文件数超过上限。");
      }
      return { manifest, ...hashed };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async install(input: {
    zipPath: string;
    isConfirmed: boolean;
  }): Promise<ToolPackageZipInstallResult> {
    if (!input.isConfirmed) {
      throw new DomainError("invalid-task-chain", "安装需要用户明确确认。");
    }
    const preview = this.preview(input.zipPath);
    const existing = await this.lifecycleService.list();
    const previous = existing.versions.find(
      (version) =>
        version.registration.toolPackageId === preview.manifest.toolPackageId &&
        version.registration.version === preview.manifest.version,
    );
    if (previous !== undefined) {
      if (previous.registration.contentHash === preview.contentHash) {
        return {
          ...preview,
          installPath: path.join(
            this.packagesDirectory,
            preview.manifest.toolPackageId,
            String(preview.manifest.version),
          ),
        };
      }
      throw new DomainError(
        "invalid-task-chain",
        "同 ID/版本已存在不同内容，拒绝覆盖。",
      );
    }
    const installPath = path.join(
      this.packagesDirectory,
      preview.manifest.toolPackageId,
      String(preview.manifest.version),
    );
    const staging = path.join(
      path.dirname(input.zipPath),
      ".astarray-tool-staging-" + String(Date.now() + 1),
    );
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      extractZip(input.zipPath, staging);
      mkdirSync(path.dirname(installPath), { recursive: true });
      cpSync(staging, installPath, { recursive: true, force: false });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    await this.lifecycleService.install({
      toolPackageId: preview.manifest.toolPackageId,
      version: preview.manifest.version,
      contentHash: preview.contentHash,
      sourceProjectIdentifier: "local-zip",
      declaredSideEffects: preview.manifest.declaredSideEffects,
      declaredDependencies: preview.manifest.declaredDependencies,
      permissionRequirements: preview.manifest.permissionRequirements,
    });
    return { ...preview, installPath };
  }
}
