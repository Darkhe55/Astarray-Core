/**
 * Provider 连接/HTTP 失败的稳定分类（2026-10-25）。
 *
 * 目标：用户能看到**具体错误码与可执行提示**，而不是笼统的“请求失败或超时”。
 * 纪律：错误消息只含状态码/网络错误码/Provider 的简短错误文本，
 * **绝不含 API Key、Authorization 头或完整请求体**。
 */
import { DomainError } from "../core/errors.js";

function extractErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as { code?: unknown; cause?: unknown; message?: unknown };
  if (typeof record.code === "string" && record.code !== "") return record.code;
  if (typeof record.cause === "object" && record.cause !== null) {
    const cause = record.cause as { code?: unknown };
    if (typeof cause.code === "string" && cause.code !== "") return cause.code;
  }
  // Node 的 fetch 失败常是 `TypeError: fetch failed`，真正原因在 cause；
  // 测试/部分实现直接 `throw new Error("ECONNREFUSED")`，从消息里提取已知网络码。
  if (typeof record.message === "string") {
    const matched = /(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)/.exec(
      record.message,
    );
    if (matched !== null) return matched[1] ?? null;
  }
  return null;
}

export function describeProviderNetworkFailure(input: {
  readonly error: unknown;
  readonly isTimeout: boolean;
  readonly timeoutMilliseconds: number;
}): DomainError {
  if (input.isTimeout) {
    return new DomainError(
      "provider-timeout",
      `[provider-timeout] 请求超时（${input.timeoutMilliseconds}ms）：Provider 未在时限内响应；` +
        "请检查网络、端点地址或调大请求超时。",
    );
  }
  const code = extractErrorCode(input.error);
  return new DomainError(
    "provider-network-error",
    `[provider-network-error] 无法连接 Provider${code === null ? "" : `（${code}）`}：` +
      "连接失败，请检查网络、端点地址、代理或 TLS 设置。",
  );
}

async function readProviderErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text === "") return "";
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const candidate =
        typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.error?.message === "string"
            ? parsed.error.message
            : typeof parsed.message === "string"
              ? parsed.message
              : "";
      if (candidate !== "") return candidate.slice(0, 200);
    } catch {
      // 非 JSON：截断原文
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

/** 非 2xx 的分类；错误码稳定，文案直接可展示给用户。 */
export async function describeProviderHttpFailure(
  response: Response,
): Promise<DomainError> {
  const status = response.status;
  const statusText = response.statusText === "" ? "" : ` ${response.statusText}`;
  const detail = await readProviderErrorDetail(response);
  const suffix = detail === "" ? "" : `（Provider: ${detail}）`;

  if (status === 401 || status === 403) {
    return new DomainError(
      "provider-auth-failed",
      `[provider-auth-failed] HTTP ${status}${statusText}：连接失败，请检查 API Key 是否有效、未过期且有权限。${suffix}`,
    );
  }
  if (status === 404) {
    return new DomainError(
      "provider-endpoint-not-found",
      `[provider-endpoint-not-found] HTTP 404：端点路径不存在，请检查 Base URL / 协议是否匹配。${suffix}`,
    );
  }
  if (status === 429) {
    return new DomainError(
      "provider-rate-limited",
      `[provider-rate-limited] HTTP 429：请求过于频繁或额度不足，请稍后重试或检查配额。${suffix}`,
    );
  }
  if (status >= 500) {
    return new DomainError(
      "provider-server-error",
      `[provider-server-error] HTTP ${status}${statusText}：Provider 服务端异常，请稍后重试。${suffix}`,
    );
  }
  return new DomainError(
    "provider-http-error",
    `[provider-http-error] HTTP ${status}${statusText}：Provider 拒绝了请求，请检查模型/端点配置。${suffix}`,
  );
}
