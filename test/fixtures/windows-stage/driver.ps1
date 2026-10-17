[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# Normalize captured diagnostics without changing the shipped script's bytes.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$Root = $PSScriptRoot
$Entry = Join-Path $Root 'dist/src/index.js'
$StageScript = Join-Path $Root 'stage.ps1'
$Caller = Join-Path $Root 'caller elsewhere'
$Settings = Get-Content (Join-Path $Root 'fixture-settings.json') -Raw | ConvertFrom-Json
$Owned = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$Observers = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$Actions = New-Object 'System.Collections.Generic.List[object]'
$Lookups = New-Object 'System.Collections.Generic.List[int]'
$Stops = New-Object 'System.Collections.Generic.List[int]'
$ObjectStops = New-Object 'System.Collections.Generic.List[int]'
$Cleanup = New-Object 'System.Collections.Generic.List[object]'
$DriverError = $null
# Explicit host-local state avoids resolving script: through the invoked script.
$global:StageFixtureState = @{
  Root = $Root; Entry = $Entry; Settings = $Settings; Owned = $Owned; Observers = $Observers
  StageScript = $StageScript; Caller = $Caller; Actions = $Actions
  Lookups = $Lookups; Stops = $Stops; ObjectStops = $ObjectStops
  Cleanup = $Cleanup; LaunchAttempts = 0; PidWriteFailure = $null; ForeignObjectRejections = 0
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
  $state.Owned.Add($process)
  # Pin a separate observer for safe cleanup without preconditioning the object
  # production receives: Windows PowerShell may not have opened its handle yet.
  $observer = [System.Diagnostics.Process]::GetProcessById($process.Id)
  $null = $observer.Handle
  $state.Observers.Add($observer)
  # The observer has the same ID but must never pass the object-identity guard.
  try {
    Stop-Process -InputObject $observer -Force -ErrorAction Stop
  } catch {
    if ($_.Exception.Message -cne 'Refusing a foreign process object, even with an owned ID') { throw }
    $state.ForeignObjectRejections++
  }
  if ($state.ForeignObjectRejections -ne $state.Owned.Count) { throw 'Foreign process object was not rejected' }
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
    if ($state.Settings.exitBeforePidWrite) {
      [System.IO.File]::WriteAllText((Join-Path $state.Root 'fixture-exit-before-pid-write'), $env:STAGE_FIXTURE_TOKEN)
      if (-not $observer.WaitForExit(5000)) { throw 'Synthetic pre-write exit timed out' }
    }
    # Real Set-Content failure after a ready child, before any PID persistence.
    $collision = Join-Path $state.Root '.run/stage.pid'
    $null = [System.IO.Directory]::CreateDirectory($collision)
    [System.IO.File]::WriteAllText((Join-Path $collision 'preserve-me'), 'operator data')
  }
  return $process
}

function Get-OwnedProcess([int]$Id) {
  foreach ($process in $global:StageFixtureState.Observers) {
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
  [CmdletBinding(DefaultParameterSetName = 'ById')]
  param(
    [Parameter(Mandatory = $true, ParameterSetName = 'ById')][int]$Id,
    [Parameter(Mandatory = $true, ParameterSetName = 'ByObject')][System.Diagnostics.Process]$InputObject,
    [switch]$Force
  )
  $state = $global:StageFixtureState
  if ($PSCmdlet.ParameterSetName -eq 'ByObject') {
    $ownedReference = $false
    foreach ($owned in $state.Owned) {
      if ([Object]::ReferenceEquals($InputObject, $owned)) { $ownedReference = $true; break }
    }
    if (-not $ownedReference) { throw 'Refusing a foreign process object, even with an owned ID' }
    $process = $InputObject
    $state.ObjectStops.Add($process.Id)
  } else {
    $process = Get-OwnedProcess $Id
  }
  $state.Stops.Add($process.Id)
  if ($state.Settings.cleanupFailure -eq 'throw') { throw 'Synthetic owned-process stop failure' }
  if ($state.Settings.cleanupFailure -eq 'timeout') { return }
  # Object-based cleanup forwards the exact returned object, not its observer.
  Microsoft.PowerShell.Management\Stop-Process -InputObject $process -Force:$Force
}

function Set-Content {
  [CmdletBinding()]
  param([string]$Path, [object]$Value)
  $state = $global:StageFixtureState
  if ($Path -cne (Join-Path $state.Root '.run/stage.pid')) { throw 'Refusing an unexpected PID write target' }
  $null = Get-OwnedProcess ([int]$Value)
  try {
    Microsoft.PowerShell.Management\Set-Content @PSBoundParameters
  } catch {
    $state.PidWriteFailure = @{ message = $_.Exception.Message; id = $_.FullyQualifiedErrorId }
    throw
  }
}

function Invoke-Stage([string]$Command, [string[]]$Rest = @()) {
  $state = $global:StageFixtureState
  Set-Location -LiteralPath $state.Caller
  $global:LASTEXITCODE = 0
  $output = @()
  $failure = $null
  $failureId = $null
  $failureMessage = $null
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $output = @(& $state.StageScript $Command @Rest 2>&1 6>&1)
    $code = $LASTEXITCODE
  } catch {
    $code = 1
    $failure = $_.ToString()
    $failureId = $_.FullyQualifiedErrorId
    $failureMessage = $_.Exception.Message
  }
  $timer.Stop()
  # Observe the return boundary before reading files or entering driver finally.
  $processesAtReturn = @(
    foreach ($observer in $state.Observers) {
      $observer.Refresh()
      @{ pid = $observer.Id; hasExited = $observer.HasExited; waitForExit = $observer.WaitForExit(0) }
    }
  )
  $pidText = $null
  $pidPath = Join-Path $state.Root '.run/stage.pid'
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $pidText = [System.IO.File]::ReadAllText($pidPath).Trim()
  }
  $global:StageFixtureState.Actions.Add(@{
    command = $Command; code = $code; failure = $failure; failureId = $failureId; failureMessage = $failureMessage
    processesAtReturn = $processesAtReturn; elapsedMs = $timer.ElapsedMilliseconds
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
  foreach ($process in $state.Observers) {
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
    objectStops = @($state.ObjectStops.ToArray()); pidWriteFailure = $state.PidWriteFailure
    foreignObjectRejections = $state.ForeignObjectRejections
    launchAttempts = $state.LaunchAttempts; ownedLaunches = $state.Owned.Count
    cleanup = @($state.Cleanup.ToArray()); error = $DriverError
  }
  $json = ConvertTo-Json -InputObject $report -Depth 8 -Compress
  [System.IO.File]::WriteAllText((Join-Path $state.Root 'fixture-report.json'), $json)
  foreach ($process in $state.Observers) { $process.Dispose() }
  foreach ($process in $state.Owned) { $process.Dispose() }
}
if ($DriverError) { throw $DriverError }
