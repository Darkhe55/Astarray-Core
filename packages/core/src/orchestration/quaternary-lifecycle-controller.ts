/**
 * 四级 Agent 生命周期控制器（T08C-06 / ADR-0025 §5）。
 *
 * 三级 Agent 经本地控制面创建四级 Agent：
 * - 四级绑定具体上级三级 agentInstanceId，一次激活只执行上级任务链中
 *   的一个严格子链；
 * - 四级使用新的不可复用 agentInstanceId，独立记忆/缓存/mailbox/
 *   工作存档/worktree；
 * - 四级不能创建第五级；
 * - 四级不能修改上级偏序集、访问兄弟记忆、操作远端项目、写入 mission
 *   集成/目标分支或直接向用户请求权限。
 */
import { DomainError } from "../core/errors.js";
import type { PermissionDecision } from "../tools/permission-capability-catalog.js";
import { quaternaryDelegationSchema } from "./agent-routing-schemas.js";
import { QuaternaryPermissionIntersectionGuard } from "./quaternary-boundary-guards.js";
import type { z } from "zod";

export type QuaternaryLifecycleState =
  | { status: "active"; expiresAtIso: string }
  | { status: "closed"; closedAtIso: string };

export interface QuaternaryLifecycleRecord {
  delegation: z.infer<typeof quaternaryDelegationSchema>;
  lifecycle: QuaternaryLifecycleState;
}

export interface QuaternaryLifecycleControllerOptions {
  /** 创建四级时的身份生成端口（不可复用；默认 UUID 前缀）。 */
  generateQuaternaryAgentInstanceId?: () => string;
  /** 上级三级是否仍活跃（已回收的三级不能再创建四级）。 */
  isTertiaryAgentActive: (tertiaryAgentInstanceId: string) => boolean;
  /**
   * REPAIR（权限求交族）：上级三级的**可委派边界**。
   *
   * 委派声明里的子集字段此前只是"声称"，没有任何校验（`QuaternaryPermissionIntersectionGuard`
   * 在生产里从未被构造）。提供该解析器时，创建四级会校验：
   * - 工具子集 ⊆ 三级允许工具；
   * - 期限不晚于三级期限（复用守卫的求交实现）。
   *
   * **未提供 ⇒ 行为不变**（保持既有兼容），但会被记录为"未校验"。
   */
  resolveTertiaryDelegationBoundary?: (tertiaryAgentInstanceId: string) => {
    readonly allowedToolNames: readonly string[];
    readonly expiresAtIso: string;
    readonly allowedResourceScopes: readonly string[];
    readonly permissionDecision: PermissionDecision;
  } | null;
}

export class QuaternaryLifecycleController {
  private readonly recordsById = new Map<string, QuaternaryLifecycleRecord>();
  private readonly generateQuaternaryAgentInstanceId: () => string;
  private readonly isTertiaryAgentActive: (
    tertiaryAgentInstanceId: string,
  ) => boolean;
  private readonly resolveTertiaryDelegationBoundary:
    | ((tertiaryAgentInstanceId: string) => {
        readonly allowedToolNames: readonly string[];
        readonly expiresAtIso: string;
        readonly allowedResourceScopes: readonly string[];
        readonly permissionDecision: PermissionDecision;
      } | null)
    | undefined;

  constructor(options: QuaternaryLifecycleControllerOptions) {
    this.generateQuaternaryAgentInstanceId =
      options.generateQuaternaryAgentInstanceId ??
      (() => `quaternary-${crypto.randomUUID()}`);
    this.isTertiaryAgentActive = options.isTertiaryAgentActive;
    this.resolveTertiaryDelegationBoundary = options.resolveTertiaryDelegationBoundary;
  }

