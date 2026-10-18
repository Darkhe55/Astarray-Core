/**
 * RELOCATE-01 检查点 01（身份与检测）——**反例先行**（2026-10-18 第 8 轮）。
 *
 * 依据 `docs/tasks/RELOCATE01_COLD_START_PROJECT_RELINK_TASK_CARD.md` §2 的五种冷启动情况：
 *
 * | 情况 | 规定行为 |
 * | --- | --- |
 * | 原路径可访问且身份一致 | 加载历史，进入**只读**恢复对账，**不直接重跑** |
 * | 路径不存在/未挂载/无权限 | 显示原因，待关联；**不自动新建空目录** |
 * | 原路径存在但**身份不同** | **阻止**套用旧历史与项目执行 |
 * | 多个候选**同身份** | 用户选择，**不自动猜测** |
 * | 标识缺失/登记损坏 | 旧格式关联流程，**不伪称验证成功** |
 *
 * 另含 §4 的路径包含规则：**不得用字符串前缀**判包含（`old-project-extra` 不属于 `old-project`）。
 */
import { describe, expect, it } from "vitest";

import {
  SHARED_FALLBACK_PROJECT_IDENTIFIER,
  classifyProjectRelocation,
  isPathInsideProjectRoot,
} from "../../../packages/core/src/orchestration/project-relocation-classification.js";

const baseObservation = {
  registeredProjectIdentifier: "project-alpha",
  registeredRootPath: "D:/work/alpha",
  currentRootPath: "D:/work/alpha",
  isRegisteredRootAccessible: true,
  observedProjectIdentifierAtCurrentRoot: "project-alpha",
  candidateIdentifiersWithSameIdentity: [] as string[],
  isRegistrationCorrupted: false,
};

describe("RELOCATE-01-01：冷启动身份分类（必须 fail-closed）", () => {
  it("① 路径可访问且身份一致 ⇒ 可加载历史，但**执行必须仍被禁止**（只读对账）", () => {
    const outcome = classifyProjectRelocation(baseObservation);
    expect(outcome.classification).toBe("identity-confirmed");
    expect(outcome.isHistoryLoadable).toBe(true);
    // 关键：加载历史 ≠ 批准执行；卡内明令"不直接重跑"
    expect(outcome.isExecutionAllowed).toBe(false);
    expect(outcome.requiredUserAction).toBe("只读恢复对账");
  });

  it("② 路径不可访问 ⇒ 待关联，**不得**加载/执行，且**不得**自动新建空目录", () => {
    const outcome = classifyProjectRelocation({
      ...baseObservation,
      isRegisteredRootAccessible: false,
      observedProjectIdentifierAtCurrentRoot: null,
    });
    expect(outcome.classification).toBe("location-unreachable");
    expect(outcome.isHistoryLoadable).toBe(false);
    expect(outcome.isExecutionAllowed).toBe(false);
    expect(outcome.requiredUserAction).toBe("待用户关联");
    expect(outcome.reason).toContain("不自动新建");
  });

  it("③ 路径存在但**身份不同** ⇒ 阻止套用旧历史与执行（目录复制后 ID 相同也不行）", () => {
    const outcome = classifyProjectRelocation({
      ...baseObservation,
      observedProjectIdentifierAtCurrentRoot: "project-beta",
    });
    expect(outcome.classification).toBe("identity-mismatch");
    expect(outcome.isHistoryLoadable).toBe(false);
    expect(outcome.isExecutionAllowed).toBe(false);
    expect(outcome.requiredUserAction).toBe("阻止套用旧历史");
  });

  it("④ 多个候选**同身份** ⇒ 需用户选择，**不得**自动猜测", () => {
    const outcome = classifyProjectRelocation({
      ...baseObservation,
      candidateIdentifiersWithSameIdentity: ["project-alpha", "project-alpha-copy"],
    });
    expect(outcome.classification).toBe("identity-ambiguous");
    expect(outcome.isHistoryLoadable).toBe(false);
    expect(outcome.isExecutionAllowed).toBe(false);
    expect(outcome.requiredUserAction).toBe("用户选择继续原项目或独立打开");
  });

  it("⑤ 登记损坏或标识缺失 ⇒ 旧格式流程，**不得**伪称验证成功", () => {
    const corrupted = classifyProjectRelocation({
      ...baseObservation,
      isRegistrationCorrupted: true,
    });
    expect(corrupted.classification).toBe("identity-missing");
    expect(corrupted.isHistoryLoadable).toBe(false);
    expect(corrupted.requiredUserAction).toBe("走旧格式关联/恢复流程");

    const missing = classifyProjectRelocation({
      ...baseObservation,
      registeredProjectIdentifier: null,
    });
    expect(missing.classification).toBe("identity-missing");
    expect(missing.isHistoryLoadable).toBe(false);
  });

  it("⑥ 当前根观测到的标识缺失 ⇒ 不能视为身份一致", () => {
    const outcome = classifyProjectRelocation({
      ...baseObservation,
      observedProjectIdentifierAtCurrentRoot: null,
    });
    expect(outcome.classification).toBe("identity-missing");
    expect(outcome.isExecutionAllowed).toBe(false);
  });

  it("⑦ 无登记 ⇒ unregistered（不得因同名/同远端推断身份）", () => {
    const outcome = classifyProjectRelocation({
      ...baseObservation,
      registeredProjectIdentifier: null,
      registeredRootPath: null,
    });
    expect(outcome.classification).toBe("unregistered");
    expect(outcome.isHistoryLoadable).toBe(false);
    expect(outcome.isExecutionAllowed).toBe(false);
  });
  it("⑪ 共享兜底标识 `workspace` ⇒ 不可辨识身份，不得判为身份一致", () => {
    const outcome = classifyProjectRelocation({
      ...baseObservation,
      registeredProjectIdentifier: SHARED_FALLBACK_PROJECT_IDENTIFIER,
      observedProjectIdentifierAtCurrentRoot: SHARED_FALLBACK_PROJECT_IDENTIFIER,
    });
    expect(outcome.classification).toBe("identity-missing");
    expect(outcome.isHistoryLoadable).toBe(false);
    expect(outcome.isExecutionAllowed).toBe(false);
  });
});

describe("RELOCATE-01-01：路径包含判定（禁止字符串前缀）", () => {
  it("⑧ `old-project-extra` **不属于** `old-project`", () => {
    expect(
      isPathInsideProjectRoot({
        projectRootPath: "D:/work/old-project",
        candidatePath: "D:/work/old-project-extra/file.txt",
      }),
    ).toBe(false);
  });

  it("⑨ 子路径属于项目根；`..` 逃逸不属于", () => {
    expect(
      isPathInsideProjectRoot({
        projectRootPath: "D:/work/old-project",
        candidatePath: "D:/work/old-project/src/file.txt",
      }),
    ).toBe(true);
    expect(
      isPathInsideProjectRoot({
        projectRootPath: "D:/work/old-project",
        candidatePath: "D:/work/old-project/../other/file.txt",
      }),
    ).toBe(false);
  });

  it("⑩ Windows 盘符大小写不敏感；POSIX 保留大小写语义", () => {
    expect(
      isPathInsideProjectRoot({
        projectRootPath: "D:/Work/OldProject",
        candidatePath: "d:/work/oldproject/file.txt",
      }),
    ).toBe(true);
    expect(
      isPathInsideProjectRoot({
        projectRootPath: "/home/user/OldProject",
        candidatePath: "/home/user/oldproject/file.txt",
      }),
    ).toBe(false);
  });
});
