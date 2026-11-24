#!/usr/bin/env bash
# B6（Linux 平台证据）一次性自检脚本 —— 只检查，不隐式安装。
#
# 用法：
#   bash scripts/linux-b6-bootstrap.sh            # 只检查并打印下一步
#   bash scripts/linux-b6-bootstrap.sh --install  # 显式安装缺失的系统包（需 sudo）
#
# 纪律：
# - 默认不安装任何东西；`--install` 也必须由人显式传入；
# - 不写入仓库、不联网下载模型/凭据；
# - 输出不打印用户名/主机名（只打印发行版与版本号）。
set -u

INSTALL_MODE="check"
for argument in "$@"; do
  if [ "$argument" = "--install" ]; then
    INSTALL_MODE="install"
  fi
done

fail_count=0

note() { printf '%s\n' "$*"; }
ok() { printf '[ok]   %s\n' "$*"; }
bad() { printf '[miss] %s\n' "$*"; fail_count=$((fail_count + 1)); }

note "== 1. 平台/发行版 =="
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  note "distro=${ID:-unknown} version=${VERSION_ID:-unknown} kernel=$(uname -r) arch=$(uname -m)"
else
  note "distro=unknown kernel=$(uname -r) arch=$(uname -m)"
fi

if [ "$(uname -s)" != "Linux" ]; then
  note "本脚本只用于 Linux（B6）；当前：$(uname -s)"
  exit 2
fi

note "== 2. Node.js（需 >= 20） =="
if command -v node >/dev/null 2>&1; then
  node_version="$(node -p 'process.versions.node')"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -ge 20 ]; then
    ok "node ${node_version}"
  else
    bad "node ${node_version}（需 >= 20）"
  fi
else
  bad "未安装 node（建议 NodeSource 20.x 或 nvm）"
fi

note "== 3. 构建/运行依赖 =="
for command_name in git make python3; do
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$command_name"
  else
    bad "$command_name（apt-get install -y build-essential git python3）"
  fi
done

note "== 4. bubblewrap（Linux 沙箱后端） =="
if command -v bwrap >/dev/null 2>&1; then
  ok "bwrap $(bwrap --version 2>/dev/null | head -n 1)"
  if bwrap --unshare-all --die-with-parent --ro-bind /usr /usr --dev /dev --proc /proc true 2>/dev/null; then
    ok "bwrap 用户命名空间可用（--unshare-all 探测通过）"
  else
    bad "bwrap 存在但探测失败：常见原因 = 未启用非特权用户命名空间，或 AppArmor 限制"
    note "      Ubuntu 24.04 可尝试：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
  fi
else
  bad "未安装 bubblewrap（apt-get install -y bubblewrap）"
fi

note "== 5. prlimit（资源上限前缀） =="
if command -v prlimit >/dev/null 2>&1; then
  ok "prlimit 可用"
else
  bad "缺少 prlimit（apt-get install -y util-linux）"
fi

if [ "$fail_count" -gt 0 ] && [ "$INSTALL_MODE" = "install" ]; then
  note ""
  note "== 安装缺失的系统包（显式 --install） =="
  if command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      apt-get update && apt-get install -y bubblewrap util-linux build-essential git python3
    else
      sudo apt-get update && sudo apt-get install -y bubblewrap util-linux build-essential git python3
    fi
    note "安装完成；请重新运行本脚本（不带 --install）复检。"
  else
    note "非 apt 发行版：请手动安装 bubblewrap / util-linux / build-essential / git / python3。"
  fi
  exit 0
fi

note ""
if [ "$fail_count" -gt 0 ]; then
  note "结果：$fail_count 项未满足。修复后重跑本脚本；可加 --install 让脚本显式安装 apt 包。"
  exit 1
fi

note "结果：全部满足。下一步（在仓库根目录）："
note "  npm ci"
note "  npm test"
note "  node scripts/verify-bubblewrap-acceptance.mjs   # 若存在；否则跑 npm run verify:exec01-03-preconditions"
