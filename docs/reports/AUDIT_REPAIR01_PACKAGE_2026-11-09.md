# AUDIT-REPAIR-01 检查点 05：包级验收（2026-11-09 复验）

本报告取代 `AUDIT_REPAIR01_PACKAGE_2026-11-06.md` 作为**当前 HEAD 的证据**。
11-06 报告保留原样，其"prepack 失败未定位"的记述不被抹掉；本报告给出后续复验结论。

## 1. 基线

| 项 | 值 |
|---|---|
| 代码 SHA | `a8e3e1d4`（打包时 HEAD，工作区无未提交的源码改动） |
| tarball | `astarray-0.1.0.tgz` |
| tarball SHA256 | `C3A6519045F37CA420105C256F07DFFAE23242D175311A982F1CD9F3E1E1346B` |
| npm shasum（SHA1） | `f5da888d6f74ebed8ae23f8fb4da08fe348873c1` |
| 文件数 / 解包大小 | 287 files / 10.5 MB（压缩后 2.5 MB） |

## 2. 命令与结果

| 步骤 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 打包（**含 prepack**） | `npm pack` | **0** | 287 files；prepack 全绿 |
| 隔离安装 | `npm install ./astarray-0.1.0.tgz` | 0 | 0 vulnerabilities |
| 包内闭环 | `node package-closure.mjs <installDir>` | 0 | 见 §3 |

**关于 11-06 的 prepack 记述**：当时常规 `npm pack` 的 prepack 连续两次失败且未保留输出，
于是改用 `--ignore-scripts` 出包。本轮在**当前 HEAD 上直接 `npm pack`（不忽略脚本）成功，退出码 0**
—— 结合 11-08 两次独立打包记录（prepack exit 0），更可能是当时的负载抖动。
**这不能反证 11-06 当时的失败不存在**，只是说：现在复现不了，且当前 HEAD 的 prepack 是绿的。

## 3. 隔离包闭环（只用安装后的包）

脚本只使用安装后的 `node_modules/astarray/dist/*`（`file://` 导入）与 `dist/cli.js`，
不引用仓库源码绝对路径。

```json
{
  "anthropic": { "exitCode": 0, "requestCount": 1 },
  "goalProposal": { "proposalCreated": true, "confirmationRejected": true }
}
```

| 断言 | 结果 |
|---|---|
| 本地 fake-server 收到 1 次请求，CLI 退出码 0（mission `done`） | 通过 |
| `proposeGoal` 经真实装配在包内**能落提案** | 通过 |
| 未确认时**拒绝生成契约**（`confirmationRejected: true`） | 通过 |

> 如实记录：`hasText` 为 `false` —— `--json` 输出的是 mission 摘要而非助手正文，
> 因此该字段不构成"文本未送达"的证据；闭环判定以退出码与请求计数为准。

## 4. 门禁（同一源码，独立于打包）

| 命令 | 结果 |
|---|---|
| `npm run check:low-parallel` | **646 files / 4447 passed + 3 skipped**（exit 0） |

## 5. 仍未做（如实）

- **干净设备/无缓存环境**的安装验收未做（本机是开发者环境）；
- macOS 与 Linux 的打包/安装矩阵未做（仅 Windows 本机）；
- 包内闭环只覆盖 Anthropic 协议 fake-server 与目标提案两条路径，未覆盖 `processExecution`
  （其真实后端属 EXEC-01-02，当前为 `null`）。
