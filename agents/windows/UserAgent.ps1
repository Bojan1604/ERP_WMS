#Requires -Version 5.1
<#
.SYNOPSIS
  Pomoćnik ERP/WMS MDM agenta u sesiji prijavljenog korisnika (zakazani zadatak pri prijavi).
.DESCRIPTION
  Agent radi kao SYSTEM i ne vidi korisnički zaslon. Za snimku zaslona, poruku i zaključavanje
  šalje zahtjeve kroz red u C:\ProgramData\ERPWMS\queue\requests; pomoćnik odgovara u
  queue\responses. Prikazuje i kod za upis dok uređaj čeka upis.
#>
[CmdletBinding()]
param([string]$DataDir)

$ErrorActionPreference = 'Stop'
if (-not $DataDir) { $DataDir = if ($env:ERPWMS_DATA) { $env:ERPWMS_DATA } else { Join-Path $env:ProgramData 'ERPWMS' } }
$requests = Join-Path $DataDir 'queue\requests'
$responses = Join-Path $DataDir 'queue\responses'
$me = ($env:USERNAME -replace '[^A-Za-z0-9_.-]', '_')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace ErpWms -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][ErpWms.Native]::SetProcessDPIAware()

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Shield
$tray.Text = 'ERP/WMS MDM'
$tray.Visible = $true

function Write-Response([string]$Id, [hashtable]$Body) {
    $json = ConvertTo-Json -InputObject $Body -Compress
    $tmp = Join-Path $responses "$Id.tmp"
    [System.IO.File]::WriteAllText($tmp, $json)
    Move-Item -Force $tmp (Join-Path $responses "$Id.json")
}

function Save-Screenshot([string]$Id) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
        $file = "$Id.png"
        $bmp.Save((Join-Path $responses $file), [System.Drawing.Imaging.ImageFormat]::Png)
        return $file
    }
    finally { $g.Dispose(); $bmp.Dispose() }
}

function Show-Message([string]$Text) {
    # poruka u zasebnom procesu da pomoćnik ne čeka korisnika; tekst ide kao base64 (bez ubacivanja koda)
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
    $script = "Add-Type -AssemblyName System.Windows.Forms; `$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')); " +
        "[System.Windows.Forms.MessageBox]::Show(`$t, 'Poruka administratora', 'OK', 'Information', 'Button1', 'ServiceNotification') | Out-Null"
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList "-NoProfile -WindowStyle Hidden -EncodedCommand $enc" -WindowStyle Hidden
}

$done = @{}
$lastCode = $null
while ($true) {
    try {
        if (Test-Path $responses) {
            [System.IO.File]::WriteAllText((Join-Path $responses "heartbeat-$me.txt"), (Get-Date).ToString('o'))
        }
        $statusFile = Join-Path $requests 'status.json'
        if (Test-Path $statusFile) {
            $st = Get-Content -Raw $statusFile | ConvertFrom-Json
            if ($st.status -eq 'PENDING' -and $st.enrollCode -and $st.enrollCode -ne $lastCode) {
                $tray.ShowBalloonTip(60000, 'ERP/WMS MDM — upis računala', "Kod za upis: $($st.enrollCode)`nUpišite ga u portalu (MDM → Upis uređaja).", 'Info')
                $tray.Text = "ERP/WMS MDM — kod $($st.enrollCode)"
            }
            elseif ($st.status -eq 'ENROLLED') { $tray.Text = "ERP/WMS MDM — $($st.deviceName)".Substring(0, [Math]::Min(63, "ERP/WMS MDM — $($st.deviceName)".Length)) }
            $lastCode = $st.enrollCode
        }
        foreach ($f in @(Get-ChildItem -Path $requests -Filter '*.json' -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'status.json' })) {
            $req = Get-Content -Raw $f.FullName | ConvertFrom-Json
            if (-not $req.id -or $done.ContainsKey($req.id)) { continue }
            $done[$req.id] = $true
            if (Test-Path (Join-Path $responses "$($req.id).json")) { continue }
            try {
                switch ($req.type) {
                    'SCREENSHOT' { Write-Response $req.id @{ ok = $true; file = (Save-Screenshot $req.id) } }
                    'LOCK' { & (Join-Path $env:SystemRoot 'System32\rundll32.exe') 'user32.dll,LockWorkStation'; Write-Response $req.id @{ ok = $true } }
                    'MESSAGE' { Show-Message ([string]$req.text); Write-Response $req.id @{ ok = $true } }
                    default { Write-Response $req.id @{ ok = $false; error = "Nepoznat zahtjev $($req.type)" } }
                }
            }
            catch { Write-Response $req.id @{ ok = $false; error = $_.Exception.Message } }
        }
    }
    catch { Write-Verbose "Pomoćnik: $_" }
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Seconds 2
}
