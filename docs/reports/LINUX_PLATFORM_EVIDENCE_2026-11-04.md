# Linux 平台证据（WSL2 Ubuntu，2026-11-04）

## 1. 环境

| 项 | 值 |
|---|---|
| 平台 | WSL2，Ubuntu（`wsl -l -v` 显示 Version 2） |
| 内核 | `6.18.33.2-microsoft-standard-WSL2` |
| Node | `v22.22.1` |
| npm | `9.2.0` |
| 文件系统 | 源码复制到 Linux 家目录后安装依赖（**不**在 `/mnt/c` 上跑 npm，避免 Windows `node_modules` 与 Linux 原生二进制冲突） |

## 2. 方法

```bash
# 在 WSL Ubuntu 内（源码来自公开仓库工作树，排除 node_modules/.git/dist）
cd ~/astarray-linux2
git init -q && git add -A && git -c user.email=evidence@example.invalid -c user.name=evidence commit -qm init
npm ci --no-audit --no-fund
npm run check
```

> `git init` 仅用于 `gitReadonlyView` 用例（它以 `process.cwd()` 为 git 仓库）；
> 不影响产品代码。

## 3. 结果

```
Test Files  600 passed (600)
Tests       4194 passed | 4 skipped (4198)
Duration    103.96s
check 退出码 0（typecheck + lint + test + build）
```

4 条 skip 为既有平台条件跳过；`Test Files` 无失败。

## 4. 为 Linux 修掉的两个真实缺口

### 4.1 zip 解压只依赖 `unzip`

`tool-package-zip-installer` 在非 Windows 上直接调用 `unzip`；机器没有 `unzip` 时安装失败
（WSL Ubuntu 默认未装）。现已回退到 Python 标准库：

1. 先试 `unzip -q`；
2. 失败则 `python3 -m zipfile -e <zip> <dest>`；
3. 两者都失败才报 `zip 解压失败`。

### 4.2 测试夹具依赖 PowerShell 打包

`tool-package-zip-installer.test.ts` 用 `Compress-Archive` 生成 zip，Linux 无 PowerShell。
现按平台选择：Windows 保持 `Compress-Archive`；其余用 `python3 -m zipfile -c`。

## 5. 边界

- 本证据是 **WSL2 Ubuntu**，不是原生 Linux 发行版，也不是 macOS；
- 桌面窗口/浏览器体验未在 Linux 验证（WSL 无 GUI 会话）；
- macOS 证据仍缺。

## 6. 追加复验（2026-11-04，会话/暗色相关改动之后）

同步 `mission-history-reader` 的 `conversationIdentifier` 后重跑：

```
Test Files  600 passed (600)
Tests       4195 passed | 4 skipped (4199)
exit 0
```

（新增的 1 条历史会话标识用例计入了总数。）

## 7. 追加复验（2026-11-05，发布准备之后）

同步最新源码（含 ALIGN 派生关系持久化）后重跑：

```
Test Files  601 passed (601)
Tests       4196 passed | 4 skipped (4200)
exit 0
```
