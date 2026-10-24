/**
 * 上下文包（2026-10-24 用户选择的设计）：
 *
 * 上游插入任务时可以声明「哪些信息是一个整体」，装配器据此决定：
 * - `atomic`：整包注入，**不拆分**（放不下时由预算层整包延后，而不是丢成员）；
 * - `summarize-allowed`：允许对包内成员摘要；
 * - `separate`：独立成组，**不与其他包合并**。
 *
 * 本模块只做纯判定与渲染（无 I/O），装配器与任务插入契约共用同一套校验。
 */
import { DomainError } from "../core/errors.js";

export type ContextPackMergePolicy = "atomic" | "summarize-allowed" | "separate";

export type ContextPackMemberSourceKind =
  | "user"
  | "agent"
  | "tool"
  | "file"
  | "decision"
  | "evidence";

export interface ContextPackMember {
  readonly memberIdentifier: string;
  readonly sourceKind: ContextPackMemberSourceKind;
  /** 已脱敏/已截断的成员摘要（原文仍由来源自持）。 */
  readonly summary: string;
  readonly contentFingerprint?: string | null;
}

export interface ContextPack {
  readonly packIdentifier: string;
  readonly mergePolicy: ContextPackMergePolicy;
  readonly sourcePriority: "user" | "agent" | "tool";
  readonly members: ReadonlyArray<ContextPackMember>;
}

const MEMBER_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "user",
  "agent",
  "tool",
  "file",
  "decision",
  "evidence",
]);
const MERGE_POLICIES: ReadonlySet<string> = new Set([
  "atomic",
  "summarize-allowed",
  "separate",
]);

/** 返回空数组 = 合法；否则为可解释的拒绝原因（fail-closed）。 */
export function validateContextPack(pack: ContextPack): ReadonlyArray<string> {
  const reasons: string[] = [];
  if (typeof pack.packIdentifier !== "string" || pack.packIdentifier.trim() === "") {
    reasons.push("packIdentifier 不能为空");
  }
  if (!MERGE_POLICIES.has(pack.mergePolicy)) {
    reasons.push("mergePolicy 未知：" + String(pack.mergePolicy));
  }
  if (!["user", "agent", "tool"].includes(pack.sourcePriority)) {
    reasons.push("sourcePriority 未知：" + String(pack.sourcePriority));
  }
  if (!Array.isArray(pack.members) || pack.members.length === 0) {
    reasons.push("上下文包至少需要一个成员（空包不得冒充整体）");
  }
  const seen = new Set<string>();
  for (const member of pack.members ?? []) {
    if (
      typeof member.memberIdentifier !== "string" ||
      member.memberIdentifier.trim() === ""
    ) {
      reasons.push("成员缺少 memberIdentifier");
      continue;
    }
    if (seen.has(member.memberIdentifier)) {
      reasons.push("成员标识重复：" + member.memberIdentifier);
    }
    seen.add(member.memberIdentifier);
    if (!MEMBER_SOURCE_KINDS.has(member.sourceKind)) {
      reasons.push("成员来源未知：" + String(member.sourceKind));
    }
    if (typeof member.summary !== "string" || member.summary.trim() === "") {
      reasons.push("成员缺少摘要：" + member.memberIdentifier);
    }
  }
  return reasons;
}

/** 校验并在非法时抛 DomainError（任务插入契约使用）。 */
export function assertContextPackValid(pack: ContextPack): void {
  const reasons = validateContextPack(pack);
  if (reasons.length > 0) {
    throw new DomainError(
      "context-pack-invalid",
      "上下文包非法：" + reasons.join("；"),
    );
  }
}

export interface RenderedContextPacks {
  readonly lines: ReadonlyArray<string>;
  readonly injectedPackIdentifiers: ReadonlyArray<string>;
}

/**
 * 渲染上下文包区块：
 * - `atomic` 包内成员一定成组出现；
 * - `separate` 包各自独立小节（不合并）；
 * - `summarize-allowed` 标注允许摘要（由预算/摘要层决定实际动作）。
 */
export function renderContextPacks(
  packs: ReadonlyArray<ContextPack>,
): RenderedContextPacks {
  const lines: string[] = [];
  const injectedPackIdentifiers: string[] = [];
  if (packs.length === 0) {
    lines.push("- （无上下文包）");
    return { lines, injectedPackIdentifiers };
  }
  for (const pack of packs) {
    if (validateContextPack(pack).length > 0) continue;
    injectedPackIdentifiers.push(pack.packIdentifier);
    const policyLabel =
      pack.mergePolicy === "atomic"
        ? "atomic：整包注入，不拆分"
        : pack.mergePolicy === "separate"
          ? "separate：独立成组，不与其他包合并"
          : "summarize-allowed：允许摘要";
    lines.push(
      "- 包 " + pack.packIdentifier + "（" + policyLabel + "，来源：" + pack.sourcePriority + "）",
    );
    for (const member of pack.members) {
      lines.push(
        "  - " +
          member.sourceKind +
          "/" +
          member.memberIdentifier +
          "：" +
          member.summary,
      );
    }
  }
  return { lines, injectedPackIdentifiers };
}
