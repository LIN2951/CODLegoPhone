[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 1030,
    [string]$BindHost = '',
    [switch]$CheckOnly,
    [switch]$Background,
    [int]$ExpectedPid = 0
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$entryFile = Join-Path $projectRoot 'server.js'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $workspaceId = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant().Substring(0, 16)
} finally { $hasher.Dispose() }

function Get-ListenerIds {
    $found = @()
    foreach ($line in (& netstat.exe -ano -p tcp)) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -ge 5 -and $parts[1] -match (':' + $Port + '$') -and $parts[3] -eq 'LISTENING') {
            $found += [int]$parts[4]
        }
    }
    return @($found | Sort-Object -Unique)
}
function Read-LegoHealth {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 }
    catch { return $null }
}
function Test-LegacyWorkspace {
    # Older releases have no health route and launch with a relative server.js path.
    # Require both source files served by that listener to match this checkout byte-for-byte.
    try {
        foreach ($name in @('server.js', 'app.js')) {
            $sourceResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/$name" -TimeoutSec 3
            $sourceResponse.RawContentStream.Position = 0
            $remoteHash = (Get-FileHash -InputStream $sourceResponse.RawContentStream -Algorithm SHA256).Hash
            $localHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot $name) -Algorithm SHA256).Hash
            if ($remoteHash -ne $localHash) { return $false }
        }
        return $true
    } catch { return $false }
}

$listenerIds = @(Get-ListenerIds)
$health = if ($listenerIds.Count) { Read-LegoHealth } else { $null }
$verified = @()
foreach ($listenerId in $listenerIds) {
    if ($ExpectedPid -and $listenerId -ne $ExpectedPid) {
        throw "Port $Port changed owner (PID $listenerId); no process was stopped."
    }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerId"
    $absoluteEntry = '(?i)(?:^|\s)"?' + [regex]::Escape($entryFile) + '"?(?=\s|$)'
    $matchesCommand = $owner.CommandLine -and $owner.CommandLine -match $absoluteEntry
    $matchesHealth = $health -and $health.service -eq 'lego-miniphone' -and $health.workspaceId -eq $workspaceId -and $health.pid -eq $listenerId
    $matchesLegacy = $false
    if ($owner.Name -eq 'node.exe' -and !$matchesCommand -and !$matchesHealth -and $owner.CommandLine -match '(?i)(?:^|\s)"?server\.js"?(?=\s|$)') {
        $matchesLegacy = Test-LegacyWorkspace
    }
    if ($owner.Name -ne 'node.exe' -or !($matchesCommand -or $matchesHealth -or $matchesLegacy)) {
        throw "Port $Port belongs to an unverified process (PID $listenerId). Close that service yourself or choose another port; no process was stopped."
    }
    $verified += $owner
}
if ($CheckOnly) {
    [pscustomobject]@{ workspaceId = $workspaceId; port = $Port; verifiedPids = $listenerIds; entry = $entryFile } | ConvertTo-Json -Compress
    exit 0
}

# Verify every owner before stopping any process. Recheck identity to guard PID reuse.
foreach ($owner in $verified) {
    $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ProcessId)"
    if (!$fresh -or $fresh.CreationDate -ne $owner.CreationDate -or $fresh.CommandLine -ne $owner.CommandLine) {
        throw 'The service process changed; restart cancelled.'
    }
    Write-Host "[RESTART] verified Lego service PID $($owner.ProcessId)"
    Stop-Process -Id $owner.ProcessId -Force -ErrorAction Stop
}
for ($attempt = 0; $attempt -lt 30 -and @(Get-ListenerIds).Count; $attempt++) { Start-Sleep -Milliseconds 100 }
if (@(Get-ListenerIds).Count) { throw "Port $Port is still occupied; no additional process was stopped." }

$env:PORT = [string]$Port
if ($BindHost) { $env:HOST = $BindHost }
Set-Location -LiteralPath $projectRoot
Write-Host "[START] $($nodeCommand.Source) - port $Port"
if (!$Background) {
    & $nodeCommand.Source $entryFile
    exit $LASTEXITCODE
}
$logBase = Join-Path ([IO.Path]::GetTempPath()) ('lego-api-' + $workspaceId)
$stdoutFile = $logBase + '.stdout.log'
$stderrFile = $logBase + '.stderr.log'
$service = Start-Process -FilePath $nodeCommand.Source -ArgumentList @(('"' + $entryFile + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru
for ($attempt = 0; $attempt -lt 25; $attempt++) {
    if ($service.HasExited) { throw "Service exited. See $stderrFile" }
    $ready = Read-LegoHealth
    if ($ready -and $ready.pid -eq $service.Id -and $ready.workspaceId -eq $workspaceId) {
        [pscustomobject]@{ pid = $service.Id; port = $Port; revision = $ready.revision; stdout = $stdoutFile; stderr = $stderrFile } | ConvertTo-Json -Compress
        exit 0
    }
    Start-Sleep -Milliseconds 200
}
throw "The new service did not pass its health check. See $stderrFile"
