# 手动脚本执行记录（2026-10-29，窗口后补）

> 本文档记录**两个此前从未执行的脚本**的首次真实运行结果。
> 它们只覆盖**存储层**（收据/裁决）与**规则命中层**（敏感扫描），
> **不覆盖**产品行为：严格门禁的 mission 上下文、`block` 的实际阻断、任何 UI/调度路径。

## 1. 严格完成门禁演练 `strict-completion-drill.mjs`

- 运行日期：2026-10-29
- 命令：`node scripts/manual/strict-completion-drill.mjs`（先 `npm run build`）
- 退出码：**0**
- 输出（原文摘要）：

```
state: <临时目录>
ok    收据齐备且足够: drill-task-1
ok    裁决为 accepted: drill-task-1
ok    收据齐备且足够: drill-task-2
ok    裁决为 accepted: drill-task-2
ok    缺收据 ⇒ 判定不足
ok    缺裁决 ⇒ read 为 null
ok    同任务不同内容拒绝覆盖

ALL CHECKS PASSED（仅覆盖存储层；完整门禁仍需人工 mission 验收）
```

**结论**：收据/裁决存储的写入、读取、幂等、**拒绝覆盖**、缺失判定（`null` / 不足）在此脚本覆盖范围内**通过**。
**不**说明严格门禁在真实 mission 上的判定正确。

## 2. 误报率探针 `egress-false-positive-probe.mjs`

### 2.1 首次运行（用户执行，发现 1 个问题）

- 退出码：**1**
- 结果：8 条 normal 全 `clean`（**0 误报**）；6 条假凭据中 **5 命中**，**1 条 MISS**：

```
MISS/OTHER fake-aws outcome=clean rules=-
summary: normalSamples=8 falsePositives=0 fakeCredentialSamples=6 missesOrOtherRules=1
```

### 2.2 定位：**样本写错了，不是规则漏检**

规则定义在 `packages/core/src/tools/credential-detector-registry.ts:123`：

```
\b(?:AKIA|ASIA)[0-9A-Z]{16}\b
```

要求 `AKIA` 后**恰好 16 位** `[0-9A-Z]`。原样本 `AKIAFAKE0000000000` 在 `AKIA` 后只有
`FAKE` + 10 个 `0` = **14 位**，长度不足 ⇒ 不命中。

**修复**：样本改为 `AKIAFAKE000000000000`（`AKIA` + `FAKE` + 12 个 `0` = 16 位）。

### 2.3 修复后复跑

- 退出码：**0**
- 结果：

```
clean ×8（0 误报）
hit  fake-anthropic rules=vendor:anthropic-api-key,field:assignment-credential
hit  fake-openai-style rules=vendor:openai-style-api-key,field:assignment-credential
hit  fake-github rules=vcs:github-token-classic,field:assignment-credential
hit  fake-aws rules=cloud:aws-access-key-id
hit  fake-private-key rules=key:pem-private-key
hit  fake-connection-string rules=db:connection-string-password
summary: normalSamples=8 falsePositives=0 fakeCredentialSamples=6 missesOrOtherRules=0
```

## 3. 这些结果能说明什么 / 不能说明什么

**能**：
- 收据/裁决存储在同一 mission/task 上**拒绝被不同内容覆盖**（不可改写）；
- 缺收据 ⇒ `evaluateCompletionReceipt` 判定不足；缺裁决 ⇒ 读回 `null`；
- 现行规则目录能识别 6 类**人工构造的假凭据**，且 8 条常见正常文本**未误报**；
- 顺带发现并修正了一个**探针样本**错误（长度不符），说明探针本身能抓到夹具问题。

**不能**：
- 不能说"严格门禁通过"——它只测存储层，未测 `projectMissionCompletionGate`；
- 不能说"`block` 可以默认开启"——8+6 条样本**远不足以**代表真实误报率；
- 不能说"敏感扫描全覆盖"——只测 6 类假凭据，且规则目录仍是"前缀/固定格式"为主。

## 4. 后续建议

1. 把本记录并入验收材料即可（`npm run test` / `check` 仍**未运行**，需另行授权）；
2. 若要谈 `block` 默认值，先扩大样本（真实语料 + 更多假凭据变体），当前数据只够"不误报常见文本"；
3. `groupKind` 判定策略仍是最便宜的下一步代码项。
