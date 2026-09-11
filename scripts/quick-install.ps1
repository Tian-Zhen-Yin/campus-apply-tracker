# 校招投递控制台 · 终端一键安装（Windows PowerShell）
# 免下载 zip——命令行拉取的文件没有 Mark-of-the-Web 标记，SmartScreen 检查更少。
# 用法：在 PowerShell 里执行
#   irm https://gitee.com/YinTianZheng/campus-apply-tracker/raw/master/scripts/quick-install.ps1 | iex
# 已安装过？重复执行即更新到最新版（数据在 ~/.ats-status，不受影响）。
$ErrorActionPreference = 'Stop'

function Fail($m) {
  Write-Host "✗ $m"
  Write-Host "  也可手动安装（zip 下载）：https://github.com/Tian-Zhen-Yin/campus-apply-tracker/releases/latest"
  exit 1
}

if ($PSVersionTable.PSVersion.Major -lt 5) { Fail "需要 Windows PowerShell 5+（系统自带）" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "未找到 git——先安装：https://git-scm.com/download/win" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "未找到 Node.js（需 ≥18）——先安装：https://nodejs.org/zh-cn 下载 LTS 版" }

$MainUrl = 'https://gitee.com/YinTianZheng/campus-apply-tracker.git'
$MainUrlFallback = 'https://github.com/Tian-Zhen-Yin/campus-apply-tracker.git'
$TrackerUrl = 'https://gitee.com/YinTianZheng/campus-recruitment-tracker.git'
$TrackerUrlFallback = 'https://github.com/Tian-Zhen-Yin/campus-recruitment-tracker.git'
$RepoDir = "$HOME\campus-apply-tracker"

function Clone-OrUpdate($url, $fallback, $dir, $extra) {
  if (Test-Path "$dir\.git") {
    git -C $dir fetch --depth 1 origin master 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    git -C $dir reset --hard origin/master 2>$null
    return ($LASTEXITCODE -eq 0)
  }
  git clone --depth 1 @extra $url $dir 2>$null
  if ($LASTEXITCODE -ne 0) { git clone --depth 1 @extra $fallback $dir 2>$null }
  return ($LASTEXITCODE -eq 0)
}

Write-Host "▸ 获取主程序 → $RepoDir"
if (-not (Clone-OrUpdate $MainUrl $MainUrlFallback $RepoDir @())) { Fail "克隆仓库失败（网络？）" }

Write-Host "▸ 获取台账前端（内嵌页面）……"
if (-not (Clone-OrUpdate $TrackerUrl $TrackerUrlFallback "$RepoDir\tracker" @('--filter=blob:none', '--sparse'))) { Fail "台账前端仓库克隆失败（网络？）" }
git -C "$RepoDir\tracker" sparse-checkout set index.html manifest.webmanifest service-worker.js icons ocr docs 使用说明.txt 2>$null

Write-Host "▸ 安装依赖（npm install）……"
Push-Location $RepoDir
npm install --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "依赖安装失败（Node/npm 可用？）" }

Write-Host "▸ 进入安装器（便携 Node + 定时任务 + 打开控制台）……"
& powershell -NoProfile -ExecutionPolicy Bypass -File "$RepoDir\scripts\win\install.ps1"
Pop-Location
