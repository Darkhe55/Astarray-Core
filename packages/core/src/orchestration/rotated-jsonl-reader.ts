/**
 * R118（2026-11-01）：**读取轮转后的 JSONL 归档**。
 *
 * 归档文件会轮转为 `.1`（次新）…`.N`（最旧）。只读入口要按**从旧到新**拼接，
 * 让导出/查看符合时间顺序；缺失的文件直接跳过。
 */
import { readFile } from "node:fs/promises";

export const DEFAULT_ARCHIVE_ROTATION_READ_COUNT = 2;

export interface RotatedJsonlReadResult {
  /** 从旧到新的非空行。 */
  readonly lines: readonly string[];
  /** 实际读到内容的文件（从旧到新）。 */
  readonly filesRead: readonly string[];
}

export async function readRotatedJsonlLines(input: {
  readonly archivePath: string;
  readonly rotationCount?: number;
}): Promise<RotatedJsonlReadResult> {
  const rotationCount = Math.max(
    0,
    Math.trunc(input.rotationCount ?? DEFAULT_ARCHIVE_ROTATION_READ_COUNT),
  );
  const lines: string[] = [];
  const filesRead: string[] = [];
  // 从最旧（.N）到次新（.1），最后是主文件（最新）。
  for (let index = rotationCount; index >= 1; index -= 1) {
    const filePath = `${input.archivePath}.${String(index)}`;
    const content = await readFile(filePath, "utf8").catch(() => null);
    if (content === null) {
      continue;
    }
    const fileLines = content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    lines.push(...fileLines);
    filesRead.push(filePath);
  }
  const mainContent = await readFile(input.archivePath, "utf8").catch(() => null);
  if (mainContent !== null) {
    lines.push(
      ...mainContent.split(/\r?\n/).filter((line) => line.trim() !== ""),
    );
    filesRead.push(input.archivePath);
  }
  return { lines, filesRead };
}
