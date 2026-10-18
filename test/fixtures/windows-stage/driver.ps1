[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# Normalize captured diagnostics without changing the shipped script's bytes.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$Root = $PSScriptRoot
$Entry = Join-Path $Root 'dist/src/index.js'
$Checker = Join-Path $Root 'dist/src/check-config.js'
$ExpectedNodePath = $env:STAGE_FIXTURE_NODE
if ([String]::IsNullOrWhiteSpace($ExpectedNodePath) -or -not [System.IO.Path]::IsPathRooted($ExpectedNodePath)) {
  throw 'Missing absolute fixture Node executable'
}
# Application discovery can return multiple installed Nodes even without -All.
# Select the PATH-first command object before reading its scalar Source.
$NodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if ($NodePath -isnot [string] -or [String]::IsNullOrWhiteSpace($NodePath) -or
    -not [System.IO.Path]::IsPathRooted($NodePath) -or
    [System.IO.Path]::GetFileName($NodePath) -ine 'node.exe' -or
    -not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or
    -not [String]::Equals([System.IO.Path]::GetFullPath($NodePath),
      [System.IO.Path]::GetFullPath($ExpectedNodePath), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'PATH-first Node must be the exact executable supplied by the fixture runner'
}
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
$Events = New-Object 'System.Collections.Generic.List[object]'
$DriverError = $null
# Explicit host-local state avoids resolving script: through the invoked script.
$global:StageFixtureState = @{
  Root = $Root; Entry = $Entry; Checker = $Checker; NodePath = $NodePath
  Settings = $Settings; Owned = $Owned; Observers = $Observers
  StageScript = $StageScript; Caller = $Caller; Actions = $Actions
  Lookups = $Lookups; Stops = $Stops; ObjectStops = $ObjectStops
  Events = $Events; Phase = $null; RestartEnvironment = $null
  Cleanup = $Cleanup; LaunchAttempts = 0; PidWriteFailure = $null; ForeignObjectRejections = 0
}

# Restart fixtures constrain direct native invocations as well as background
# launches. The native probe really emits 24 and exits nonzero; no fake status.
if ($Settings.restart) {
  function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    $state = $global:StageFixtureState
    if ($Name -cne 'node') { throw 'Refusing an unexpected command lookup' }
    if ($state.Phase -eq 'restart' -and $state.Settings.restartCase -eq 'missing-node') {
      $state.Events.Add(@{ kind = 'node-missing'; phase = $state.Phase })
      return $null
    }
    Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
  }

  function node {
    $state = $global:StageFixtureState
    $nodeArgs = @($args)
    if ($nodeArgs.Count -eq 2 -and $nodeArgs[0] -ceq '-p' -and
        $nodeArgs[1] -ceq 'parseInt(process.versions.node)') {
      $state.Events.Add(@{ kind = 'node-version'; phase = $state.Phase })
      if ($state.Phase -eq 'restart' -and $state.Settings.restartCase -eq 'node-failure') {
        & $state.NodePath (Join-Path $state.Root 'fixture-node-failure.cjs')
      } elseif ($state.Phase -eq 'restart' -and $state.Settings.restartCase -eq 'old-node') {
        & $state.NodePath (Join-Path $state.Root 'fixture-node-old.cjs')
      } else {
        & $state.NodePath @nodeArgs
      }
    } elseif ($nodeArgs.Count -eq 1 -and $nodeArgs[0] -ceq '--version' -and
        $state.Phase -eq 'restart' -and $state.Settings.restartCase -eq 'old-node') {
      $state.Events.Add(@{ kind = 'node-label'; phase = $state.Phase })
      & $state.NodePath (Join-Path $state.Root 'fixture-node-label.cjs')
    } elseif ($nodeArgs.Count -eq 1 -and $nodeArgs[0] -ceq $state.Checker) {
      $state.Events.Add(@{ kind = 'checker'; phase = $state.Phase })
      & $state.NodePath @nodeArgs
      $state.Events.Add(@{ kind = 'checker-exit'; phase = $state.Phase; code = $LASTEXITCODE })
    } else {
      $state.Events.Add(@{ kind = 'rejected-native-invocation'; phase = $state.Phase })
      throw 'Refusing an unreviewed native Node invocation'
    }
    $global:LASTEXITCODE = $LASTEXITCODE
  }
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
  $state.Events.Add(@{ kind = 'launch'; phase = $state.Phase })
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
  if ($state.Settings.pidCollision -or $state.Settings.restart) {
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
  }
  if ($state.Settings.pidCollision) {
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
  $state.Events.Add(@{ kind = 'stop'; phase = $state.Phase; pid = $process.Id })
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
  $state.Phase = $Command
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
  $pidBytes = $null
  $pidPath = Join-Path $state.Root '.run/stage.pid'
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $pidText = [System.IO.File]::ReadAllText($pidPath).Trim()
    $pidBytes = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($pidPath))
  }
  $global:StageFixtureState.Actions.Add(@{
    command = $Command; code = $code; failure = $failure; failureId = $failureId; failureMessage = $failureMessage
    processesAtReturn = $processesAtReturn; elapsedMs = $timer.ElapsedMilliseconds
    output = ($output | Out-String); pidText = $pidText; pidBytes = $pidBytes
    stops = $state.Stops.Count
    launched = $global:StageFixtureState.Owned.Count; attempts = $global:StageFixtureState.LaunchAttempts
  })
}

$tokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($global:StageFixtureState.StageScript, [ref]$tokens, [ref]$parseErrors)
try {
  if (-not $global:StageFixtureState.Settings.skipInitialStart) { Invoke-Stage 'start' }
  if ($global:StageFixtureState.Settings.restart) {
    if (-not $global:StageFixtureState.Settings.skipInitialStart -and $global:StageFixtureState.Actions[0].code -ne 0) {
      throw 'Restart fixture could not start its owned old child'
    }
    $state = $global:StageFixtureState
    $config = Join-Path $state.Root 'config.yaml'
    switch ($state.Settings.restartCase) {
      'missing-entry' { Remove-Item -LiteralPath $state.Entry }
      'entry-directory' {
        Remove-Item -LiteralPath $state.Entry
        $null = [System.IO.Directory]::CreateDirectory($state.Entry)
      }
      'missing-checker' { Remove-Item -LiteralPath $state.Checker }
      'checker-directory' {
        Remove-Item -LiteralPath $state.Checker
        $null = [System.IO.Directory]::CreateDirectory($state.Checker)
      }
      'missing-config' { $env:STAGE_CONFIG = 'missing config.yaml' }
      'valid-relative' { $env:STAGE_CONFIG = 'configuration files/custom config.yaml' }
      'valid-default' { Remove-Item Env:STAGE_CONFIG -ErrorAction SilentlyContinue }
      'valid-default-copy' {
        Remove-Item Env:STAGE_CONFIG -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $config
      }
      'empty-environment-transport' { $env:STAGE_CONFIG = '' }
      'missing-default-example' {
        Remove-Item Env:STAGE_CONFIG -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $config
        Remove-Item -LiteralPath (Join-Path $state.Root 'config.example.yaml')
      }
    }
    $state.RestartEnvironment = [Environment]::GetEnvironmentVariable('STAGE_CONFIG')
    Invoke-Stage 'restart'
  }
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
    version = $PSVersionTable.PSVersion.ToString(); nodePath = $state.NodePath
    actions = @($state.Actions.ToArray())
    parseErrors = @($parseErrors | ForEach-Object { $_.ToString() })
    lookups = @($state.Lookups.ToArray()); stops = @($state.Stops.ToArray())
    objectStops = @($state.ObjectStops.ToArray()); pidWriteFailure = $state.PidWriteFailure
    foreignObjectRejections = $state.ForeignObjectRejections
    launchAttempts = $state.LaunchAttempts; ownedLaunches = $state.Owned.Count
    events = @($state.Events.ToArray()); restartEnvironment = $state.RestartEnvironment
    cleanup = @($state.Cleanup.ToArray()); error = $DriverError
  }
  $json = ConvertTo-Json -InputObject $report -Depth 8 -Compress
  [System.IO.File]::WriteAllText((Join-Path $state.Root 'fixture-report.json'), $json)
  foreach ($process in $state.Observers) { $process.Dispose() }
  foreach ($process in $state.Owned) { $process.Dispose() }
}
if ($DriverError) { throw $DriverError }