  /**
   * 三级创建四级：校验委派 schema、上级三级必须活跃、四级身份不可复用、
   * 不得创建第五级（本控制器没有创建第五级入口）。
   */
  createQuaternaryAgent(input: {
    delegation: z.input<typeof quaternaryDelegationSchema>;
  }): QuaternaryLifecycleRecord {
    const parsedDelegation = quaternaryDelegationSchema.safeParse(
      input.delegation,
    );
    if (!parsedDelegation.success) {
      throw new DomainError(
        "invalid-task-chain",
        `四级委派声明非法: ${parsedDelegation.error.message}`,
      );
    }
    const delegation = parsedDelegation.data;
    /**
     * REPAIR（权限求交族）：**验证委派子集确实不宽于三级**。
     * 此前 `allowedToolNamesSubset` / `expiresAtIso` 只是声明，没有任何校验，
     * 而 `QuaternaryPermissionIntersectionGuard` 在生产里从未被构造。
     */
    if (this.resolveTertiaryDelegationBoundary !== undefined) {
      const boundary = this.resolveTertiaryDelegationBoundary(
        delegation.delegatingTertiaryAgentInstanceId,
      );
      if (boundary === null) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "上级三级的可委派边界不可得，拒绝创建四级（不得默认放宽）",
        );
      }
      const extraToolNames = delegation.allowedToolNamesSubset.filter(
        (toolName) => !boundary.allowedToolNames.includes(toolName),
      );
      if (extraToolNames.length > 0) {
        throw new DomainError(
          "task-sequence-permission-denied",
          `四级工具子集超出三级允许范围: ${extraToolNames.join(", ")}`,
        );
      }
      const intersectionGuard = new QuaternaryPermissionIntersectionGuard({
        tertiaryEffectiveDecision: boundary.permissionDecision,
        tertiaryAllowedResourceScopes: [...boundary.allowedResourceScopes],
        tertiaryExpiresAtIso: boundary.expiresAtIso,
      });
      /** 期限求交：结果不得晚于三级期限（复用守卫实现，不另写一套）。 */
      const boundedExpiry = intersectionGuard.computeQuaternaryExpiry(delegation.expiresAtIso);
      if (boundedExpiry !== delegation.expiresAtIso) {
        throw new DomainError(
          "task-sequence-permission-denied",
          `四级期限晚于三级有效期限（应不晚于 ${boundary.expiresAtIso}）`,
        );
      }
    }
    if (!this.isTertiaryAgentActive(delegation.delegatingTertiaryAgentInstanceId)) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `上级三级 Agent 不活跃，不能创建四级: ${delegation.delegatingTertiaryAgentInstanceId}`,
      );
    }
    if (this.recordsById.has(delegation.quaternaryAgentInstanceId)) {
      throw new DomainError(
        "invalid-task-chain",
        `四级 Agent 身份不可复用: ${delegation.quaternaryAgentInstanceId}`,
      );
    }
    const record: QuaternaryLifecycleRecord = {
      delegation,
      lifecycle: { status: "active", expiresAtIso: delegation.expiresAtIso },
    };
    this.recordsById.set(delegation.quaternaryAgentInstanceId, record);
    return record;
  }

  /** 读取四级生命周期记录（不存在返回 null）。 */
  getQuaternaryLifecycle(
    quaternaryAgentInstanceId: string,
  ): QuaternaryLifecycleRecord | null {
    return this.recordsById.get(quaternaryAgentInstanceId) ?? null;
  }

  /** 三级收口四级（任务链完成/中断后）；重复收口幂等。 */
  closeQuaternaryAgent(quaternaryAgentInstanceId: string): boolean {
    const record = this.recordsById.get(quaternaryAgentInstanceId);
    if (record === undefined) {
      return false;
    }
    if (record.lifecycle.status === "closed") {
      return false;
    }
    this.recordsById.set(quaternaryAgentInstanceId, {
      ...record,
      lifecycle: { status: "closed", closedAtIso: new Date().toISOString() },
    });
    return true;
  }

  /** 四级是否仍活跃（未关闭且未到期）。 */
  isQuaternaryAgentActive(
    quaternaryAgentInstanceId: string,
    nowUnixMilliseconds: number,
  ): boolean {
    const record = this.recordsById.get(quaternaryAgentInstanceId);
    if (record === undefined) {
      return false;
    }
    if (record.lifecycle.status === "closed") {
      return false;
    }
    return (
      new Date(record.lifecycle.expiresAtIso).getTime() > nowUnixMilliseconds
    );
  }
}