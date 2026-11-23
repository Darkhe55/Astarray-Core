/**
 * SEC-02 / D8（2026-11-23）：敏感内容判定里**身份解析与旧接口折叠**的分支。
 *
 * 覆盖此前被覆盖率统计为未命中的路径：
 * - 身份解析：不存在路径、同一 inode 的硬链接别名（管理员扩展路径）；
 * - 四态 → 旧布尔接口的保守折叠（sensitive/incomplete ⇒ true，clean ⇒ false）；
 * - 目录条目过滤与拒绝码稳定。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DefaultDlpScanner,
  SensitiveContentAccessPolicy,
  SensitiveResourceIdentityResolver,
  SENSITIVE_CONTENT_READ_DENIED_ERROR_CODE,
} from "../../../packages/core/src/tools/sensitive-content-access-policy.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sec02-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("SEC-02：身份解析分支", () => {
  it("① 不存在的路径 ⇒ realPath/deviceInode 为 null，不算链接", async () => {
    const resolver = new SensitiveResourceIdentityResolver();
    const identity = await resolver.resolveIdentity(
      path.join(baseDirectory, "missing-file.txt"),
    );
    expect(identity.realPath).toBeNull();
    expect(identity.deviceInode).toBeNull();
    expect(identity.isLinkLike).toBe(false);
    expect(identity.canonicalPath.endsWith("missing-file.txt")).toBe(true);
  });

  it("② 同一 inode 的硬链接别名 ⇒ 管理员扩展路径按身份拦截", async () => {
    const sensitivePath = path.join(baseDirectory, "credential-notes.txt");
    const hardLinkPath = path.join(baseDirectory, "innocent-looking.txt");
    await fs.writeFile(sensitivePath, "普通内容，名称正常", "utf8");
    await fs.link(sensitivePath, hardLinkPath);

    const resolver = new SensitiveResourceIdentityResolver();
    const sensitiveIdentity = await resolver.resolveIdentity(sensitivePath);
    const hardLinkIdentity = await resolver.resolveIdentity(hardLinkPath);
    expect(sensitiveIdentity.deviceInode).not.toBeNull();
    expect(hardLinkIdentity.deviceInode).toBe(sensitiveIdentity.deviceInode);

    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePaths: [sensitivePath],
    });
    await expect(
      policy.assertSensitiveContentReadAllowed({ canonicalPath: hardLinkPath }),
    ).rejects.toMatchObject({
      errorCode: SENSITIVE_CONTENT_READ_DENIED_ERROR_CODE,
      message: expect.stringContaining("admin-extended-identity"),
    });
  });

  it("③ 管理员扩展路径不存在 ⇒ 不误伤普通文件（缓存 null 不抛）", async () => {
    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePaths: [path.join(baseDirectory, "ghost.txt")],
    });
    const normalPath = path.join(baseDirectory, "ordinary.txt");
    await fs.writeFile(normalPath, "内容", "utf8");
    await expect(
      policy.assertSensitiveContentReadAllowed({ canonicalPath: normalPath }),
    ).resolves.toBeUndefined();
  });

  it("④ 管理员扩展正则命中 ⇒ 拒绝并给出类别", async () => {
    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePatterns: [/secret-\d+\.txt$/],
    });
    await expect(
      policy.assertSensitiveContentReadAllowed({
        canonicalPath: path.join(baseDirectory, "secret-42.txt"),
      }),
    ).rejects.toMatchObject({ errorCode: SENSITIVE_CONTENT_READ_DENIED_ERROR_CODE });
  });
});

describe("SEC-02：四态 → 旧布尔接口的保守折叠", () => {
  it("⑤ 命中 ⇒ isSensitive=true 且带类别", async () => {
    const scanner = new DefaultDlpScanner();
    const result = await scanner.scanTextContent({
      content: "token=sk-abcdefghijklmnop1234567890",
      sourceName: "notes.txt",
    });
    expect(result.isSensitive).toBe(true);
    expect(result.matchedRuleCategory).not.toBeNull();
  });

  it("⑥ 干净内容 ⇒ isSensitive=false 且无类别", async () => {
    const scanner = new DefaultDlpScanner();
    const result = await scanner.scanTextContent({
      content: "普通编译日志，没有任何凭据",
      sourceName: "build.log",
    });
    expect(result.isSensitive).toBe(false);
    expect(result.matchedRuleCategory).toBeNull();
  });

  it("⑦ 超出扫描预算 ⇒ 旧接口保守报 isSensitive=true（没扫完不算安全）", async () => {
    const scanner = new DefaultDlpScanner();
    const large = "普通文本，无凭据。".repeat(200_000);
    const result = await scanner.scanTextContent({
      content: large,
      sourceName: "huge.log",
    });
    expect(result.isSensitive).toBe(true);
    expect(result.matchedRuleCategory).toBe("dlp:scan-incomplete");
  });
});

describe("SEC-02：目录过滤", () => {
  it("⑧ 敏感名与管理员正则都被过滤，普通名保留", () => {
    const policy = new SensitiveContentAccessPolicy({
      additionalSensitivePatterns: [/^vault-.*\.json$/],
    });
    const filtered = policy.filterSensitiveDirectoryEntries("/project", [
      ".env",
      "vault-prod.json",
      "notes.txt",
    ]);
    expect(filtered).toEqual(["notes.txt"]);
  });
});
