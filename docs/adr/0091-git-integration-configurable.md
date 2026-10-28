# ADR-0091 Git 集成硬编码可配置化（收尾第 6 步）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[DEFAULT_SWITCHES_AUDIT_2026-10-29](../reports/DEFAULT_SWITCHES_AUDIT_2026-10-29.md) §4 同源缺口
- 相关：ADR-0090（审查者开关可达）、ADR-0071（子进程受限环境）

## 1. 背景

`application-runtime` 构造 Git 集成装配时**写死**两个空值：

```ts
allowedPathsByTaskType: {},
integrationTestCommands: [],
```

后果：**按任务类型的允许路径**与**集成测试命令**在产品装配里**不可配置** ——
写入型任务永远不会做 Git 分流（没有 worktree 隔离），集成门禁也永远不跑任何测试。

## 2. 变更（最小）

1. `ApplicationRuntimeOptions.gitIntegration` 增加
   `allowedPathsByTaskType?: Record<string, string[]>` 与 `integrationTestCommands?: string[]`；
2. 构造时用 `?? {}` / `?? []` 透传 —— **缺省值与原行为逐字一致**；
3. **不改**编排器/协调器里的任何判定逻辑。

## 3. 生产调用链（源码位置）

```
ApplicationRuntimeOptions.gitIntegration.{allowedPathsByTaskType, integrationTestCommands}
└─ application-runtime 构造 GitIntegrationOrchestrationOptions（缺省 {} / []）
   ├─ allowedPathsByTaskType → 决定该任务类型是否进入隔离 worktree（既有逻辑）
   └─ integrationTestCommands → 合并前在仓库目录执行（既有逻辑；子进程已走受控环境 ADR-0071）
```

## 4. 安全边界（必须保留）

- `integrationTestCommands` 是**用户/装配方配置**，不是模型输入；
- 执行时仍走既有受控子进程环境（ADR-0071：允许列表、不继承宿主凭据）；
- 命令失败即合并门禁失败（既有语义），**不因可配置而放宽**。

## 5. 未完成（如实）

- **默认仍为空**：本次只让两项"可配置"，**没有**提供任何默认命令或默认路径规则；
- **没有运行验证**：未跑"配置了路径 ⇒ 进 worktree""配置了命令 ⇒ 被实际执行"任何一条；
- **路径规则无校验**：没有校验 `allowedPathsByTaskType` 里的路径是否在工作区内、
  是否与项目根一致（调用方自行保证；后续可加校验）；
- **命令无长度/数量上限**：没有限制命令条数与单条长度（属调用方责任，尚未加固）。
