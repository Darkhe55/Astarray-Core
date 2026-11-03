/**
 * GUI-04-01（2026-11-03）：**作用域权限覆盖的放宽预览与确认**。
 *
 * 规则（卡内 §2）：
 * - 收紧可直接保存；**放宽**必须先由服务端生成预览（目标、逐项差异、revision、主体、有效期、指纹），
 *   再由用户**单独确认**；
 * - 确认只对这一份变更有效：改参数/过期/revision 冲突 ⇒ 必须重新预览；
 * - 同一预览重复确认 ⇒ 幂等返回原结果，不重复写；
 * - 主体由服务端注入（调用方不得从正文自报）。
 */
import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { PermissionProfileStore } from "../tools/permission-profile-store.js";
import type { PermissionProfileReference } from "../tools/permission-profile-store.js";
import type { ScopedSettingsDocument, ScopedSettingsStore } from "./scoped-settings-store.js";

type PermissionDecision = "deny" | "ask" | "allow";

const BUILTIN_PROFILE_IDS = new Set(["ponder", "assist", "devolve"]);

/** 目标 profile 引用：显式 kind 优先；否则按保留名推断（内置/自定义）。 */
function resolveTargetReference(
  profileId: string,
  kind: "builtin" | "custom" | undefined,
): PermissionProfileReference {
  if (kind === "builtin") {
    return { kind: "builtin", profileId: profileId as "ponder" | "assist" | "devolve" };
  }
  if (kind === "custom") {
    return { kind: "custom", profileId };
  }
  return BUILTIN_PROFILE_IDS.has(profileId)
    ? { kind: "builtin", profileId: profileId as "ponder" | "assist" | "devolve" }
    : { kind: "custom", profileId };
}

const DECISION_ORDER: Record<PermissionDecision, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

export const DEFAULT_PERMISSION_PREVIEW_TTL_MILLISECONDS = 10 * 60 * 1000;

export interface ScopedPermissionChange {
  readonly capabilityId: string;
  readonly previousDecision: PermissionDecision;
  readonly nextDecision: PermissionDecision;
}

export interface ScopedPermissionChangePreview {
  readonly previewIdentifier: string;
  readonly fingerprint: string;
  readonly isWidening: boolean;
  readonly changes: readonly ScopedPermissionChange[];
  readonly scope: "project" | "session";
  readonly identifier: string;
  readonly permissionProfileId: string;
  readonly expectedRevision: number;
  readonly subjectIdentifier: string;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
}

export interface ScopedPermissionChangeServiceOptions {
  readonly profileStore: PermissionProfileStore;
  readonly scopedStore: ScopedSettingsStore;
  readonly nowMilliseconds?: () => number;
  readonly previewTtlMilliseconds?: number;
}

interface StoredPreview extends ScopedPermissionChangePreview {
  readonly currentProfileReference: PermissionProfileReference | null;
  readonly confirmedDocument: ScopedSettingsDocument | null;
}

/** 逐项比较：next 比 previous 更宽 ⇒ 放宽（任一能力放宽即整体需确认）。 */
export function evaluatePermissionWidening(input: {
  readonly previous: Readonly<Record<string, PermissionDecision>>;
  readonly next: Readonly<Record<string, PermissionDecision>>;
  readonly previousFallback: PermissionDecision;
  readonly nextFallback: PermissionDecision;
}): { readonly isWidening: boolean; readonly changes: readonly ScopedPermissionChange[] } {
  const capabilityIds = new Set([
    ...Object.keys(input.previous),
    ...Object.keys(input.next),
  ]);
  const changes: ScopedPermissionChange[] = [];
  let isWidening = false;
  for (const capabilityId of [...capabilityIds].sort()) {
    const previousDecision =
      input.previous[capabilityId] ?? input.previousFallback;
    const nextDecision = input.next[capabilityId] ?? input.nextFallback;
    if (previousDecision === nextDecision) {
      continue;
    }
    changes.push({ capabilityId, previousDecision, nextDecision });
    if (DECISION_ORDER[nextDecision] > DECISION_ORDER[previousDecision]) {
      isWidening = true;
    }
  }
  return { isWidening, changes };
}

export class ScopedPermissionChangeService {
  private readonly previews = new Map<string, StoredPreview>();

  constructor(private readonly options: ScopedPermissionChangeServiceOptions) {}

  private nowMilliseconds(): number {
    return this.options.nowMilliseconds?.() ?? Date.now();
  }

  private async readProfileDecisions(
    reference: PermissionProfileReference | null,
  ): Promise<{
    readonly decisions: Record<string, PermissionDecision>;
    readonly fallback: PermissionDecision;
  }> {
    if (reference === null) {
      return { decisions: {}, fallback: "deny" };
    }
    const profile = await this.options.profileStore.readProfile(reference);
    return {
      decisions: { ...profile.capabilityDecisions },
      fallback: profile.fallbackDecision,
    };
  }

