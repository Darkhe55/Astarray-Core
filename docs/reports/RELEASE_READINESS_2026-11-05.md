# 发布就绪清单（2026-11-05）

本文件记录**可复现**的发布前验收；未执行的项明确写"未验证"。

## 1. 版本与产物

| 项 | 值 |
|---|---|
| 公开包版本 | `0.1.0` |
| 公开包 bin | `astarray -> dist/cli.js` |
| 公开包 `files` | `dist`、`README.md`、`LICENSE` |
| 公开 tarball | 283 files，约 2.39 MB（`npm pack`） |

## 2. 公开包：tarball 隔离安装验收

```powershell
npm pack            # prepack = typecheck + lint + test + build
# 在空目录：
npm init -y
npm install <astarray-0.1.0.tgz>
node node_modules/astarray/dist/cli.js --help
node node_modules/astarray/dist/cli.js __nope__
```

实测（2026-11-05）：

- `npm install` → 43 packages，exit 0；
- `--help` → 打印用法，exit 0；
- 非法参数 → `too many arguments`，exit 1（非 0）。


## 4. 门禁基线

| 平台 | 结果 |
|---|---|---|
| Windows | 601 files / 4200 tests |
| Linux（WSL2 Ubuntu） | 600 files / 4195 + 4 skip（截至上次复验） |

配套 UI 产物的验收记录不在公开仓库。

## 5. 未完成（发布前需人确认）

1. 真实浏览器交互（本机无 Chrome/Edge）；
2. 键盘焦点顺序 / Escape（CDP 无法驱动，已记录）；
3. 屏幕阅读器实际播报（NVDA/讲述人）；
4. 像素级视觉、原生标题栏与系统滚动条外观；
5. macOS（用户明确暂不做）；
6. Linux 桌面窗口/Electron 壳未验（WSL 无 GUI）。

## 6. 发布前建议步骤

1. 用最新 HEAD 重跑双平台全量门禁（Linux 需同步源码后重跑）；
2. 按本机人工清单完成 1–4；
3. 更新 README 的版本/安装说明（如需）；
4. 打 tag 前确认公开历史无敏感标识（新克隆 `git log -S` 复核）。
