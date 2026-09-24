#Requires -Version 5.1
<#
.SYNOPSIS
  Instalacija ERP/WMS MDM agenta za Windows (pokrenuti kao administrator).
.DESCRIPTION
  Jedan redak s portala (PowerShell kao administrator):
    irm "https://erp.example.hr/api/mdm/agent/download/windows-install?token=XXXX" | iex
  ili rucno iz raspakiranog wms-agent.zip:
    .\install.ps1 -Server https://erp.example.hr -Token XXXX

  Kopira agenta u C:\Program Files\ERPWMS\Agent, postavke u C:\ProgramData\ERPWMS\agent.json
  (pristup samo SYSTEM i Administratori), registrira zakazani zadatak "ERPWMS Agent" (SYSTEM,
  pri pokretanju, ponovno pokretanje pri gresci) i "ERPWMS Agent (korisnik)" (pri prijavi korisnika:
  snimka zaslona, poruke, zakljucavanje, obavijest s kodom za upis).
.PARAMETER Server
  Adresa posluzitelja (https://...). Posluzitelj je sam upisuje kad se skripta preuzme s portala.
.PARAMETER Token
  Kljuc upisa (neobavezno). Bez njega agent prikazuje sesteroznamenkasti kod za upis.
.PARAMETER SourceDir
  Mapa s datotekama agenta; zadano mapa ove skripte, inace se agent preuzima s posluzitelja.
.PARAMETER NoStart
  Ne pokreci agenta odmah (za testove).
#>
[CmdletBinding()]
param(
    [string]$Server = '__MDM_SERVER_URL__',
    [string]$Token = '__MDM_ENROLL_TOKEN__',
    [string]$SourceDir,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'ERPWMS\Agent'),
    [string]$DataDir = (Join-Path $env:ProgramData 'ERPWMS'),
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
# Zamjenske vrijednosti koje posluzitelj nije zamijenio (skripta pokrenuta izravno iz zip-a)
if ($Server.StartsWith('__MDM_')) { $Server = '' }
if ($Token.StartsWith('__MDM_')) { $Token = '' }

function Write-Step([string]$Text) { Write-Output "[ERPWMS] $Text" }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Instalacija trazi administratorska prava (PowerShell -> Pokreni kao administrator).'
}
if ([string]::IsNullOrWhiteSpace($Server)) { throw 'Navedite adresu posluzitelja: .\install.ps1 -Server https://erp.example.hr [-Token ...]' }
$Server = $Server.Trim().TrimEnd('/')
$uri = [uri]$Server
$local = $uri.Host -eq 'localhost' -or $uri.Host -eq '127.0.0.1' -or $uri.Host -like '10.*' -or $uri.Host -like '192.168.*'
if ($uri.Scheme -ne 'https' -and -not $local) { throw 'Posluzitelj mora koristiti HTTPS (http samo za lokalne adrese).' }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
$proxy = [System.Net.WebRequest]::GetSystemWebProxy()
$proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
[System.Net.WebRequest]::DefaultWebProxy = $proxy

# ---------------------------------------------------------------- izvor datoteka
$files = @('WmsAgent.ps1', 'WmsAgent.psm1', 'UserAgent.ps1', 'uninstall.ps1')
if (-not $SourceDir -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'WmsAgent.psm1'))) { $SourceDir = $PSScriptRoot }
$tempDir = $null
if (-not $SourceDir) {
    Write-Step "Preuzimam agenta s $Server ..."
    $tempDir = Join-Path $env:TEMP ('erpwms-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    $zip = Join-Path $tempDir 'wms-agent.zip'
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/mdm/agent/download/windows" -OutFile $zip -PassThru
    $expected = $resp.Headers['X-Content-SHA256']
    if ($expected) {
        $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
        if ($got -ne ([string]$expected).ToLowerInvariant()) { throw "SHA-256 preuzetog agenta se ne podudara ($got)" }
    }
    Expand-Archive -Path $zip -DestinationPath $tempDir -Force
    $SourceDir = $tempDir
}
foreach ($f in $files) { if (-not (Test-Path (Join-Path $SourceDir $f))) { throw "Nedostaje $f u $SourceDir" } }

# ---------------------------------------------------------------- zaustavi postojeceg agenta
$taskAgent = 'ERPWMS Agent'
$taskUser = 'ERPWMS Agent (korisnik)'
foreach ($t in @($taskAgent, $taskUser)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
    }
}

