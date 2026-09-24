#Requires -Version 5.1
<#
  Dimni test agenta protiv lažnog poslužitelja (tests/mock-server.js):
  prijava → PENDING s kodom → upis → konfiguracija + naredbe (REBOOT u DryRun, RUN_SCRIPT, PUSH_FILE,
  UPLOAD_LOGS, nepoznata naredba) → rezultati → FORGET → agent staje.
  Pokretanje: powershell -File tests\Smoke.ps1 [-Port 18080]
#>
[CmdletBinding()]
param([int]$Port = 18080)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:TEMP ("erpwms-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $data | Out-Null
$base = "http://127.0.0.1:$Port"
$failures = 0

function Assert-That([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Output "  OK  $Message" }
    else { Write-Output "  NEUSPJEH  $Message"; $script:failures++ }
}
function Invoke-Control([string]$Path, $Body = @{}) {
    Invoke-RestMethod -Method Post -Uri "$base/_control/$Path" -Body (ConvertTo-Json -InputObject $Body -Depth 10) -ContentType 'application/json'
}
function Get-MockState { Invoke-RestMethod -Uri "$base/_control/state" }
function Invoke-Agent([string]$Label) {
    Write-Output "--- agent: $Label"
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'WmsAgent.ps1') -DataDir $data -DryRun -Once -Verbose 4>&1 | ForEach-Object { "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "Agent je završio s kodom $LASTEXITCODE" }
}
function Get-AgentState { Get-Content -Raw (Join-Path $data 'state.json') | ConvertFrom-Json }
function Get-AgentLog { Get-Content -Raw (Join-Path $data 'logs\agent.log') }
function Get-Result($State, [string]$Type) { @($State.results | Where-Object { $_.type -eq $Type }) | Select-Object -Last 1 }

$node = (Get-Command node -ErrorAction Stop).Source
$srv = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $PSScriptRoot 'mock-server.js')`" $Port" -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $data 'mock.out') -RedirectStandardError (Join-Path $data 'mock.err')
try {
    $ready = $false
    for ($i = 0; $i -lt 50 -and -not $ready; $i++) {
        try { Get-MockState | Out-Null; $ready = $true } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $ready) { throw 'Lažni poslužitelj se nije pokrenuo' }

    [System.IO.File]::WriteAllText((Join-Path $data 'agent.json'), (ConvertTo-Json @{ server = $base }))

    # 1) prijava → PENDING, kod za upis
    Invoke-Agent 'prijava'
    $st = Get-MockState
    $dev = $st.devices[0]
    Assert-That (@($st.devices).Count -eq 1) 'uređaj je prijavljen'
    Assert-That ($dev.platform -eq 'WINDOWS') 'platforma WINDOWS'
    Assert-That ($dev.status -eq 'PENDING') 'status PENDING'
    Assert-That ($dev.enrollCode -match '^\d{6}$') "kod za upis $($dev.enrollCode)"
    $as = Get-AgentState
    Assert-That ($as.status -eq 'PENDING' -and $as.enrollCode -eq $dev.enrollCode) 'agent pamti PENDING i kod'
    Assert-That ((Get-AgentLog) -match "KOD ZA UPIS: $($dev.enrollCode)") 'kod je u zapisniku'
    Assert-That ($dev.checkins -eq 1) 'javljanje nakon prijave'
    Assert-That ($null -ne $dev.telemetry.osVersion -and $null -ne $dev.telemetry.storageTotalMb) "telemetrija: $($dev.telemetry.osVersion), $($dev.telemetry.storageTotalMb) MB"
    Assert-That (@($dev.telemetry.apps).Count -gt 0) "popis aplikacija ($(@($dev.telemetry.apps).Count))"
    $cfgJson = Get-Content -Raw (Join-Path $data 'agent.json') | ConvertFrom-Json
    Assert-That ($cfgJson.token -match '^(dpapi|plain):') 'token je spremljen (DPAPI)'

    # 2) upis + konfiguracija + naredbe
    Invoke-Control 'enroll' @{ name = 'Blagajna 1' } | Out-Null
    Invoke-Control 'config' @{ settings = @{ timezone = 'Europe/Zagreb'; restrictions = @{ noUsbFileTransfer = $true } }; apps = @() } | Out-Null
    $content = 'Cjenik ' + (Get-Date).ToString('o')
    $f = Invoke-Control 'file' @{ name = 'cjenik.txt'; contentBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content)) }
    $outDir = Join-Path $data 'out\'
    Invoke-Control 'command' @{ type = 'PUSH_FILE'; payload = @{ fileId = $f.fileId; name = 'cjenik.txt'; downloadPath = $f.downloadPath; sha256 = $f.sha256; targetPath = $outDir } } | Out-Null
    Invoke-Control 'command' @{ type = 'REBOOT'; payload = @{} } | Out-Null
    Invoke-Control 'command' @{ type = 'RUN_SCRIPT'; payload = @{ script = 'Write-Output "pozdrav s agenta"; exit 0'; shell = 'powershell' } } | Out-Null
    Invoke-Control 'command' @{ type = 'UPLOAD_LOGS'; payload = @{} } | Out-Null
    Invoke-Control 'command' @{ type = 'NEPOSTOJECA'; payload = @{} } | Out-Null
    Invoke-Agent 'upisan: konfiguracija i naredbe'
    $st = Get-MockState
    $dev = $st.devices[0]
    Assert-That ($dev.status -eq 'ENROLLED') 'status ENROLLED'
    $as = Get-AgentState
    Assert-That ($as.status -eq 'ENROLLED' -and $as.deviceName -eq 'Blagajna 1') 'agent zna da je upisan (naziv uređaja)'
    Assert-That ([int]$as.appliedConfigVersion -eq 2) "konfiguracija v2 primijenjena (agent: v$($as.appliedConfigVersion))"
    $r = Get-Result $st 'REBOOT'
    Assert-That ($r -and $r.body.ok) 'REBOOT: rezultat ok'
    Assert-That ((Get-AgentLog) -match 'DRYRUN: ponovno pokretanje') 'REBOOT u DryRun načinu nije ponovno pokrenuo računalo'
    Assert-That ((Get-AgentLog) -match 'DRYRUN: Set-TimeZone Central European Standard Time') 'vremenska zona (DryRun)'
    $r = Get-Result $st 'RUN_SCRIPT'
    Assert-That ($r -and $r.body.ok -and $r.body.result.stdout -match 'pozdrav s agenta' -and $r.body.result.exitCode -eq 0) 'RUN_SCRIPT: izlaz i kod'
    $r = Get-Result $st 'PUSH_FILE'
    $pushed = Join-Path $outDir 'cjenik.txt'
    Assert-That ($r -and $r.body.ok -and $r.body.result.path -eq $pushed) "PUSH_FILE: $($r.body.result.path)"
    Assert-That ((Test-Path $pushed) -and ([System.IO.File]::ReadAllText($pushed) -eq $content)) 'PUSH_FILE: sadržaj provjeren (sha256)'
    $r = Get-Result $st 'UPLOAD_LOGS'
    Assert-That ($r -and $r.body.ok -and $r.body.result.fileId) 'UPLOAD_LOGS: fileId'
    Assert-That (@($st.uploads | Where-Object { $_.kind -eq 'LOGS' -and $_.size -gt 0 }).Count -eq 1) 'UPLOAD_LOGS: zip je primljen'
    $r = Get-Result $st 'NEPOSTOJECA'
    Assert-That ($r -and -not $r.body.ok -and $r.body.error -like 'UNSUPPORTED:*') 'nepoznata naredba → UNSUPPORTED'

    # 3) sljedeće javljanje javlja primijenjenu verziju i događaje
    Invoke-Agent 'javljanje primijenjene verzije'
    $dev = (Get-MockState).devices[0]
    Assert-That ($dev.applied -eq 2) 'poslužitelj vidi appliedConfigVersion 2'
    Assert-That (@($dev.events | Where-Object { $_.type -eq 'CONFIG' }).Count -gt 0) 'događaji agenta stižu poslužitelju'

    # 4) FORGET
    Invoke-Control 'command' @{ type = 'FORGET'; payload = @{} } | Out-Null
    Invoke-Agent 'FORGET'
    $st = Get-MockState
    $dev = $st.devices[0]
    $r = Get-Result $st 'FORGET'
    Assert-That ($r -and $r.body.ok) 'FORGET: rezultat ok'
    Assert-That ($dev.status -eq 'RETIRED') 'poslužitelj: RETIRED'
    $as = Get-AgentState
    Assert-That ($as.status -eq 'FORGOTTEN') 'agent: FORGOTTEN'
    $cfgJson = Get-Content -Raw (Join-Path $data 'agent.json') | ConvertFrom-Json
    Assert-That (-not ($cfgJson.PSObject.Properties.Name -contains 'token')) 'token je obrisan'
    $before = $dev.checkins
    Invoke-Agent 'nakon FORGET'
    Assert-That ((Get-MockState).devices[0].checkins -eq $before) 'agent se nakon FORGET više ne javlja'
}
finally {
    if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
    if ($failures -gt 0) {
        Write-Output '--- zapisnik agenta'
        Get-Content (Join-Path $data 'logs\agent.log') -ErrorAction SilentlyContinue | ForEach-Object { "    $_" }
        Get-Content (Join-Path $data 'mock.err') -ErrorAction SilentlyContinue | ForEach-Object { "    mock: $_" }
    }
}
if ($failures -gt 0) { throw "Dimni test: $failures provjera nije prošlo" }
Write-Output 'Dimni test uspješan.'
