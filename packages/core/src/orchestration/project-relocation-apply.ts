/**
 * RELOCATE-01 检查点 02：**备份/原子应用 + 副本处理**（2026-10-18 第 13 轮）。
 *
 * 依据卡内 §3.4「原子更新登记…失败保留旧登记或明确待恢复，**不出现半提交**」与
 * §3.5「独立打开副本使用**新项目身份及独立历史域**，**不继承**未决任务、许可、
 * 临时权限或 Agent 活跃身份，不改变原项目」。
 *
 * 本模块不直接触碰文件系统：写盘由**注入的端口**完成（未注入 ⇒ fail-closed）。
 */

import type { ProjectLocationRegistrationV1 } from "./project-location-registration.js";
import type { ProjectRelocationConfirmationOutcome } from "./project-relocation-confirmation.js";

/** 写盘端口（实现方负责原子性）。 */
export interface ProjectLocationRegistrationIoPort {
  /** 写入备份（旧登记的完整副本）。 */
  writeBackup(previousRegistration: ProjectLocationRegistrationV1): Promise<void>;
  /** 原子写入新登记。 */
  writeRegistration(nextRegistration: ProjectLocationRegistrationV1): Promise<void>;
}

/** 应用结果。 */
export type ProjectRelocationApplyOutcome =
  | {
      readonly kind: "applied";
      readonly registration: ProjectLocationRegistrationV1;
      /** 幂等重放时为 true（**未重复写盘**）。 */
      readonly isWriteSkipped: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly rejectionCode: "no-io-port" | "confirmation-not-granted" | "backup-failed";
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly rejectionCode: "write-failed";
      /** 是否已把旧登记恢复回去（保证无半提交）。 */
      readonly didRestorePrevious: boolean;
      readonly reason: string;
    };

/**
 * 应用一次已确认的重定位。**顺序固定**：先备份 → 再写新；写新失败则回写旧。
 */
export async function applyProjectRelocation(input: {
  readonly ioPort: ProjectLocationRegistrationIoPort | null;
  readonly previousRegistration: ProjectLocationRegistrationV1;
  readonly confirmation: ProjectRelocationConfirmationOutcome;
}): Promise<ProjectRelocationApplyOutcome> {
  // ① 未注入写盘端口 ⇒ 不得假装成功
  if (input.ioPort === null) {
    return {
      kind: "rejected",
      rejectionCode: "no-io-port",
      reason: "未注入登记写盘端口，拒绝应用重定位（不得假装成功）。",
    };
  }

  // ② 未经确认不得应用（模型代签在确认阶段已拒；此处再守一道）
  if (input.confirmation.kind !== "confirmed") {
    return {
      kind: "rejected",
      rejectionCode: "confirmation-not-granted",
      reason: "重定位尚未获得确认，拒绝写入登记。",
    };
  }

  const { ioPort } = input;
  const nextRegistration = input.confirmation.registration;

  // ③ 幂等重放 ⇒ 不重复写盘
  if (input.confirmation.isIdempotentReplay) {
    return { kind: "applied", registration: nextRegistration, isWriteSkipped: true };
  }

  // ④ 先备份（备份失败 ⇒ 不动登记）
  try {
    await ioPort.writeBackup(input.previousRegistration);
  } catch {
    return {
      kind: "rejected",
      rejectionCode: "backup-failed",
      reason: "备份旧登记失败，已中止重定位（原登记保持不变）。",
    };
  }

  // ⑤ 原子写新登记；失败则回写旧登记
  try {
    await ioPort.writeRegistration(nextRegistration);
    return { kind: "applied", registration: nextRegistration, isWriteSkipped: false };
  } catch {
    let didRestorePrevious = false;
    try {
      await ioPort.writeRegistration(input.previousRegistration);
      didRestorePrevious = true;
    } catch {
      // 保持 false：恢复失败时不得声称已恢复
    }
    return {
      kind: "failed",
      rejectionCode: "write-failed",
      didRestorePrevious,
      reason: didRestorePrevious
        ? "写入新登记失败，已恢复旧登记（无半提交）。"
        : "写入新登记失败且恢复旧登记也失败；需按待恢复处理，不得视为成功。",
    };
  }
}

/** 副本显式**不继承**的状态（全部必须为 0/空）。 */
export interface CopiedProjectInheritedState {
  readonly pendingTaskCount: number;
  readonly outstandingPermissionGrantCount: number;
  readonly temporaryEscalationCount: number;
  readonly activeAgentIdentityCount: number;
}

/** 副本身份创建结果。 */
export type CopiedProjectIdentityOutcome =
  | {
      readonly kind: "created";
      readonly registration: ProjectLocationRegistrationV1;
      readonly inheritedState: CopiedProjectInheritedState;
    }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * 以**独立身份**打开一份副本。
 *
 * - 新标识必须与源不同（副本不得共享身份或历史域）；
 * - revision 从 1 开始、`previousRootPath` 为空（与原项目无迁移关系）；
 * - **不继承**未决任务/许可/临时提升/活跃 Agent 身份。
 */
export function createCopiedProjectIdentity(input: {
  readonly sourceRegistration: ProjectLocationRegistrationV1;
  readonly newProjectIdentifier: string;
  readonly newRootPath: string;
  readonly confirmedAtIso: string;
}): CopiedProjectIdentityOutcome {
  const newIdentifier = input.newProjectIdentifier.trim();
  if (newIdentifier === "") {
    return { kind: "rejected", reason: "未提供副本的新项目标识。" };
  }
  if (newIdentifier === input.sourceRegistration.projectIdentifier) {
    return {
      kind: "rejected",
      reason: "副本必须使用**新项目标识**；沿用源标识会共享身份与历史域。",
    };
  }
  if (input.newRootPath.trim() === "") {
    return { kind: "rejected", reason: "未提供副本的项目根路径。" };
  }

  return {
    kind: "created",
    inheritedState: {
      pendingTaskCount: 0,
      outstandingPermissionGrantCount: 0,
      temporaryEscalationCount: 0,
      activeAgentIdentityCount: 0,
    },
    registration: {
      schemaVersion: 1,
      projectIdentifier: newIdentifier,
      deviceIdentifier: input.sourceRegistration.deviceIdentifier,
      rootPath: input.newRootPath,
      previousRootPath: null,
      locationRevision: 1,
      confirmedBy: "user",
      confirmedAtIso: input.confirmedAtIso,
    },
  };
}