# ---------------------------------------------------------------- datoteke programa
Write-Step "Kopiram agenta u $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($f in $files) { Copy-Item -Force (Join-Path $SourceDir $f) (Join-Path $InstallDir $f) }
if ($PSCommandPath) { Copy-Item -Force $PSCommandPath (Join-Path $InstallDir 'install.ps1') }
elseif (Test-Path (Join-Path $SourceDir 'install.ps1')) { Copy-Item -Force (Join-Path $SourceDir 'install.ps1') (Join-Path $InstallDir 'install.ps1') }
& icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null

# ---------------------------------------------------------------- podaci i ACL (SYSTEM + Administratori)
Write-Step "Postavke u $DataDir"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
& icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
foreach ($d in @('logs', 'tmp', 'files', 'queue')) { New-Item -ItemType Directory -Force -Path (Join-Path $DataDir $d) | Out-Null }
$req = Join-Path $DataDir 'queue\requests'
$res = Join-Path $DataDir 'queue\responses'
New-Item -ItemType Directory -Force -Path $req, $res | Out-Null
# korisnici: citanje zahtjeva (queue, requests), pisanje odgovora (responses)
& icacls.exe (Join-Path $DataDir 'queue') /grant '*S-1-5-32-545:(RX)' | Out-Null
& icacls.exe $req /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
& icacls.exe $res /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null

$cfgPath = Join-Path $DataDir 'agent.json'
$cfg = @{}
if (Test-Path $cfgPath) {
    $old = Get-Content -Raw $cfgPath | ConvertFrom-Json
    foreach ($p in $old.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
}
if ($cfg['server'] -and ($cfg['server'] -ne $Server)) {
    # drugi posluzitelj -> nova prijava
    $cfg.Remove('token'); $cfg.Remove('deviceId')
    Remove-Item -Force (Join-Path $DataDir 'state.json') -ErrorAction SilentlyContinue
}
$cfg['server'] = $Server
if ($Token) { $cfg['enrollToken'] = $Token }
$statePath = Join-Path $DataDir 'state.json'
if (Test-Path $statePath) {
    $st = Get-Content -Raw $statePath | ConvertFrom-Json
    if ($st.status -eq 'FORGOTTEN' -or $st.status -eq 'RETIRED') { Remove-Item -Force $statePath }
}
[System.IO.File]::WriteAllText($cfgPath, (ConvertTo-Json -InputObject $cfg), (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- zakazani zadaci
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'WmsAgent.ps1')`""
$startup = New-ScheduledTaskTrigger -AtStartup
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$system = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskAgent -Action $action -Trigger @($startup, $watchdog) -Principal $system -Settings $settings `
    -Description 'ERP/WMS MDM agent (javljanje posluzitelju, konfiguracija, naredbe).' | Out-Null

$uaction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'UserAgent.ps1')`""
$logon = New-ScheduledTaskTrigger -AtLogOn
$users = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$usettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskUser -Action $uaction -Trigger $logon -Principal $users -Settings $usettings `
    -Description 'ERP/WMS MDM pomocnik u sesiji korisnika (snimka zaslona, poruke, zakljucavanje).' | Out-Null

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $taskAgent
    Start-ScheduledTask -TaskName $taskUser -ErrorAction SilentlyContinue
}
if ($tempDir) { Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue }

Write-Step 'Agent je instaliran.'
if (-not $Token) {
    Write-Step "Kod za upis prikazat ce se u obavijesti i u $(Join-Path $DataDir 'logs\agent.log') (redak 'KOD ZA UPIS')."
}
