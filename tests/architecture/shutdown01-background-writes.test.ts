/**
 * 守卫（SHUTDOWN-01，2026-11-17）：后台派生写必须在关闭时收敛。
 *
 * 实证：事件回调里的 `void (async () => …)()` 不被 shutdown 等待，
 * 进程退出会静默丢掉最后一次派生写（drill 用例表现为 ENOENT）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readRuntime(): Promise<string> {
  return fs.readFile(
    path.join(process.cwd(), "packages", "core", "src", "application", "application-runtime.ts"),
    "utf8",
  );
}

describe("后台写收敛守卫", () => {
  it("① 三处事件回调必须登记到 tracker（不得再用裸 void）", async () => {
    const source = await readRuntime();
    const trackedCount = (source.match(/backgroundWrites\.track\(\(async \(\) => \{/gu) ?? []).length;
    const bareVoidCount = (source.match(/void \(async \(\) => \{/gu) ?? []).length;
    expect(trackedCount).toBeGreaterThanOrEqual(3);
    expect(bareVoidCount).toBe(0);
  }, 30_000);

  it("② shutdown 必须在收尾时 drain（有界），且排在 supervisor 之后", async () => {
    const source = await readRuntime();
    const supervisorIndex = source.indexOf("await supervisor?.stop()");
    const drainIndex = source.indexOf("backgroundWrites.drain({");
    expect(supervisorIndex).toBeGreaterThan(-1);
    expect(drainIndex).toBeGreaterThan(supervisorIndex);
    expect(source).toContain("timeoutMilliseconds: 5_000");
  }, 30_000);
});