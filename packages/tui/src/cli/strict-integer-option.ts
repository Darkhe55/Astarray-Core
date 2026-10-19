/**
 * 严格整数选项解析（2026-10-19 R84）。
 *
 * **为什么不用 `Number.parseInt`**：它宽容截断 —— `"5abc"` ⇒ 5、`"1e5"` ⇒ 1、`"10.5"` ⇒ 10。
 * 在预算/分页/超时/修订号这类参数上，截断不会报错，只会产生**静默的错误行为**
 * （预算变成 5 字节 ⇒ 裁光历史；页码变成 2 ⇒ 静默返回错页）。
 *
 * 本模块只做一件事：**原始字符串必须是纯数字**（允许前后空白），再转成整数并做范围检查。
 */
export type StrictIntegerOptionResult =
  | { readonly kind: "ok"; readonly value: number }
  | { readonly kind: "error"; readonly message: string };

/** 解析可选的正整数选项；`undefined` 表示"未提供"。 */
export function parseStrictPositiveIntegerOption(
  rawValue: string | undefined,
  flagName: string,
  bounds: { readonly minimum: number; readonly maximum?: number } = { minimum: 1 },
): StrictIntegerOptionResult | undefined {
  if (rawValue === undefined) return undefined;
  const trimmedValue = rawValue.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    return {
      kind: "error",
      message: `${flagName} 必须是纯数字（收到 ${JSON.stringify(rawValue)}）。`,
    };
  }
  const parsedValue = Number.parseInt(trimmedValue, 10);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < bounds.minimum) {
    return {
      kind: "error",
      message: `${flagName} 必须是不小于 ${String(bounds.minimum)} 的整数（收到 ${JSON.stringify(rawValue)}）。`,
    };
  }
  if (bounds.maximum !== undefined && parsedValue > bounds.maximum) {
    return {
      kind: "error",
      message: `${flagName} 必须不大于 ${String(bounds.maximum)}（收到 ${JSON.stringify(rawValue)}）。`,
    };
  }
  return { kind: "ok", value: parsedValue };
}