  private fingerprintOf(input: {
    readonly scope: "project" | "session";
    readonly identifier: string;
    readonly permissionProfileId: string;
    readonly expectedRevision: number;
    readonly currentProfileReference: PermissionProfileReference | null;
  }): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          scope: input.scope,
          identifier: input.identifier,
          permissionProfileId: input.permissionProfileId,
          expectedRevision: input.expectedRevision,
          currentProfileReference: input.currentProfileReference,
        }),
      )
      .digest("hex");
  }

  /** 生成预览（不写作用域配置）；主体必须非空。 */
  async preview(input: {
    readonly scope: "project" | "session";
    readonly identifier: string;
    readonly permissionProfileId: string;
    readonly targetProfileKind?: "builtin" | "custom";
    readonly expectedRevision: number;
    readonly currentProfileReference: PermissionProfileReference | null;
    readonly subjectIdentifier: string;
  }): Promise<ScopedPermissionChangePreview> {
    if (input.subjectIdentifier.trim() === "") {
      throw new DomainError(
        "task-sequence-permission-denied",
        "权限放宽预览必须有已认证主体（不得由正文自报）。",
      );
    }
    const current = await this.readProfileDecisions(input.currentProfileReference);
    const next = await this.readProfileDecisions(
      resolveTargetReference(
        input.permissionProfileId,
        input.targetProfileKind,
      ),
    );
    const { isWidening, changes } = evaluatePermissionWidening({
      previous: current.decisions,
      next: next.decisions,
      previousFallback: current.fallback,
      nextFallback: next.fallback,
    });
    const now = this.nowMilliseconds();
    const ttl =
      this.options.previewTtlMilliseconds ??
      DEFAULT_PERMISSION_PREVIEW_TTL_MILLISECONDS;
    const preview: ScopedPermissionChangePreview = {
      previewIdentifier: `permission-preview-${randomUUID()}`,
      fingerprint: this.fingerprintOf(input),
      isWidening,
      changes,
      scope: input.scope,
      identifier: input.identifier,
      permissionProfileId: input.permissionProfileId,
      expectedRevision: input.expectedRevision,
      subjectIdentifier: input.subjectIdentifier,
      createdAtIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + ttl).toISOString(),
    };
    this.previews.set(preview.previewIdentifier, {
      ...preview,
      currentProfileReference: input.currentProfileReference,
      confirmedDocument: null,
    });
    return preview;
  }

  /** 确认并应用；参数/过期/revision/指纹不符一律拒绝。重复确认幂等。 */
  async confirm(input: {
    readonly previewIdentifier: string;
    readonly fingerprint: string;
    readonly expectedRevision: number;
    readonly subjectIdentifier: string;
  }): Promise<ScopedSettingsDocument> {
    const stored = this.previews.get(input.previewIdentifier);
    if (stored === undefined) {
      throw new DomainError(
        "permission-preview-not-found",
        "权限变更预览不存在或已失效，请重新预览。",
      );
    }
    if (stored.confirmedDocument !== null) {
      return stored.confirmedDocument;
    }
    if (this.nowMilliseconds() > Date.parse(stored.expiresAtIso)) {
      throw new DomainError(
        "permission-preview-expired",
        "权限变更预览已过期，请重新预览。",
      );
    }
    if (
      stored.fingerprint !== input.fingerprint ||
      stored.expectedRevision !== input.expectedRevision ||
      stored.subjectIdentifier !== input.subjectIdentifier
    ) {
      throw new DomainError(
        "permission-preview-stale",
        "权限变更参数/主体与预览不一致，请重新预览。",
      );
    }
    const document = await this.options.scopedStore.updatePermission({
      scope: stored.scope,
      identifier: stored.identifier,
      expectedRevision: stored.expectedRevision,
      permissionProfileId: stored.permissionProfileId,
      updatedByUserId: stored.subjectIdentifier,
    });
    this.previews.set(stored.previewIdentifier, {
      ...stored,
      confirmedDocument: document,
    });
    return document;
  }

  /** 收紧（非放宽）可直接应用；放宽返回 false 由调用方要求预览。 */
  async isWideningChange(input: {
    readonly permissionProfileId: string;
    readonly targetProfileKind?: "builtin" | "custom";
    readonly currentProfileReference: PermissionProfileReference | null;
  }): Promise<boolean> {
    const current = await this.readProfileDecisions(input.currentProfileReference);
    const next = await this.readProfileDecisions(
      resolveTargetReference(
        input.permissionProfileId,
        input.targetProfileKind,
      ),
    );
    return evaluatePermissionWidening({
      previous: current.decisions,
      next: next.decisions,
      previousFallback: current.fallback,
      nextFallback: next.fallback,
    }).isWidening;
  }
}
