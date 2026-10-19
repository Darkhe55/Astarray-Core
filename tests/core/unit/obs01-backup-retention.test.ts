/**
 * 备份清理判定的反例（2026-10-20 R102）。
 *
 * 核心纪律：**永远保留最新一份**、不认识的文件名**不删**、`nowIso` 不可解析时不猜测。
 */
import { describe, expect, it } from "vitest";

import {
  parseBackupFileRecordedAtIso,
  planProcessSampleBackupRetention,
} from "../../../packages/core/src/orchestration/process-sample-backup-retention.js";

function backupName(iso: string): string {
  return `process-samples.backup-${iso.replaceAll(":", "-")}.jsonl`;
}

describe("备份清理判定", () => {
  it("① 文件名时间可解析：':' 还原为时间戳", () => {
    expect(parseBackupFileRecordedAtIso(backupName("2026-10-19T12:00:00.000Z"))).toBe(
      "2026-10-19T12:00:00.000Z",
    );
    expect(parseBackupFileRecordedAtIso("process-samples.jsonl")).toBeNull();
    expect(parseBackupFileRecordedAtIso("readme.txt")).toBeNull();
  });

  it("② 都在条数与时限内 ⇒ no-action（不删任何东西）", () => {
    const plan = planProcessSampleBackupRetention({
      backupFileNames: [
        backupName("2026-10-19T11:00:00.000Z"),
        backupName("2026-10-19T10:00:00.000Z"),
      ],
      nowIso: "2026-10-19T12:00:00.000Z",
    });
    expect(plan.kind).toBe("no-action");
    expect(plan.deleteFileNames).toHaveLength(0);
  });

  it("③ 超条数且超时限 ⇒ 只删超出的旧备份，**最新一份永远保留**", () => {
    const names = [0, 1, 2, 3, 4, 5, 6].map((hoursAgo) =>
      backupName(new Date(Date.parse("2026-10-19T12:00:00.000Z") - hoursAgo * 3_600_000).toISOString()),
    );
    const plan = planProcessSampleBackupRetention({
      backupFileNames: names,
      nowIso: "2026-10-19T12:00:00.000Z",
      maximumBackupCount: 3,
      maximumAgeHours: 2,
    });
    expect(plan.kind).toBe("delete-required");
    // 最新一份 + 2 小时内 + 条数内的并集
    expect(plan.keepFileNames).toContain(names[0]);
    expect(plan.deleteFileNames.length).toBeGreaterThan(0);
    // 被删的都是更旧的（不会删比保留项更新的）
    const deletedIsos = plan.deleteFileNames.map((name) => Date.parse(parseBackupFileRecordedAtIso(name) ?? ""));
    const keptIsos = plan.keepFileNames.map((name) => Date.parse(parseBackupFileRecordedAtIso(name) ?? ""));
    expect(Math.min(...deletedIsos)).toBeLessThan(Math.max(...keptIsos));
  });

  it("④ 不认识的文件名 ⇒ 保留并计数（不擅自删）", () => {
    const plan = planProcessSampleBackupRetention({
      backupFileNames: ["process-samples.backup-manual-copy.jsonl", "notes.txt"],
      nowIso: "2026-10-19T12:00:00.000Z",
      maximumBackupCount: 0,
      maximumAgeHours: 0,
    });
    expect(plan.deleteFileNames).toHaveLength(0);
    expect(plan.unparsableFileCount).toBe(2);
    expect(plan.keepFileNames).toEqual(
      expect.arrayContaining(["process-samples.backup-manual-copy.jsonl", "notes.txt"]),
    );
  });

  it("⑤ nowIso 不可解析 ⇒ no-action（不猜测时间，不删）", () => {
    const plan = planProcessSampleBackupRetention({
      backupFileNames: [backupName("2026-01-01T00:00:00.000Z")],
      nowIso: "not-a-time",
    });
    expect(plan.kind).toBe("no-action");
    expect(plan.deleteFileNames).toHaveLength(0);
  });

  it("⑥ 最新一份即使超出条数与时隙也必须保留（安全网不可删）", () => {
    const plan = planProcessSampleBackupRetention({
      backupFileNames: [backupName("2026-01-01T00:00:00.000Z")],
      nowIso: "2026-10-19T12:00:00.000Z",
      maximumBackupCount: 0,
      maximumAgeHours: 1,
    });
    expect(plan.keepFileNames).toContain(backupName("2026-01-01T00:00:00.000Z"));
    expect(plan.deleteFileNames).toHaveLength(0);
  });});

