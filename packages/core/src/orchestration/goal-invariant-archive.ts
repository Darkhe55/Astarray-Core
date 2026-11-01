/**
 * R112（2026-11-01）：**不变量违规归档的轮转**。
 *
 * 归档文件只追加会无限增长；这里用与判定记录一致的口径：超过行数上限即轮转，
 * 保留最近 N 份（`.1` 最新，依次更旧），更旧的删除。
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export const GOAL_INVARIANT_ARCHIVE_MAXIMUM_LINES = 5_000;
export const GOAL_INVARIANT_ARCHIVE_RETENTION_COUNT = 2;

/** 行数超过上限时轮转；返回是否发生了轮转。 */
export async function rotateInvariantViolationArchiveIfNeeded(input: {
  readonly archivePath: string;
  readonly maximumLines?: number;
  readonly retentionCount?: number;
}): Promise<boolean> {
  const maximumLines =
    input.maximumLines ?? GOAL_INVARIANT_ARCHIVE_MAXIMUM_LINES;
  const retentionCount =
    input.retentionCount ?? GOAL_INVARIANT_ARCHIVE_RETENTION_COUNT;
  const content = await readFile(input.archivePath, "utf8").catch(() => null);
  if (content === null) {
    return false;
  }
  const lineCount = content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "").length;
  if (lineCount <= maximumLines) {
    return false;
  }
  // 依次后移：.N-1 → .N，最旧的删除。
  for (let index = retentionCount - 1; index >= 1; index -= 1) {
    const source = `${input.archivePath}.${String(index)}`;
    const target = `${input.archivePath}.${String(index + 1)}`;
    await rename(source, target).catch(() => undefined);
  }
  if (retentionCount >= 1) {
    await rename(input.archivePath, `${input.archivePath}.1`).catch(() => undefined);
  }
  await rm(`${input.archivePath}.${String(retentionCount + 1)}`, {
    force: true,
  }).catch(() => undefined);
  await writeFile(input.archivePath, "", "utf8").catch(() => undefined);
  return true;
}
