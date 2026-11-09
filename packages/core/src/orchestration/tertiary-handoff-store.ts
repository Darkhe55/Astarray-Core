/**
 * ALIGN-03-07（2026-11-09）：**移交文件的读入**。
 *
 * 缺口（卡内记录）：`agent-handoffs/` 只写不读 ⇒ 三级关闭后档案无人接手，
 * 收口停在"写了个文件"。
 *
 * 读取必须**校验**，不能把任意文件当移交：
 *  - 版本必须是 1；
 *  - 文件名里的个体与内容里的个体必须一致（防串档）；
 *  - `doesMergeSiblingMemory` 必须为 `false`（不得把兄弟记忆混进来）；
 *  - 损坏文件**如实报错**，不静默当空。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export interface TertiaryHandoffDocument {
  readonly schemaVersion: 1;
  readonly agentInstanceId: string;
  readonly createdAtIso: string;
  readonly memoryArchiveRevision: number | null;
  readonly selectedAttachmentHashes: readonly string[];
  readonly doesMergeSiblingMemory: false;
  readonly note: string;
  /** 文件名（便于追溯"从哪份文件接手"）。 */
  readonly handoffFileName: string;
}

export type ReadTertiaryHandoffOutcome =
  | { readonly kind: "found"; readonly document: TertiaryHandoffDocument }
  | { readonly kind: "absent"; readonly detail: string }
  | { readonly kind: "invalid"; readonly detail: string };

/**
 * 读取该个体**最新**的移交文件。
 *
 * "最新"按文件名里的时间戳排序（写入方保证文件名含 `Date.now()`），
 * 而不是按文件系统 mtime —— mtime 可被复制/恢复改变。
 */
export async function readLatestTertiaryHandoff(input: {
  readonly handoffDirectoryPath: string;
  readonly agentInstanceId: string;
}): Promise<ReadTertiaryHandoffOutcome> {
  let fileNames: string[];
  try {
    fileNames = await fs.readdir(input.handoffDirectoryPath);
  } catch {
    return { kind: "absent", detail: "移交目录不存在（尚未发生任何收口）" };
  }
  const prefix = sanitizeHandoffFileSegment(input.agentInstanceId) + "-";
  const candidateFileNames = fileNames
    .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith(".json"))
    .sort();
  const latestFileName = candidateFileNames.at(-1);
  if (latestFileName === undefined) {
    return { kind: "absent", detail: "该个体没有移交文件" };
  }
  let rawContent: string;
  try {
    rawContent = await fs.readFile(
      path.join(input.handoffDirectoryPath, latestFileName),
      "utf8",
    );
  } catch {
    return { kind: "invalid", detail: "移交文件不可读：" + latestFileName };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return { kind: "invalid", detail: "移交文件不是合法 JSON：" + latestFileName };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "invalid", detail: "移交文件不是对象：" + latestFileName };
  }
  const record = parsed as Partial<TertiaryHandoffDocument>;
  if (record.schemaVersion !== 1) {
    return { kind: "invalid", detail: "不认识的移交文件版本：" + latestFileName };
  }
  if (record.agentInstanceId !== input.agentInstanceId) {
    return {
      kind: "invalid",
      detail:
        "移交文件与请求的个体不一致（防串档）：文件=" +
        String(record.agentInstanceId) +
        " 请求=" +
        input.agentInstanceId,
    };
  }
  if (record.doesMergeSiblingMemory !== false) {
    return { kind: "invalid", detail: "移交文件声明合并兄弟记忆，拒绝接手" };
  }
  return {
    kind: "found",
    document: { ...(record as TertiaryHandoffDocument), handoffFileName: latestFileName },
  };
}

/** 与写入方一致的路径段净化（保证按前缀能找回自己的文件）。 */
function sanitizeHandoffFileSegment(agentInstanceId: string): string {
  /** **必须**与写入方 `sanitizeFileSegment` 完全一致（含 120 字符截断），否则按前缀找不到自己的文件。 */
  return agentInstanceId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
}
