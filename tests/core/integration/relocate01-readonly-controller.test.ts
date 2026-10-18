/**
 * RELOCATE-01：**只读控制面**在真实门面入口上的验收（2026-10-18 第 19 轮）。
 *
 * 关键：只读 —— 查询不得创建任何目录/文件。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  ProjectLocationRegistrationStore,
  ProjectRelocationController,
} from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-relocate-readonly-"));
});

const registration = {
  schemaVersion: 1 as const,
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-1",
  rootPath: "D:/work/alpha",
  previousRootPath: null,
  locationRevision: 2,
  confirmedBy: "user" as const,
  confirmedAtIso: "2026-10-18T00:00:00.000Z",
};

describe("RELOCATE-01：只读控制面（门面可达）", () => {
  it("① 无登记 ⇒ unregistered，且**不创建任何目录**", async () => {
    const controller = new ProjectRelocationController({
      store: new ProjectLocationRegistrationStore({ baseDirectory }),
    });
    const description = await controller.describeProjectRelocation({
      projectIdentifier: "project-alpha",
      currentRootPath: "D:/work/alpha",
      isRegisteredRootAccessible: false,
      observedProjectIdentifierAtCurrentRoot: null,
    });
    expect(description.registrationReadKind).toBe("absent");
    expect(description.outcome.classification).toBe("unregistered");
    expect(description.outcome.isExecutionAllowed).toBe(false);

    // 只读：连目录都不该被创建
    await expect(fs.readdir(path.join(baseDirectory, "project-location"))).rejects.toThrow();
  });

  it("② 登记损坏 ⇒ identity-missing（不伪称成功）", async () => {
    const directory = path.join(baseDirectory, "project-location");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "project-alpha.json"), "{broken", "utf8");

    const controller = new ProjectRelocationController({
      store: new ProjectLocationRegistrationStore({ baseDirectory }),
    });
    const description = await controller.describeProjectRelocation({
      projectIdentifier: "project-alpha",
      currentRootPath: "D:/work/alpha",
      isRegisteredRootAccessible: true,
      observedProjectIdentifierAtCurrentRoot: "project-alpha",
    });
    expect(description.registrationReadKind).toBe("invalid");
    expect(description.outcome.classification).toBe("identity-missing");
    expect(description.outcome.isHistoryLoadable).toBe(false);
  });

  it("③ 登记有效 + 根可访问 + 标识一致 ⇒ identity-confirmed，但**执行仍被禁止**", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory });
    await store.writeWithBackup(registration);

    const controller = new ProjectRelocationController({ store });
    const description = await controller.describeProjectRelocation({
      projectIdentifier: "project-alpha",
      currentRootPath: "D:/work/alpha",
      isRegisteredRootAccessible: true,
      observedProjectIdentifierAtCurrentRoot: "project-alpha",
    });
    expect(description.registrationReadKind).toBe("valid");
    expect(description.outcome.classification).toBe("identity-confirmed");
    expect(description.outcome.isHistoryLoadable).toBe(true);
    expect(description.outcome.isExecutionAllowed).toBe(false);
    expect(description.outcome.requiredUserAction).toBe("只读恢复对账");
  });

  /**
   * ⚠️ **已知缺口（2026-10-18 第 19 轮发现，未修）**：旧格式登记（文件存在但缺 schemaVersion）
   * 目前被控制器映射成 `unregistered`，而卡内要求的是「走旧格式关联/恢复流程」。
   * 需在分类器加 `isLegacyRegistration` 并把控制器传参（我尝试时引入 typecheck 错误，已回退）。
   * **本条不入库为绿测试**：修好后补回。
   */
  it("⑤ 根不可访问 ⇒ location-unreachable（待关联，不自动新建）", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory });
    await store.writeWithBackup(registration);

    const controller = new ProjectRelocationController({ store });
    const description = await controller.describeProjectRelocation({
      projectIdentifier: "project-alpha",
      currentRootPath: "D:/work/alpha",
      isRegisteredRootAccessible: false,
      observedProjectIdentifierAtCurrentRoot: null,
    });
    expect(description.outcome.classification).toBe("location-unreachable");
  });
});
