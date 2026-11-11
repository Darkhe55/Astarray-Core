#!/usr/bin/env node
/**
 * 公开仓库隐私闸门：扫描**工作树与全部历史**，发现本机标识即失败。
 *
 * 为什么需要它：2026-11-11 的一次推送把主机名、本地账户名与 SID 带进了公开历史，
 * 而当时的提交前扫描只覆盖了仓库名/凭据模式，**没有覆盖本机标识**——
 * 扫描清单不全等于没扫。本脚本把这四类模式固定下来。
 *
 * 用法：node scripts/check-public-privacy.mjs
 * 退出码：0 = 干净；1 = 有命中（打印位置）。
 */
import { execFileSync } from "node:child_process";

const patterns = [
  { name: "主机名", re: /\bDESKTOP-[A-Z0-9]{6,}\b/u },
  { name: "本机用户路径", re: /(?:C:\\Users|~\/|\/Users)\/(?!<)[A-Za-z0-9._-]{2,}/u },
  { name: "Windows SID", re: /\bS-1-5-21-[0-9]{6,}/u },
  { name: "私钥/令牌", re: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/u },
];

/** 允许出现在文档里的占位写法。 */
const allowPlaceholders = [/<user>/u, /<name>/u, /%USERPROFILE%/u, /example/u, /`?C:\\Users\\`?/u];

function scanTree() {
  const hits = [];
  for (const pattern of patterns) {
    let output = "";
    try {
      output = execFileSync("git", ["grep", "-n", "-I", "-E", pattern.re.source, "--", "."], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue; // git grep 无命中时退出码为 1
    }
    for (const line of output.split("\n")) {
      if (line.trim() === "") continue;
      if (allowPlaceholders.some((allow) => allow.test(line))) continue;
      hits.push({ scope: "工作树", pattern: pattern.name, line });
    }
  }
  return hits;
}

function scanHistory() {
  const hits = [];
  for (const pattern of patterns) {
    let output = "";
    try {
      output = execFileSync("git", ["log", "--all", "--format=%H", "-S", pattern.re.source], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    const commits = output.split("\n").filter((line) => line.trim() !== "");
    if (commits.length > 0) {
      hits.push({
        scope: "历史",
        pattern: pattern.name,
        line: `${String(commits.length)} 个提交命中（示例 ${commits[0]?.slice(0, 8) ?? "?"}）`,
      });
    }
  }
  return hits;
}

const hits = [...scanTree(), ...scanHistory()];
if (hits.length === 0) {
  console.log("privacy-ok: 工作树与历史均未发现本机标识或凭据模式");
  process.exit(0);
}
console.log(`privacy-failed: ${String(hits.length)} 处命中`);
for (const hit of hits) {
  console.log(`  [${hit.scope}] ${hit.pattern}: ${hit.line.slice(0, 160)}`);
}
process.exit(1);
