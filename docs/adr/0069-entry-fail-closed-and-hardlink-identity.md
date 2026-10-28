# ADR-0069 生产入口装配 fail-closed 与硬链接身份（SEC-02-03）

- 状态：部分采纳（入口装配已 fail-closed；入口清单只覆盖已核实项）
- 日期：2026-10-28
- 来源：[SEC-02](../tasks/SEC02_LOCAL_SCAN_COVERAGE.md) 检查点 03
- 相关：ADR-0067（四态扫描）、ADR-0068（检测器注册表）

## 1. 背景（实测）

`builtins.ts` 的三处敏感策略调用都是**条件式**：

```ts
const sensitivePolicy = executionContext.sensitiveContentAccessPolicy;
if (sensitivePolicy !== null && sensitivePolicy !== undefined) { … }
// 否则直接放行
```

`assertSensitiveContentAllowed` 甚至在策略缺失时**直接 return**；注释写着"由装配方保证注入"。
`searchProjectText` 也把 `sensitiveContentAccessPolicy ?? null` 传下去。
⇒ 装配漏注入 = **静默放行**，且没有任何启动期检查。

身份侧：`SensitiveResourceIdentity` 已解析 `deviceInode`，但 `matchSensitivePath` 只比较
`canonicalPath` / `realPath` / `normalizedCasePath` 三种**路径视图** —— 硬链接别名（同 inode
不同路径）不会被识别。

## 2. 契约（冻结）

1. **生产装配 fail-closed**：执行上下文新增 `requireSensitiveContentPolicy`
   （缺省 false 只为兼容测试替身）。为 true 且策略缺失 ⇒
   `resolveSensitiveContentPolicy` 抛 `sensitive-content-read-denied`，
   覆盖：读取内容、列出目录、Git 只读视图、检索项目文本。
2. **测试替身显式隔离**：只有**不设置**该标志的上下文才保留旧行为；
   生产装配（`application-runtime` 的 `createPolicyWrapperForAgent`）**恒传 true**。
3. **硬链接身份**：对**管理员扩展的受保护路径**建立 `dev+inode` 身份缓存；
   候选路径路径视图不匹配但 inode 命中 ⇒ 判为敏感（类别 `admin-extended-identity`）。
   身份解析失败**不**作为安全结论（记为未知，不命中也不放行其它判断）。
4. **TOCTOU 边界（如实）**：检查与读取之间文件仍可能被替换；本轮**没有**实现
   "通过已验证句柄读取 / 读取后身份复核"。此限制写入本 ADR，不宣称已解决。
5. **不照搬未核实通道**：没有实现的入口不写进"已覆盖"。

## 3. 已核实的入口清单（本轮静态核对）

| 入口 | 路径检查 | 内容检查 | 脱敏消费者 | 状态 |
|---|---|---|---|---|
| `readFile` | ✅ `identifySensitiveResource` | ✅ 四态 DLP（读前 + 正文） | 拒绝（不返回原文） | 已接 |
| `listDirectory` | ✅ 名称规则过滤条目 | —（不返回内容） | 过滤条目名 | 已接 |
| `searchProjectText` | ✅ 传入策略（命中过滤） | ✅ 由检索实现调用 | 拒绝/过滤 | 已接（实现内部未逐行复核） |
| `gitReadonlyView` | ✅ 仓库路径 | ✅ 输出 DLP | 拒绝 | 已接 |
| `writeFileTemporary` / 写类工具 | 不适用（写方向） | — | — | not-applicable |
| 文档转换 / OCR | 未核实 | 未核实 | 未核实 | **未覆盖** |
| 插件 / MCP 工具结果 | 未核实 | 未核实 | 未核实 | **未覆盖** |
| 子进程 stdout/stderr | 未核实 | 未核实 | 未核实 | **未覆盖** |
| 缓存命中 / 恢复记录 / 报告导出 | 未核实 | 未核实 | 未核实 | **未覆盖** |
| 模型请求最终装配出口 | 未核实 | 未核实 | 未核实 | **未覆盖**（属 SEC-02-04/06） |

> 这张表只登记**已核实**的项；"未覆盖"不等于"不存在该通道"，而是**本轮没有取得证据**。
> 完整通道矩阵是 SEC-02-06 的交付物。

## 4. 生产调用链（源码位置）

```
policy-wrapper.ts（builtin 分支）
└─ executeBuiltinTool(..., { sensitiveContentAccessPolicy, requireSensitiveContentPolicy })
   └─ builtins.ts
      ├─ resolveSensitiveContentPolicy(executionContext, 操作名)   ← 缺失且要求 ⇒ 拒绝
      ├─ assertSensitiveContentAllowed（readFile / git 输出）
      ├─ listDirectory → filterSensitiveDirectoryEntries
      └─ searchProjectText(..., 策略)
application-runtime.ts createPolicyWrapperForAgent
└─ requireSensitiveContentPolicy: true（生产恒要求）
```

## 5. 未完成（如实）

- **TOCTOU 未解决**：没有句柄读取/读取后复核；检查与读取之间仍可被替换。
- **硬链接身份只覆盖管理员扩展路径**：默认名称规则没有具体路径，无法建立身份集合。
- **通道未覆盖**：文档转换/OCR、插件/MCP、子进程输出、缓存、恢复记录、报告导出、
  模型请求最终出口 —— 都还没有检查证据。
- **未验证**：没有跑过"缺策略 ⇒ 拒绝""硬链接别名 ⇒ 拒绝"任何一条。

## 6. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
