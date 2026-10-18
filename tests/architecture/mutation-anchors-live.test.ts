/**
 * 活规则：变异体的锚点必须**仍然有效**（2026-10-19 R35）。
 *
 * 事故：`run-history-view-ignores-cursor` 的 `find` 在 R4 之后的源码改动中失效，
 * 这条变异体**长期空转**（从未真正注入反事实），却只有在跑全量变异时才报出来。
 *
 * 本测试把 harness 的 `--check-anchors` 模式变成**秒级**守卫：任一锚点命中次数 ≠ 1 即红。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..");

describe("变异锚点活性", () => {
  it("全部变异体的 targetFile/find 仍恰好命中 1 次（失效即红）", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts/verify-mutation-kills.mjs"), "--check-anchors"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status, `锚点自检失败：\n${output}`).toBe(0);
    // 防空转：至少要真的检查了 100 条以上
    const matchedCount = output.match(/锚点自检：(\d+)\/(\d+) 条有效/);
    expect(matchedCount).not.toBeNull();
    const totalCount = Number(matchedCount?.[2] ?? 0);
    expect(totalCount).toBeGreaterThan(100);
  });
});
