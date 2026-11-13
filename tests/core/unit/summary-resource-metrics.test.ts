/**
 * 摘要资源观测（此前 `tests/` 零引用）。
 *
 * 只观测、不裁剪：指标必须**如实来自调用方与真实读取**，
 * 且操作失败时不得返回一份"看起来成功"的指标。
 */
import { describe, expect, it } from "vitest";

import { measureSummaryOperation } from "../../../packages/core/src/summarization/summary-resource-metrics.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("摘要资源观测", () => {
  it("① 指标逐字段来自 extract 与清单读取（不猜、不改写）", async () => {
    const { result, metrics } = await measureSummaryOperation({
      operation: async () => ({ text: "摘要正文" }),
      readManifestFileBytes: async () => 4_096,
      extract: () => ({
        chunkCount: 12,
        narrativeCharacterCount: 34,
        returnedUnitCount: 5,
        sourceAccessCount: 0,
        diskReadOperationCount: 1,
        isReturnBounded: true,
      }),
    });

    expect(result).toEqual({ text: "摘要正文" });
    expect(metrics).toMatchObject({
      manifestFileBytes: 4_096,
      chunkCount: 12,
      narrativeCharacterCount: 34,
      returnedUnitCount: 5,
      sourceAccessCount: 0,
      diskReadOperationCount: 1,
      isReturnBounded: true,
    });
  });

  it("② 清单字节来自真实读取函数（每次调用都重新读）", async () => {
    let readCount = 0;
    const readManifestFileBytes = async () => {
      readCount += 1;
      return readCount * 100;
    };
    const first = await measureSummaryOperation({
      operation: async () => null,
      readManifestFileBytes,
      extract: () => ({
        chunkCount: 0,
        narrativeCharacterCount: 0,
        returnedUnitCount: 0,
        sourceAccessCount: 0,
        diskReadOperationCount: 1,
        isReturnBounded: false,
      }),
    });
    const second = await measureSummaryOperation({
      operation: async () => null,
      readManifestFileBytes,
      extract: () => ({
        chunkCount: 0,
        narrativeCharacterCount: 0,
        returnedUnitCount: 0,
        sourceAccessCount: 0,
        diskReadOperationCount: 1,
        isReturnBounded: false,
      }),
    });
    expect(first.metrics.manifestFileBytes).toBe(100);
    expect(second.metrics.manifestFileBytes).toBe(200);
  });

  it("③ 耗时是真实测量（慢操作 ⇒ 更大的 wallMilliseconds）", async () => {
    const { metrics } = await measureSummaryOperation({
      operation: async () => {
        await delay(30);
        return null;
      },
      readManifestFileBytes: async () => 1,
      extract: () => ({
        chunkCount: 0,
        narrativeCharacterCount: 0,
        returnedUnitCount: 0,
        sourceAccessCount: 0,
        diskReadOperationCount: 1,
        isReturnBounded: false,
      }),
    });
    expect(metrics.wallMilliseconds).toBeGreaterThanOrEqual(20);
  });

  it("④ 原文访问次数原样透传：读取路径声明 0 就显示 0", async () => {
    const { metrics } = await measureSummaryOperation({
      operation: async () => null,
      readManifestFileBytes: async () => 1,
      extract: () => ({
        chunkCount: 3,
        narrativeCharacterCount: 0,
        returnedUnitCount: 3,
        sourceAccessCount: 0,
        diskReadOperationCount: 1,
        isReturnBounded: false,
      }),
    });
    expect(metrics.sourceAccessCount).toBe(0);
    expect(metrics.chunkCount).toBe(3);
    expect(metrics.narrativeCharacterCount).toBe(0);
  });

  it("⑤ isReturnBounded 透传：不因返回量小就改判为未裁剪", async () => {
    const { metrics } = await measureSummaryOperation({
      operation: async () => null,
      readManifestFileBytes: async () => 1,
      extract: () => ({
        chunkCount: 100,
        narrativeCharacterCount: 10,
        returnedUnitCount: 1,
        sourceAccessCount: 0,
        diskReadOperationCount: 1,
        isReturnBounded: true,
      }),
    });
    expect(metrics.isReturnBounded).toBe(true);
    expect(metrics.returnedUnitCount).toBe(1);
    expect(metrics.chunkCount).toBe(100);
  });

  it("⑥ 操作抛错 ⇒ 整体 reject（不返回一份看起来成功的指标）", async () => {
    await expect(
      measureSummaryOperation({
        operation: async () => {
          throw new Error("读取失败");
        },
        readManifestFileBytes: async () => 1,
        extract: () => ({
          chunkCount: 0,
          narrativeCharacterCount: 0,
          returnedUnitCount: 0,
          sourceAccessCount: 0,
          diskReadOperationCount: 1,
          isReturnBounded: false,
        }),
      }),
    ).rejects.toThrow("读取失败");
  });
});
