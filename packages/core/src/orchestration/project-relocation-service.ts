/**
 * RELOCATE-01-03（2026-10-24，用户"按建议做"）：**控制面重定位服务**。
 *
 * 组合既有三块（不重复实现判定）：
 * 1. `confirmProjectRelocation`：用户本人确认 + 身份复检 + revision 锚点；
 * 2. `applyProjectRelocation`：先备份再原子写，失败回写旧登记（无半提交）；
 * 3. `ProjectLocationRegistrationStore`：实际落盘（含 `.bak`）。
 *
 * 纪律：
 * - 未登记/旧格式/损坏 ⇒ 拒绝（不覆盖、不猜）；
 * - 新根不可达或身份不符 ⇒ 拒绝；
 * - `previousRootPath` 保留旧根、`locationRevision + 1`、`confirmedBy: "user"`；
 * - 重定位**不代表**批准执行旧任务（调用方不得据此自动重跑）。
 */
import type { ProjectLocationRegistrationStore } from "./project-location-registration-store.js";
import type { ProjectLocationRegistrationV1 } from "./project-location-registration.js";
import { confirmProjectRelocation } from "./project-relocation-confirmation.js";
import { applyProjectRelocation } from "./project-relocation-apply.js";

export type RelocateProjectOutcome =
  | { readonly kind: "applied"; readonly registration: ProjectLocationRegistrationV1 }
  | { readonly kind: "rejected"; readonly reasonCode: string; readonly reason: string };

export async function relocateProjectRegistration(input: {
  readonly store: ProjectLocationRegistrationStore;
  readonly projectIdentifier: string;
  readonly newRootPath: string;
  /** 在新根实际观测到的项目标识（必须与目标一致）。 */
  readonly observedProjectIdentifierAtNewRoot: string | null;
  readonly isNewRootAccessible: boolean;
  readonly expectedLocationRevision: number;
  /** 只有用户本人确认才允许写入。 */
  readonly isHumanConfirmed: boolean;
  readonly confirmedAtIso: string;
}): Promise<RelocateProjectOutcome> {
  if (!input.isNewRootAccessible) {
    return {
      kind: "rejected",
      reasonCode: "new-root-not-accessible",
      reason: "新根路径不可访问：不写登记（保留旧登记）。",
    };
  }

  let readOutcome;
  try {
    readOutcome = await input.store.read(input.projectIdentifier);
  } catch (error) {
    return {
      kind: "rejected",
      reasonCode: "registration-unreadable",
      reason: "读取项目登记失败：" + (error instanceof Error ? error.message : String(error)),
    };
  }
  if (readOutcome.kind !== "valid") {
    return {
      kind: "rejected",
      reasonCode: readOutcome.kind === "absent" ? "not-registered" : "registration-invalid",
      reason:
        readOutcome.kind === "absent"
          ? "项目尚未登记：需先建立登记（不自动创建）。"
          : "登记不可用（" + readOutcome.reason + "）：需显式关联/恢复，不自动覆盖。",
    };
  }
  const registration = readOutcome.registration;
  if (registration.rootPath === input.newRootPath) {
    return {
      kind: "rejected",
      reasonCode: "same-root",
      reason: "新根与当前登记根相同：无需重定位。",
    };
  }
  if (registration.locationRevision !== input.expectedLocationRevision) {
    return {
      kind: "rejected",
      reasonCode: "stale-location-revision",
      reason:
        "登记 revision 已变化（期望 " +
        String(input.expectedLocationRevision) +
        "，当前 " +
        String(registration.locationRevision) +
        "）：请重新读取后重试。",
    };
  }

  const confirmation = confirmProjectRelocation({
    registration,
    expectedLocationRevision: input.expectedLocationRevision,
    confirmedProjectRootPath: input.newRootPath,
    isHumanConfirmed: input.isHumanConfirmed,
    currentObservedProjectIdentifier: input.observedProjectIdentifierAtNewRoot,
    confirmedAtIso: input.confirmedAtIso,
  });
  if (confirmation.kind !== "confirmed") {
    return {
      kind: "rejected",
      reasonCode: confirmation.rejectionCode,
      reason: confirmation.reason,
    };
  }

  const applied = await applyProjectRelocation({
    ioPort: {
      // 先写一份旧登记（store 自身会保留 .bak），再写新登记；失败由 apply 回写旧登记。
      writeBackup: async (previous) => {
        await input.store.writeWithBackup(previous);
      },
      writeRegistration: async (next) => {
        await input.store.writeWithBackup(next);
      },
    },
    previousRegistration: registration,
    confirmation,
  });
  if (applied.kind === "applied") {
    return { kind: "applied", registration: applied.registration };
  }
  return {
    kind: "rejected",
    reasonCode: applied.rejectionCode,
    reason: applied.reason,
  };
}
