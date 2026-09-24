#Requires -Version 5.1
<#
.SYNOPSIS
  Uklanjanje ERP/WMS MDM agenta (kao administrator). Vraća postavke koje je agent mijenjao.
.PARAMETER KeepData
  Ne briši C:\ProgramData\ERPWMS (zapisnike i postavke).
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'ERPWMS\Agent'),
    [string]$DataDir = (Join-Path $env:ProgramData 'ERPWMS'),
    [switch]$KeepData
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Potrebna su administratorska prava.' }

foreach ($t in @('ERPWMS Agent', 'ERPWMS Agent (korisnik)')) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Output "[ERPWMS] Uklonjen zadatak $t"
    }
}

# vrati postavke agenta (USB, upravljačka ploča, automatsko pokretanje)
$module = Join-Path $InstallDir 'WmsAgent.psm1'
if (-not (Test-Path $module)) { $module = Join-Path $PSScriptRoot 'WmsAgent.psm1' }
if ((Test-Path $module) -and (Test-Path $DataDir)) {
    try {
        Import-Module $module -Force
        Initialize-MdmAgent -DataDir $DataDir
        Remove-MdmPolicies
        Save-MdmState
    }
    catch { Write-Warning "Vraćanje postavki: $($_.Exception.Message)" }
}

Get-Process -Name powershell -ErrorAction SilentlyContinue | Where-Object {
    if ($_.Id -eq $PID) { return $false }
    try { $_.Path -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'ERPWMS\\Agent' } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue

if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir; Write-Output "[ERPWMS] Uklonjena mapa $InstallDir" }
if (-not $KeepData -and (Test-Path $DataDir)) { Remove-Item -Recurse -Force $DataDir; Write-Output "[ERPWMS] Uklonjena mapa $DataDir" }
Write-Output '[ERPWMS] Agent je uklonjen. Uređaj u portalu označite kao uklonjen (ili pošaljite FORGET prije deinstalacije).'
