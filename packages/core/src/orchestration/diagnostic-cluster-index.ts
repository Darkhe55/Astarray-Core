import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { DiagnosticClusterGroup } from "./diagnostic-clusterer.js";

/**
 * CLUSTER-01 §4：**派生索引持久化**。
 *
 * 三条边界（卡内原文）：
 * - 只存在应用管理的项目状态目录 `analysis/diagnostic-clusters/`，不进项目源码目录；
 * - **未完成快照不得替换最后完整快照**；
 * - 记录 `schemaVersion` / `algorithmVersion` / 配置指纹 / 数据游标 / 项目 ID / 生成时间 / `snapshotIdentifier`。
 */

export const DIAGNOSTIC_CLUSTER_INDEX_SCHEMA_VERSION = 1;

export interface DiagnosticClusterSnapshot {
  readonly schemaVersion: number;
  readonly algorithmVersion: string;
  readonly configurationFingerprint: string;
  readonly projectIdentifier: string;
  readonly snapshotIdentifier: string;
  readonly generatedAtIso: string;
  /** 数据快照游标：下次扫描从这里继续。 */
  readonly cursor: { readonly byteOffset: number; readonly lineNumber: number };
  /** 是否覆盖到源文件末尾；false 表示受上限截断的 partial。 */
  readonly isComplete: boolean;
  readonly partialReason: string | null;
  readonly groups: readonly DiagnosticClusterGroup[];
}

export interface BuildDiagnosticClusterSnapshotInput {
  readonly algorithmVersion: string;
  readonly projectIdentifier: string;
  readonly generatedAtIso: string;
  readonly cursor: { readonly byteOffset: number; readonly lineNumber: number };
  readonly isComplete: boolean;
  readonly partialReason?: string | null;
  readonly groups: readonly DiagnosticClusterGroup[];
  /** 参与聚类的参数（阈值、上限等），用于判断旧索引是否还能复用。 */
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
}

/** 配置指纹：参数变了旧索引就不能复用（§4"配置指纹"）。 */
export function computeConfigurationFingerprint(
  configuration: Readonly<Record<string, string | number | boolean>>,
): string {
  const canonical = Object.keys(configuration)
    .sort()
    .map((key) => `${key}=${String(configuration[key])}`)
    .join("&");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function buildDiagnosticClusterSnapshot(
  input: BuildDiagnosticClusterSnapshotInput,
): DiagnosticClusterSnapshot {
  const configurationFingerprint = computeConfigurationFingerprint(input.configuration);
  const snapshotIdentifier = createHash("sha256")
    .update(
      [
        input.projectIdentifier,
        input.generatedAtIso,
        String(input.cursor.byteOffset),
        String(input.cursor.lineNumber),
        String(input.isComplete),
        configurationFingerprint,
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return {
    schemaVersion: DIAGNOSTIC_CLUSTER_INDEX_SCHEMA_VERSION,
    algorithmVersion: input.algorithmVersion,
    configurationFingerprint,
    projectIdentifier: input.projectIdentifier,
    snapshotIdentifier,
    generatedAtIso: input.generatedAtIso,
    cursor: { byteOffset: input.cursor.byteOffset, lineNumber: input.cursor.lineNumber },
    isComplete: input.isComplete,
    partialReason: input.isComplete ? null : (input.partialReason ?? "partial-scan"),
    groups: input.groups,
  };
}

/** 项目级索引目录（放在状态目录下，绝不落在源码目录）。 */
export function resolveClusterIndexDirectory(stateDirectory: string, projectIdentifier: string): string {
  /** 项目 ID 可能含路径分隔符 ⇒ 用哈希目录名，避免路径穿越。 */
  const safeName = createHash("sha256").update(projectIdentifier, "utf8").digest("hex").slice(0, 16);
  return path.join(stateDirectory, "analysis", "diagnostic-clusters", safeName);
}

export interface SaveClusterSnapshotResult {
  readonly snapshotFilePath: string;
  /** partial 快照不会更新 `latest.json`。 */
  readonly latestFilePath: string | null;
}

/**
 * 保存快照：快照文件永远落盘（可追溯）；
 * **只有 `isComplete` 才更新 `latest.json`** ⇒ 未完成扫描不会顶掉最后一次完整结果。
 */
export async function saveDiagnosticClusterSnapshot(input: {
  readonly stateDirectory: string;
  readonly snapshot: DiagnosticClusterSnapshot;
}): Promise<SaveClusterSnapshotResult> {
  const directory = resolveClusterIndexDirectory(input.stateDirectory, input.snapshot.projectIdentifier);
  await fs.mkdir(directory, { recursive: true });
  const snapshotFilePath = path.join(directory, `snapshot-${input.snapshot.snapshotIdentifier}.json`);
  await writeJsonAtomically(snapshotFilePath, input.snapshot);

  if (!input.snapshot.isComplete) {
    return { snapshotFilePath, latestFilePath: null };
  }
  const latestFilePath = path.join(directory, "latest.json");
  await writeJsonAtomically(latestFilePath, { snapshotIdentifier: input.snapshot.snapshotIdentifier });
  return { snapshotFilePath, latestFilePath };
}

/** 读取最后**完整**快照；缺失、损坏或版本不符一律返回 null（不得当成"无错误"）。 */
export async function readLatestDiagnosticClusterSnapshot(input: {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
}): Promise<DiagnosticClusterSnapshot | null> {
  const directory = resolveClusterIndexDirectory(input.stateDirectory, input.projectIdentifier);
  try {
    const pointerRaw = await fs.readFile(path.join(directory, "latest.json"), "utf8");
    const pointer = JSON.parse(pointerRaw) as { snapshotIdentifier?: unknown };
    if (typeof pointer.snapshotIdentifier !== "string") return null;
    const snapshotRaw = await fs.readFile(
      path.join(directory, `snapshot-${pointer.snapshotIdentifier}.json`),
      "utf8",
    );
    const snapshot = JSON.parse(snapshotRaw) as DiagnosticClusterSnapshot;
    if (snapshot.schemaVersion !== DIAGNOSTIC_CLUSTER_INDEX_SCHEMA_VERSION) return null;
    return snapshot;
  } catch {
    return null;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(value), "utf8");
  await fs.rename(temporaryPath, filePath);
}
