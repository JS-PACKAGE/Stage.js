# Stage.js 控制腳本（Windows PowerShell 5.1+ / PowerShell 7）
# 用法：.\stage.ps1 <command> [args]，執行 `.\stage.ps1 help` 查看指令。
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$RunDir = Join-Path $Root '.run'
$PidFile = Join-Path $RunDir 'stage.pid'
$LogFile = Join-Path $RunDir 'stage.log'
$ErrFile = Join-Path $RunDir 'stage.err.log'
$Entry = Join-Path $Root 'dist/src/index.js'
$StopTimeout = if ($env:STAGE_STOP_TIMEOUT) { [int]$env:STAGE_STOP_TIMEOUT } else { 15 }

Set-Location $Root

function Fail([string]$Message) {
  [Console]::Error.WriteLine("stage: $Message")
  exit 1
}

# npm 等外部指令失敗時 PowerShell 不會自動中止，需要檢查 exit code
function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Test-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '找不到 node（需要 Node.js 24 以上）' }
  $major = [int](& node -p 'process.versions.node.split(".")[0]')
  if ($major -lt 24) { Fail "Node.js 版本為 $(& node --version)，需要 24 以上" }
}

function Initialize-Config {
  if ($env:STAGE_CONFIG) {
    if (-not (Test-Path $env:STAGE_CONFIG)) { Fail "STAGE_CONFIG 指向的檔案不存在：$($env:STAGE_CONFIG)" }
    return
  }
  $cfg = Join-Path $Root 'config.yaml'
  if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $Root 'config.example.yaml') $cfg
    Write-Host '已從 config.example.yaml 建立 config.yaml，請依環境調整後再啟動正式服務。'
  }
}

function Get-RunningProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $id = (Get-Content $PidFile -Raw).Trim()
  $proc = if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue } else { $null }
  # PID 可能被系統重用，確認仍是 node 才算數
  if ($proc -and $proc.ProcessName -eq 'node') { return $proc }
  Remove-Item $PidFile -Force
  return $null
}

function Start-Stage {
  Test-Node
  $running = Get-RunningProcess
  if ($running) { Fail "已在執行中（pid $($running.Id)）" }
  if (-not (Test-Path $Entry)) { Fail "找不到 $Entry，請先執行 build" }
  Initialize-Config
  $startArgs = @{
    FilePath = 'node'; ArgumentList = "`"$Entry`""; WorkingDirectory = $Root
    RedirectStandardOutput = $LogFile; RedirectStandardError = $ErrFile; PassThru = $true
  }
  # -WindowStyle 只在 Windows 上有效（pwsh 在 macOS／Linux 會拒絕此參數）
  if ($env:OS -eq 'Windows_NT') { $startArgs.WindowStyle = 'Hidden' }
  $proc = Start-Process @startArgs
  Set-Content -Path $PidFile -Value $proc.Id
  # 設定錯誤或 port 被占用時程序會立刻退出，稍等一下再確認
  Start-Sleep -Seconds 1
  if ($proc.HasExited) {
    Remove-Item $PidFile -Force
    Get-Content $LogFile, $ErrFile -Tail 20 -ErrorAction SilentlyContinue | Write-Host
    Fail '啟動失敗，請查看上方 log'
  }
  Write-Host "已啟動（pid $($proc.Id)），log：$LogFile"
}

function Stop-Stage {
  $proc = Get-RunningProcess
  if (-not $proc) { Write-Host '未在執行'; return }
  # Windows 無法對背景 node 送 SIGTERM，只能直接終止；房間內的連線會由客戶端的斷線重連處理
  Stop-Process -Id $proc.Id
  if (-not $proc.WaitForExit($StopTimeout * 1000)) {
    [Console]::Error.WriteLine("$StopTimeout 秒內未結束，強制終止")
    Stop-Process -Id $proc.Id -Force
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "已停止（pid $($proc.Id)）"
}

function Show-Status {
  $proc = Get-RunningProcess
  if ($proc) { Write-Host "執行中（pid $($proc.Id)）" } else { Write-Host '未在執行'; exit 3 }
}

function Show-Logs([string[]]$LogArgs) {
  if (-not (Test-Path $LogFile)) { Fail "尚無 log：$LogFile" }
  $first = if ($LogArgs.Count -gt 0) { $LogArgs[0] } else { '' }
  if ($first -eq '-f') {
    Get-Content $LogFile -Tail 50 -Wait
  } else {
    $lines = if ($first) { [int]$first } else { 100 }
    Get-Content $LogFile -Tail $lines
    if ((Test-Path $ErrFile) -and (Get-Item $ErrFile).Length -gt 0) {
      Write-Host "--- stderr（$ErrFile）---"
      Get-Content $ErrFile -Tail $lines
    }
  }
}

function Show-Help {
  @'
用法：.\stage.ps1 <command> [args]

  install      安裝依賴（npm ci）
  build        建置伺服器、client 函式庫與範例前端
  start        於背景啟動已建置的伺服器（pid／log 位於 .run\）
  stop         停止伺服器（逾時後強制終止）
  restart      stop 後再 start
  status       顯示執行狀態（未執行時 exit code 3）
  logs [N|-f]  顯示最後 N 行 log（預設 100），-f 持續追蹤
  run          前景執行（給 NSSM／排程等外部監管使用）
  dev          開發模式（伺服器 watch，直接執行 TypeScript）
  test         型別檢查 + 測試

環境變數：
  STAGE_CONFIG        設定檔路徑（預設 .\config.yaml，不存在時自動由範例建立）
  STAGE_STOP_TIMEOUT  stop 等待秒數（預設 15）
'@ | Write-Host
}

switch ($Command) {
  'install' { Test-Node; Invoke-Checked 'npm' @('ci') }
  'build' { Test-Node; Invoke-Checked 'npm' @('run', 'build') }
  'start' { Start-Stage }
  'stop' { Stop-Stage }
  'restart' { Stop-Stage; Start-Stage }
  'status' { Show-Status }
  'logs' { Show-Logs $Rest }
  'run' { Test-Node; Initialize-Config; Invoke-Checked 'node' @($Entry) }
  'dev' { Test-Node; Initialize-Config; Invoke-Checked 'npm' @('run', 'dev') }
  'test' { Test-Node; Invoke-Checked 'npm' @('run', 'typecheck'); Invoke-Checked 'npm' @('test') }
  { $_ -in 'help', '-h', '--help' } { Show-Help }
  default { Show-Help; exit 2 }
}
