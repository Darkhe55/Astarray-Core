/**
 * Vitest 全局设置：测试临时目录卫生。
 *
 * 只在**测试主进程**跑两段：开跑前清扫陈旧残骸、跑完回收本次新建的目录。
 * 不做任何断言、不改变用例行为；失败也绝不让整轮测试变红（残留清理是尽力而为）。
 */
import os from "node:os";

import { createTempDirectoryHygiene } from "./temp-directory-hygiene.js";

/** 视为陈旧残骸的年龄：24 小时（覆盖"上次运行被 SIGKILL"留下的目录）。 */
const STALE_AGE_MILLISECONDS = 24 * 60 * 60 * 1000;

export default async function setup(): Promise<() => Promise<void>> {
  const hygiene = createTempDirectoryHygiene({
    baseDirectory: os.tmpdir(),
    directoryNamePrefixes: ["astarray-"],
    staleAgeMilliseconds: STALE_AGE_MILLISECONDS,
  });

  const beginResult = await hygiene.beginRun();

  return async () => {
    const endResult = await hygiene.endRun();
    const removedTotal =
      beginResult.removedStaleDirectoryCount + endResult.removedCreatedDirectoryCount;
    if (removedTotal > 0) {
      console.log(
        `temp-hygiene: 清理 ${String(beginResult.removedStaleDirectoryCount)} 个陈旧目录 + ` +
          `${String(endResult.removedCreatedDirectoryCount)} 个本次残留；` +
          `剩余 ${String(endResult.remainingDirectoryCount)} 个。`,
      );
    }
  };
}
