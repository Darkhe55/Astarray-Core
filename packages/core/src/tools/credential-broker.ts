/**
 * SEC-02-07（2026-10-28）：**凭据引用与最小读取**。
 *
 * 卡内要求：
 * - 凭据解析由**可信本地适配器**完成；工作 Agent 只获得**不含秘密的账户/凭据引用**；
 * - 引用必须绑定服务与操作范围，不能变成"任意目标请求的通用认证能力"；
 * - 不把请求头 / SDK 配置 / 原始异常 / 进程转储写入日志或模型结果。
 *
 * 本模块提供三件东西（不联网、不读凭据库）：
 * 1. `CredentialReference`：**只有标识与范围**，可以安全出现在提示词/日志里；
 * 2. `CredentialBroker`：唯一能"把引用换成秘密"的入口，且必须匹配服务与操作；
 * 3. `assertModelVisiblePayloadHasNoCredential`：在把内容交给模型/日志前，用同一份
 *    检测器目录做**四态扫描**，非 clean 即拒绝（"掩码不等于放行"的兜底）。
 */
import { DomainError } from "../core/errors.js";
import { scanSensitiveContent } from "./sensitive-content-scan-contract.js";

/** 工作 Agent 可见的凭据引用（**绝不含秘密**）。 */
export interface CredentialReference {
  readonly credentialIdentifier: string;
  /** 绑定服务（如 `provider:openai` / `git:github`）。 */
  readonly serviceIdentifier: string;
  /** 允许的操作（如 `chat.completions` / `repo.push`）。空数组表示无权限。 */
  readonly allowedOperations: readonly string[];
}

/** 可信本地适配器端口：只有它能返回秘密。 */
export interface CredentialResolutionPort {
  /** 解析秘密；实现方负责真正的凭据库/KMS 访问。 */
  resolveSecret(reference: CredentialReference): Promise<string>;
}

/**
 * 校验引用可用于本次请求：服务必须一致、操作必须在允许列表内。
 *
 * 该检查**不读取秘密**，因此可以安全地在任何层调用（包括模型可见路径）。
 */
export function assertCredentialReferenceUsable(input: {
  readonly reference: CredentialReference;
  readonly targetServiceIdentifier: string;
  readonly operation: string;
}): void {
  if (input.reference.credentialIdentifier.trim() === "") {
    throw new DomainError("task-sequence-permission-denied", "凭据引用缺少标识。");
  }
  if (input.reference.serviceIdentifier !== input.targetServiceIdentifier) {
    throw new DomainError(
      "task-sequence-permission-denied",
      `凭据引用绑定服务 ${input.reference.serviceIdentifier}，不能用于 ${input.targetServiceIdentifier}（不得跨目标透传认证）。`,
    );
  }
  if (!input.reference.allowedOperations.includes(input.operation)) {
    throw new DomainError(
      "task-sequence-permission-denied",
      `凭据引用未授权操作 ${input.operation}（允许：${input.reference.allowedOperations.join(", ") || "无"}）。`,
    );
  }
}

/**
 * 凭据中介：唯一"引用 → 秘密"的入口。
 *
 * 不在本类里做任何缓存/日志：秘密只在返回值里出现一次，调用方必须在用完后丢弃。
 */
export class CredentialBroker {
  constructor(private readonly resolutionPort: CredentialResolutionPort) {}

  async resolveForRequest(input: {
    readonly reference: CredentialReference;
    readonly targetServiceIdentifier: string;
    readonly operation: string;
  }): Promise<string> {
    assertCredentialReferenceUsable(input);
    const secret = await this.resolutionPort.resolveSecret(input.reference);
    if (secret.trim() === "") {
      throw new DomainError(
        "task-sequence-permission-denied",
        `凭据解析为空（拒绝以空凭据发起认证）: ${input.reference.credentialIdentifier}`,
      );
    }
    return secret;
  }

  /** 生成**模型/日志可见**的引用描述（无秘密、无凭据库路径）。 */
  describeReference(reference: CredentialReference): {
    readonly credentialIdentifier: string;
    readonly serviceIdentifier: string;
    readonly allowedOperations: readonly string[];
  } {
    return {
      credentialIdentifier: reference.credentialIdentifier,
      serviceIdentifier: reference.serviceIdentifier,
      allowedOperations: [...reference.allowedOperations],
    };
  }
}

/**
 * 把内容交给**模型或日志**之前的兜底：与检测器目录同源的四态扫描。
 *
 * 非 `clean`（命中/未完成/失败）一律拒绝；错误只带类别与计数，**不回显命中值**。
 */
export function assertModelVisiblePayloadHasNoCredential(input: {
  readonly payloadText: string;
  readonly destinationDescription: string;
}): void {
  const scanResult = scanSensitiveContent({ content: input.payloadText });
  if (scanResult.outcome === "clean") {
    return;
  }
  const reason =
    scanResult.outcome === "sensitive"
      ? `命中规则 ${scanResult.matchedRuleIdentifiers.join(", ")}`
      : `${scanResult.outcome}: ${scanResult.limitReason ?? "未知原因"}`;
  throw new DomainError(
    "sensitive-content-read-denied",
    `拒绝把内容送往${input.destinationDescription}（规则版本 ${scanResult.ruleSetVersion}；${reason}）。`,
  );
}
