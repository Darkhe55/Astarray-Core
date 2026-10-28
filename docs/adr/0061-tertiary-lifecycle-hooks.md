# ADR-0061 三级收口：真实生命周期钩子与"先存档案再释放"（ALIGN-03-07）

- 状态：部分采纳（钩子已实装；**没有生产调用方驱动 shutdown**）
- 日期：2026-10-28
- 来源：[ALIGN-03](../tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md) 检查点 07
- 相关：ADR-0057（完成收据）、ADR-0060（反馈幂等与补送）

## 1. 背景

卡内要求：三级 Agent 成功/中断/上下文过长后的**关闭与接手复用生命周期控制器**；
**先保存个体档案再释放进程**；移交**只附选定档案、不合并兄弟记忆**；
Git 远端失败是**本地保全待同步**，不把本地成功写成推送成功。

实测两处问题：

1. `TertiaryAgentLifecycleController` 在 `application-runtime` 里是**空 hooks** 构造的；
   `runPhase` 在 hook 缺失时把该阶段记为 `none` 并**继续** ⇒ 收口"看起来成功"，
   实际没保存检查点、没写移交、没处理 Git 资源。
2. hook 签名**不带个体标识**，而控制器是长生命周期共享实例 ⇒ 接线方只能猜"现在关的是谁"。

此外：`shutdown()` 在生产代码里**没有任何调用方**（只有 `getTertiaryLifecycleController()` 暴露给
上层），Worker 是进程内异步执行、没有独立 OS 进程可"终止"。

## 2. 契约（冻结）

1. **hook 收到具体个体**：`TertiaryLifecycleHookSet` 的每个 hook 都以
   `agentInstanceId` 为参数（既有"无参 hook"写法仍兼容）。
2. **先保存档案**：`persisting-checkpoint` 读取**该个体自己的**记忆档案并记录 revision；
   没有档案返回 `no-archive`（**不创建、不伪造记忆**）；命名空间不属于个体记忆域时
   返回 `namespace-not-individual-memory`；档案损坏**照常抛错**（不伪装成"没有档案"）。
3. **移交只含选定内容**：`writing-handoff` 写 `<state>/agent-handoffs/<个体>-<时间戳>.json`，
   只含该个体的档案 revision 与**显式选定**的附件哈希，并显式写
   `doesMergeSiblingMemory: false` —— 兄弟记忆不进入该文件。
4. **Git 资源如实报告**：`handling-git-resources` 有端口用端口结果（端口必须区分
   "远端已推送"与"本地保全待同步"）；无端口返回 `no-git-allocation`，
   **不**声明推送成功。
5. **不留静默 `none`**：其余阶段在缺端口时返回明确的 `no-*` / `dispatch-stopped` /
   `in-process-worker`，让"没做事"与"做了事"在阶段结果里可区分。
6. **不改变收口顺序**：阶段顺序仍由 `TERTIARY_LIFECYCLE_PHASE_ORDER` 固定
   （停派发 → 排空 → 检查点 → 移交 → 反馈 → 权限租约 → 邮箱 → Git → 终止 → closed）。

## 3. 生产调用链（源码位置）

```
application-runtime                                                  packages/core/src/application/application-runtime.ts
├─ agentIndividualMemoryStore（先建）
├─ buildTertiaryLifecycleHooks({ individualMemoryStore, handoffDirectoryPath })
│  └─ packages/core/src/orchestration/tertiary-lifecycle-hooks.ts
└─ TertiaryAgentLifecycleController(hooks, { phaseStore })
   └─ shutdown({ agentInstanceId })
      └─ runPhase → hook(agentInstanceId)                             tertiary-lifecycle.ts
         ├─ persisting-checkpoint：读自己的档案 revision（或 no-archive）
         ├─ writing-handoff：写只含选定附件的移交文件
         └─ handling-git-resources：如实报告（无端口 ⇒ no-git-allocation）
```

## 4. 未完成（如实）

- **没有生产调用方驱动 `shutdown()`**：Worker 是进程内异步任务，编排层在任务收口时
  不调用生命周期控制器；目前只能由上层（UI/CLI/测试）经 getter 手动驱动。
  因此"先存档案再释放进程"的**顺序**已固定、钩子已实装，但常态路径尚未执行。
- **Git 资源端口未装配**：`handleGitResources` 恒返回 `no-git-allocation`；
  没有把 worktree 释放/分支保留接到这里。
- **接手（handoff 读入）未实现**：移交文件已写，但没有"新个体按移交文件接手"的读取路径。
- **未验证**：没有跑过一次真实 `shutdown()`（有无档案、有无附件、阶段结果是否正确）。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
