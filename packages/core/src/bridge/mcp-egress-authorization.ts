/**
 * RELEASE-01-01（2026-11-23）：**MCP 连接授权 → 每次结果释放前的复核**。
 *
 * 产品口径（RELEASE-01 卡 01）：
 * - 由可信宿主绑定连接、认证主体、目的端、源项目、允许的资源集合、有效期与授权 revision；
 * - **释放数据前重读有效授权**，校验撤销、目的端与资源范围，分别检查授权 revision、
 *   内容 revision 与扫描规则版本；
 * - 缺绑定（或主体/连接不符）时，项目读取必须**明确拒绝**；协议协商与公开元数据不受影响；
 * - 拒绝只返回稳定原因码与关联 ID，**不能反射正文**。
 *
 * 本模块是**纯判定**（不联网、不写盘、不读正文），由 MCP stdio 会话在写 stdout 前调用。
 */
export type McpEgressDenialReasonCode =
  | "authorization-missing"
  | "principal-mismatch"
  | "connection-mismatch"
  | "authorization-expired"
  | "authorization-revoked"
  | "authorization-revision-mismatch"
  | "resource-out-of-scope"
  | "content-revision-mismatch"
  | "rule-set-version-mismatch"
  | "target-mismatch";

export interface McpConnectionAuthorizationBinding {
  readonly connectionIdentifier: string;
  readonly authenticatedPrincipalIdentifier: string;
  readonly sourceProjectIdentifier: string;
  /** 允许释放的资源标识前缀（绝对/规范化；不匹配即越界）。 */
  readonly allowedResourcePrefixes: readonly string[];
  readonly targetAccountIdentifier: string;
  /** 当前授权 revision（撤销/改授权必须递增）。 */
  readonly authorizationRevision: number;
  /** 结果内容 revision（脱敏改变内容必须重新绑定）。 */
  readonly contentRevision: number;
  /** 扫描规则版本。 */
  readonly ruleSetVersion: number;
  readonly expiresAtIso: string;
}

export interface McpReleaseRequest {
  readonly connectionIdentifier: string;
  readonly authenticatedPrincipalIdentifier: string;
  readonly targetAccountIdentifier: string;
  readonly contentRevision: number;
  readonly ruleSetVersion: number;
  /** 本结果依赖的资源标识（聚合结果须覆盖所有来源）。 */
  readonly resourceIdentifiers: readonly string[];
  /** 当前时刻（调用方注入，便于确定性测试）。 */
  readonly nowIso: string;
}

export type McpEgressDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reasonCodes: readonly McpEgressDenialReasonCode[];
      readonly detail: string;
    };

export interface McpAuthorizationStorePort {
  /** 权威读取当前绑定（撤销必须通过它体现：返回 null 或更高 revision 的绑定）。 */
  readBinding(connectionIdentifier: string): Promise<McpConnectionAuthorizationBinding | null>;
  /** 连接是否已被显式撤销/断开。 */
  isRevoked(connectionIdentifier: string): Promise<boolean>;
}

/**
 * 释放前复核：逐项检查，**任一失败即拒绝**（不合并成一句"被拒绝"，便于审计）。
 */
export function evaluateMcpRelease(input: {
  readonly request: McpReleaseRequest;
  readonly binding: McpConnectionAuthorizationBinding | null;
  readonly isRevoked: boolean;
}): McpEgressDecision {
  const reasonCodes: McpEgressDenialReasonCode[] = [];
  const details: string[] = [];
  const { request, binding } = input;

  if (input.isRevoked) {
    reasonCodes.push("authorization-revoked");
    details.push("连接已被撤销");
  }
  if (binding === null) {
    reasonCodes.push("authorization-missing");
    details.push("缺少连接授权绑定：项目内容不得释放");
  } else {
    if (binding.connectionIdentifier !== request.connectionIdentifier) {
      reasonCodes.push("connection-mismatch");
      details.push("授权绑定的连接与本次释放不一致");
    }
    if (
      binding.authenticatedPrincipalIdentifier !== request.authenticatedPrincipalIdentifier
    ) {
      reasonCodes.push("principal-mismatch");
      details.push("授权主体与本次释放主体不一致");
    }
    if (binding.targetAccountIdentifier !== request.targetAccountIdentifier) {
      reasonCodes.push("target-mismatch");
      details.push("目的端与授权时不一致");
    }
    if (Date.parse(binding.expiresAtIso) <= Date.parse(request.nowIso)) {
      reasonCodes.push("authorization-expired");
      details.push("授权已过期");
    }
    if (binding.contentRevision !== request.contentRevision) {
      reasonCodes.push("content-revision-mismatch");
      details.push("内容 revision 与授权时不一致（脱敏/改写须重新授权）");
    }
    if (binding.ruleSetVersion !== request.ruleSetVersion) {
      reasonCodes.push("rule-set-version-mismatch");
      details.push("扫描规则版本与授权时不一致");
    }
    const outOfScope = request.resourceIdentifiers.filter(
      (resourceIdentifier) =>
        !binding.allowedResourcePrefixes.some((prefix) =>
          resourceIdentifier.startsWith(prefix),
        ),
    );
    if (outOfScope.length > 0) {
      reasonCodes.push("resource-out-of-scope");
      details.push(`资源越界 ${outOfScope.length} 项（不返回资源名，避免二次泄漏）`);
    }
  }

  if (reasonCodes.length > 0) {
    return { allowed: false, reasonCodes, detail: details.join("；") };
  }
  return { allowed: true };
}

/**
 * 带**权威重读**的释放判定：每次释放前重新读绑定与撤销状态（不缓存旧授权）。
 */
export async function evaluateMcpReleaseAgainstStore(input: {
  readonly store: McpAuthorizationStorePort;
  readonly request: McpReleaseRequest;
}): Promise<McpEgressDecision> {
  const { store, request } = input;
  const [binding, isRevoked] = await Promise.all([
    store.readBinding(request.connectionIdentifier).catch(() => null),
    store.isRevoked(request.connectionIdentifier).catch(() => true),
  ]);
  return evaluateMcpRelease({ request, binding, isRevoked });
}
