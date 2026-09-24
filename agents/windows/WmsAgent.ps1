#Requires -Version 5.1
<#
.SYNOPSIS
  ERP/WMS MDM agent za Windows — petlja javljanja (pokreće ga zakazani zadatak kao SYSTEM).
.PARAMETER DataDir
  Mapa s agent.json/state.json/zapisnicima (zadano C:\ProgramData\ERPWMS ili $env:ERPWMS_DATA).
.PARAMETER DryRun
  Ne mijenja sustav (restart, registar, instalacije, zadaci) — samo zapisuje što bi napravio. Za testove.
.PARAMETER Once
  Jedan ciklus pa izlaz (za testove i dijagnostiku).
#>
[CmdletBinding()]
param(
    [string]$DataDir,
    [switch]$DryRun,
    [switch]$Once,
    [int]$MaxCycles = 0
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WmsAgent.psm1') -Force
Initialize-MdmAgent -DataDir $DataDir -DryRun:$DryRun

# samo jedna instanca po računalu
$mutex = New-Object System.Threading.Mutex($false, 'Global\ERPWMS-MDM-Agent')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    Write-MdmLog 'Agent već radi — izlazim' 'info'
    exit 0
}

try {
    $cycles = 0
    while ($true) {
        $delay = Invoke-MdmCycle
        $cycles++
        if ($delay -lt 0) { Write-MdmLog 'Agent se zaustavlja' 'info'; break }
        if ($Once -or ($MaxCycles -gt 0 -and $cycles -ge $MaxCycles)) { break }
        Start-Sleep -Seconds $delay
    }
}
catch {
    Write-MdmLog "Neočekivana greška: $($_.Exception.Message)" 'error'
    exit 1  # zakazani zadatak ponovno pokreće agenta
}
finally {
    try { if ((Get-MdmState)['status']) { Save-MdmState } } catch { Write-Verbose "Spremanje stanja: $_" }
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit 0
