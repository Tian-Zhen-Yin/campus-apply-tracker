#!/bin/bash
# 校招投递控制台 · 终端一键安装（macOS）
# 免下载 zip——命令行拉取的文件没有 quarantine 隔离属性，全程不触发 Gatekeeper。
# 用法：curl -fsSL https://gitee.com/YinTianZheng/campus-apply-tracker/raw/master/scripts/quick-install.sh | bash
# 已安装过？重复执行即更新到最新版（数据在 ~/.ats-status，不受影响）。
set -u

say() { echo "▸ $*"; }
fail() { echo "✗ $*"; echo "  也可手动安装（zip 下载）：https://github.com/Tian-Zhen-Yin/campus-apply-tracker/releases/latest"; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "此脚本用于 macOS；Windows 在 PowerShell 里执行 quick-install.ps1"
command -v git >/dev/null 2>&1 || fail "未找到 git——先执行: xcode-select --install（或 brew install git）"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "未找到 Node.js（需 ≥18）——先执行: brew install node（或 https://nodejs.org 下载）"
[ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 18 ] || fail "Node 版本过旧（$("$NODE_BIN" -v)），需要 ≥18——brew upgrade node"

# 全程匿名拉取公开仓库:禁掉一切凭证来源,网络/仓库问题时快速失败回落,绝不弹账号密码框
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=echo
GIT_ANON=(-c credential.helper=)

MAIN_URL="https://gitee.com/YinTianZheng/campus-apply-tracker.git"
MAIN_URL_FALLBACK="https://github.com/Tian-Zhen-Yin/campus-apply-tracker.git"
# 台账前端仓库目前只在 GitHub:gitee 同名地址不存在,git 会因它请求凭证——必须主走 GitHub
TRACKER_URL="https://github.com/Tian-Zhen-Yin/campus-recruitment-tracker.git"
TRACKER_URL_FALLBACK="https://gitee.com/YinTianZheng/campus-recruitment-tracker.git"
REPO_DIR="$HOME/campus-apply-tracker"

clone_or_update() { # $1=url $2=fallback $3=dir $4=extra-clone-args...
  local url="$1" fallback="$2" dir="$3"; shift 3
  if [ -d "$dir/.git" ]; then
    git "${GIT_ANON[@]}" -C "$dir" fetch --depth 1 origin master >/dev/null 2>&1 || return 1
    git "${GIT_ANON[@]}" -C "$dir" reset --hard origin/master >/dev/null || return 1
  else
    git "${GIT_ANON[@]}" clone --depth 1 "$@" "$url" "$dir" >/dev/null 2>&1 || \
      git "${GIT_ANON[@]}" clone --depth 1 "$@" "$fallback" "$dir" >/dev/null 2>&1 || return 1
  fi
}

say "获取主程序 → $REPO_DIR"
clone_or_update "$MAIN_URL" "$MAIN_URL_FALLBACK" "$REPO_DIR" || fail "克隆仓库失败（网络？）"

say "获取台账前端（内嵌页面）……"
if ! clone_or_update "$TRACKER_URL" "$TRACKER_URL_FALLBACK" "$REPO_DIR/tracker" \
  --filter=blob:none --sparse; then
  fail "台账前端仓库克隆失败（网络？）"
fi
git -C "$REPO_DIR/tracker" sparse-checkout set index.html manifest.webmanifest service-worker.js icons ocr docs 使用说明.txt >/dev/null 2>&1

say "进入安装器（装依赖 + 常驻服务 + 定时任务 + 打开控制台）……"
cd "$REPO_DIR"
exec bash scripts/install.sh
