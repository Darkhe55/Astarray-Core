#!/usr/bin/env bash
# 在 **Linux** 上交叉编译 Windows 版 sandbox-helper.exe（GNU 目标，静态 CRT）。
#
# 适用场景：Windows 本机 rustup/MSVC 下载太慢，但 Linux 主机（如轻量服务器）网络快。
# 产物是标准 PE32+ 可执行文件，Windows 上可直接运行（不需要额外 DLL）。
#
# 用法：
#   bash scripts/build-sandbox-helper-linux-cross.sh
#
# 依赖（脚本只检查，不隐式安装）：
#   - rustc / rustup
#   - rustup target: x86_64-pc-windows-gnu
#   - 链接器: x86_64-w64-mingw32-gcc（apt: gcc-mingw-w64-x86-64）
set -u

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper_directory="$repository_root/native/sandbox-helper"
output_path="$helper_directory/sandbox-helper.exe"

fail() { printf '[miss] %s\n' "$*"; exit 1; }
ok() { printf '[ok]   %s\n' "$*"; }

if [ "$(uname -s)" != "Linux" ]; then
  fail "本脚本用于在 Linux 上交叉编译 Windows 产物；当前平台：$(uname -s)"
fi

command -v rustc >/dev/null 2>&1 || fail "缺少 rustc/rustup：安装 Rust（rustup）后重试"
command -v rustup >/dev/null 2>&1 || fail "缺少 rustup"
ok "rustc $(rustc --version)"

if rustup target list --installed 2>/dev/null | grep -qx "x86_64-pc-windows-gnu"; then
  ok "target x86_64-pc-windows-gnu 已安装"
else
  fail "缺少 target：请运行 rustup target add x86_64-pc-windows-gnu"
fi

if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  ok "mingw 链接器可用"
else
  fail "缺少 mingw 链接器：sudo apt-get install -y gcc-mingw-w64-x86-64"
fi

if [ ! -f "$helper_directory/src/main.rs" ]; then
  fail "找不到 $helper_directory/src/main.rs"
fi

printf '构建中：rustc --target x86_64-pc-windows-gnu -O -C target-feature=+crt-static\n'
(
  cd "$helper_directory" || exit 1
  rustc --target x86_64-pc-windows-gnu -O -C target-feature=+crt-static \
    src/main.rs -o sandbox-helper.exe
) || fail "交叉编译失败（把上面的 rustc 错误发给我）"

[ -f "$output_path" ] || fail "构建结束但未生成 $output_path"
ok "已生成 $output_path"
file "$output_path" || true
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$output_path"
fi

printf '\n下一步：\n'
printf '  1) 把 native/sandbox-helper/sandbox-helper.exe 复制到 Windows 仓库同路径；\n'
printf '  2) Windows 管理员 PowerShell 跑一次：& .\\native\\sandbox-helper\\sandbox-helper.exe probe\n'
printf '  3) 普通会话：node scripts/verify-exec01-03-preconditions.mjs --strict\n'
