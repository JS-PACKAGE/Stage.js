[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Entry = Join-Path $Root 'dist/src/index.js'
$StageScript = Join-Path $Root 'stage.ps1'
$Caller = Join-Path $Root 'caller elsewhere'
$Settings = Get-Content (Join-Path $Root 'fixture-settings.json') -Raw | ConvertFrom-Json
$Owned = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$Actions = New-Object 'System.Collections.Generic.List[object]'
$Lookups = New-Object 'System.Collections.Generic.List[int]'
$Stops = New-Object 'System.Collections.Generic.List[int]'
$Cleanup = New-Object 'System.Collections.Generic.List[object]'
$DriverError = $null
# Explicit host-local state avoids resolving script: through the invoked script.
$global:StageFixtureState = @{
  Root = $Root; Entry = $Entry; Settings = $Settings; Owned = $Owned
  StageScript = $StageScript; Caller = $Caller; Actions = $Actions
  Lookups = $Lookups; Stops = $Stops; Cleanup = $Cleanup; LaunchAttempts = 0
}

function Start-Process {
  [CmdletBinding()]
  param(
    [string]$FilePath, [string]$ArgumentList, [string]$WorkingDirectory,
    [string]$RedirectStandardOutput, [string]$RedirectStandardError,
    [switch]$PassThru, [string]$WindowStyle
  )
  $state = $global:StageFixtureState
  if ($FilePath -cne 'node' -or $ArgumentList -cne ('"' + $state.Entry + '"') -or
      $WorkingDirectory -cne $state.Root -or -not $PassThru -or
      $RedirectStandardOutput -cne (Join-Path $state.Root '.run/stage.log') -or
      $RedirectStandardError -cne (Join-Path $state.Root '.run/stage.err.log') -or
      $WindowStyle -cne 'Hidden') { throw 'Refusing an unowned process launch' }
  $state.LaunchAttempts++
  $process = Microsoft.PowerShell.Management\Start-Process @PSBoundParameters
  # Retain the OS handle, not just its recyclable PID, throughout this driver.
  $null = $process.Handle
  $state.Owned.Add($process)
  if ($state.Settings.pidCollision) {
    $readyPath = Join-Path $state.Root ("fixture-ready-{0}.json" -f $process.Id)
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not (Test-Path -LiteralPath $readyPath)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Synthetic child readiness timed out' }
      Start-Sleep -Milliseconds 25
    }
    $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
    if ($ready.pid -ne $process.Id -or $ready.token -cne $env:STAGE_FIXTURE_TOKEN) {
      throw 'Synthetic child readiness ownership mismatch'
    }
    # Inject a write failure only after launch, to test the harness finally.
    $collision = Join-Path $state.Root '.run/stage.pid'
    $null = [System.IO.Directory]::CreateDirectory($collision)
    [System.IO.File]::WriteAllText((Join-Path $collision 'preserve-me'), 'operator data')
  }
  return $process
}

function Get-OwnedProcess([int]$Id) {
  foreach ($process in $global:StageFixtureState.Owned) {
    if ($process.Id -eq $Id) { return $process }
  }
  throw "Refusing unowned process ID $Id"
}

function Get-Process {
  [CmdletBinding()]
  param([int]$Id)
  $process = Get-OwnedProcess $Id
  $global:StageFixtureState.Lookups.Add($Id)
  $process.Refresh()
  if (-not $process.HasExited) { return $process }
}

function Stop-Process {
  [CmdletBinding()]
  param([int]$Id, [switch]$Force)
  $process = Get-OwnedProcess $Id
  $global:StageFixtureState.Stops.Add($Id)
  # Forward the real Windows termination operation using the retained handle.
  Microsoft.PowerShell.Management\Stop-Process -InputObject $process -Force:$Force
}

function Invoke-Stage([string]$Command, [string[]]$Rest = @()) {
  $state = $global:StageFixtureState
  Set-Location -LiteralPath $state.Caller
  $global:LASTEXITCODE = 0
  $output = @()
  $failure = $null
  try {
    $output = @(& $state.StageScript $Command @Rest 2>&1 6>&1)
    $code = $LASTEXITCODE
  } catch {
    $code = 1
    $failure = $_.ToString()
  }
  $pidText = $null
  $pidPath = Join-Path $state.Root '.run/stage.pid'
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $pidText = [System.IO.File]::ReadAllText($pidPath).Trim()
  }
  $global:StageFixtureState.Actions.Add(@{
    command = $Command; code = $code; failure = $failure
    output = ($output | Out-String); pidText = $pidText
    launched = $global:StageFixtureState.Owned.Count; attempts = $global:StageFixtureState.LaunchAttempts
  })
}

$tokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($global:StageFixtureState.StageScript, [ref]$tokens, [ref]$parseErrors)
try {
  Invoke-Stage 'start'
  if ($global:StageFixtureState.Settings.lifecycle -and $global:StageFixtureState.Actions[0].code -eq 0) {
    Invoke-Stage 'status'
    Invoke-Stage 'logs' @('10')
    Invoke-Stage 'start'
    Invoke-Stage 'stop'
    Invoke-Stage 'status'
    Invoke-Stage 'stop'
  }
} catch {
  $DriverError = $_.ToString()
} finally {
  $state = $global:StageFixtureState
  foreach ($process in $state.Owned) {
    $process.Refresh()
    $neededCleanup = -not $process.HasExited
    if ($neededCleanup) {
      Microsoft.PowerShell.Management\Stop-Process -InputObject $process -Force
    }
    $exited = $process.WaitForExit(5000)
    $state.Cleanup.Add(@{ pid = $process.Id; exited = $exited; neededCleanup = $neededCleanup })
  }
  $report = @{
    version = $PSVersionTable.PSVersion.ToString(); actions = @($state.Actions.ToArray())
    parseErrors = @($parseErrors | ForEach-Object { $_.ToString() })
    lookups = @($state.Lookups.ToArray()); stops = @($state.Stops.ToArray())
    launchAttempts = $state.LaunchAttempts; cleanup = @($state.Cleanup.ToArray()); error = $DriverError
  }
  $json = ConvertTo-Json -InputObject $report -Depth 8 -Compress
  [System.IO.File]::WriteAllText((Join-Path $state.Root 'fixture-report.json'), $json)
  foreach ($process in $state.Owned) { $process.Dispose() }
}
if ($DriverError) { throw $DriverError }
