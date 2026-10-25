# Electron Windows 启动崩溃资料核对（2026-10-26）

对象：`Astarray.exe`（Electron 45，Windows 11 24H2 26100）双击无窗口，退出码 -2147483645（0x80000003）。

## 1. 外部资料

- **electron/electron PR #54483**：Windows 安装目录的 sandbox 无法读取时会触发 **GPU 进程崩溃循环**；修复方向是正确报告安装目录权限，而不是让 GPU 进程反复崩溃。
  <https://github.com/electron/electron/pull/54483>
- **desktop/desktop issue #22306**：Windows 11 Insider 26200/26300 上 **sandboxed GPU process 以 0x80000003 崩溃**；使用 `--disable-gpu-sandbox` 可以启动。
  <https://github.com/desktop/desktop/issues/22306>
- **Stack Overflow：Some Windows PCs forces Sandbox mode on Electron Chromium**：部分机器上 Chromium sandbox 启动失败，需要 `--no-sandbox`。
  <https://stackoverflow.com/questions/77992943/some-windows-pcs-forces-sandbox-mode-on-electron-chromium>
- 中文资料：Electron 启动失败与 LPAC/AppContainer 沙箱权限相关，可通过 `--no-sandbox` 验证是否沙箱路径问题。
  <https://m.bilibili.com/opus/1214843280815030291>

## 2. 与本机现象对照

本机验证（未修改系统安全设置）：

| 启动位置 | 参数 | 结果 |
|---|---|---|
| `Documents\astarray\...\dist` | 无 | `0x80000003`，无窗口 |
| `Documents\astarray\...\dist` | `--disable-gpu-sandbox` | 仍 `0x80000003` |
| `Documents\astarray\...\dist` | `--no-sandbox --disable-gpu` | 进程可进入 `app.whenReady`（受会话沙箱限制，写 TEMP 仍 EPERM） |
| `%LOCALAPPDATA%\Programs\Astarray` | 无 | 窗口正常打开，本地服务启动，项目创建 200 |

结论（与资料一致）：

1. **不是“Electron 包缺文件”**；同一份运行时在安装目录可启动。
2. 更像 **Chromium/GPU sandbox 与安装目录权限/安全软件** 的组合问题；0x80000003 是断点类崩溃，不是普通 JS 异常。
3. 安装到 `%LOCALAPPDATA%` 规避了安装目录 ACL/沙箱问题（对应 PR #54483）。
4. `--no-sandbox --disable-gpu` 可作为兼容启动路径；它会降低 Chromium 沙箱强度，只应在正常入口崩溃时临时使用。

## 3. 已落地的缓解

- `install-desktop.mjs` 安装到 `%LOCALAPPDATA%\Programs\Astarray`，创建正常快捷方式；
- 额外创建「Astarray (兼容模式)」快捷方式，参数为 `--no-sandbox --disable-gpu`；
- 正常入口仍保留完整 Chromium sandbox；
- 启动失败页记录错误并提供日志入口。

## 4. 未解决/待验证

- 本会话受限终端无法运行 Electron GUI，无法完成正常/兼容两种入口的最终冒烟；
- 兼容模式的安全影响需在发布说明中标注；
- 若安装版正常入口仍崩溃，需进一步采集 GPU 进程日志/WER，并考虑签名、`--disable-gpu-sandbox` 或固定 Electron 版本。
