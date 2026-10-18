/**
 * RELOCATE-01 检查点 02（确认与登记）：**纯状态判定**（2026-10-18 第 12 轮）。
 *
 * 依据卡内 §3：
 * - 3.3「认证用户确认后，以预期位置 revision 提交；执行前重新检查真实路径与身份」；
 * - 3.4「原子更新登记并保存旧根、新根、revision、确认来源与时间。**重复请求幂等**，
 *   **冲突 revision 拒绝并刷新确认**；失败保留旧登记或明确待恢复，**不出现半提交**」；
 * - 3.3 亦明「**未知新位置不能由模型代确认，放权模式也不自动作出身份关联决策**」。
 *
 * 本模块**不写盘**：只计算"是否允许确认、结果是什么"，由调用方做原子写入。
 */

import type { ProjectLocationRegistrationV1 } from "./project-location-registration.js";

/** 拒绝原因（稳定代码，供 UI 提示与测试断言）。 */
export type ProjectRelocationRejectionCode =
  | "not-human-confirmed"
  | "revision-conflict"
  | "identity-mismatch"
  | "invalid-target";

/** 确认结果。 */
export type ProjectRelocationConfirmationOutcome =
  | {
      readonly kind: "confirmed";
      readonly registration: ProjectLocationRegistrationV1;
      /** 是否为**幂等重放**（同 revision + 同目标，未递增 revision）。 */
      readonly isIdempotentReplay: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly rejectionCode: ProjectRelocationRejectionCode;
      readonly reason: string;
    };

/** 确认输入：`isHumanConfirmed` 由本地控制面判定，**不得**来自模型。 */
export interface ProjectRelocationConfirmationInput {
  readonly registration: ProjectLocationRegistrationV1;
  /** 用户在确认卡里看到的预期 revision。 */
  readonly expectedLocationRevision: number;
  /** 用户选择的（新）项目根。 */
  readonly confirmedProjectRootPath: string;
  /** 是否由**认证用户本人**确认（控制面判定）。 */
  readonly isHumanConfirmed: boolean;
  /** 执行前**复检**：当前根实际观测到的项目标识。 */
  readonly currentObservedProjectIdentifier: string | null;
  readonly confirmedAtIso: string;
}

/**
 * 计算确认结果。**fail-closed**：任何不确定都拒绝，且拒绝时不返回新登记（无半提交）。
 */
export function confirmProjectRelocation(
  input: ProjectRelocationConfirmationInput,
): ProjectRelocationConfirmationOutcome {
  // ① 模型/自动流程不得代签（卡内 3.3 明文）
  if (input.isHumanConfirmed !== true) {
    return {
      kind: "rejected",
      rejectionCode: "not-human-confirmed",
      reason:
        "重定位必须由认证用户本人确认；模型与自动流程不得代确认（放权模式也不自动关联身份）。",
    };
  }

  // ② 目标根必须非空（否则无法原子更新）
  if (input.confirmedProjectRootPath.trim() === "") {
    return {
      kind: "rejected",
      rejectionCode: "invalid-target",
      reason: "未提供有效的目标项目根，拒绝更新登记（不产生半提交）。",
    };
  }

  // ③ 执行前复检身份：读不到或与登记不符 ⇒ 拒绝（防止确认后目录被替换）
  if (
    input.currentObservedProjectIdentifier === null ||
    input.currentObservedProjectIdentifier.trim() !== input.registration.projectIdentifier
  ) {
    return {
      kind: "rejected",
      rejectionCode: "identity-mismatch",
      reason:
        "执行前复检失败：当前根的项目标识与登记不一致（目录或符号链接可能在确认后被替换），拒绝更新。",
    };
  }

  // ④ 幂等重放：同 revision + 同目标 ⇒ 不递增
  const isSameTarget = input.confirmedProjectRootPath === input.registration.rootPath;
  if (
    input.expectedLocationRevision === input.registration.locationRevision &&
    isSameTarget
  ) {
    return {
      kind: "confirmed",
      registration: input.registration,
      isIdempotentReplay: true,
    };
  }

  // ⑤ revision 冲突 ⇒ 拒绝并刷新确认（不覆盖他人更新）
  if (input.expectedLocationRevision !== input.registration.locationRevision) {
    return {
      kind: "rejected",
      rejectionCode: "revision-conflict",
      reason: `位置登记已被更新（当前 revision=${String(
        input.registration.locationRevision,
      )}，确认基于 ${String(
        input.expectedLocationRevision,
      )}）；请刷新确认卡后重试，拒绝覆盖较新的登记。`,
    };
  }

  // ⑥ 正常路径：revision + 1，保留旧根，来源固定为用户
  return {
    kind: "confirmed",
    isIdempotentReplay: false,
    registration: {
      schemaVersion: 1,
      projectIdentifier: input.registration.projectIdentifier,
      deviceIdentifier: input.registration.deviceIdentifier,
      rootPath: input.confirmedProjectRootPath,
      previousRootPath: input.registration.rootPath,
      locationRevision: input.registration.locationRevision + 1,
      confirmedBy: "user",
      confirmedAtIso: input.confirmedAtIso,
    },
  };
}
