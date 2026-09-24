#Requires -Version 5.1
<#
  ERP/WMS MDM agent za Windows — modul s logikom agenta.
  Protokol: docs/mdm-agent-protocol.md (v1). Kompatibilno s Windows PowerShell 5.1.

  Čiste funkcije (bez utjecaja na sustav, pokrivene Pester testovima):
    ConvertFrom-MdmNetshWlan, ConvertTo-MdmAppList, ConvertTo-MdmTelemetry, Get-MdmConfigPlan,
    Test-MdmCommandPayload, Resolve-MdmDownloadUrl, Resolve-MdmTargetPath, Get-MdmBackoffSec,
    New-MdmWifiProfileXml, ConvertTo-MdmWindowsTimeZone, Limit-MdmText, ConvertTo-MdmHashtable
#>

Set-StrictMode -Off  # hashtable.Kljuc za nepostojeći ključ mora vratiti $null

$script:AgentVersion = '1.0.0'
$script:Protocol = 1
$script:Ctx = @{
    DataDir    = $null
    DryRun     = $false
    Events     = New-Object System.Collections.ArrayList
    Config     = $null   # agent.json
    State      = $null   # state.json
    Stop       = $false
    Response   = $null   # zadnji odgovor javljanja
    Applied    = $false
}

# ============================================================== čiste funkcije

function ConvertTo-MdmHashtable {
    <# PSCustomObject (iz ConvertFrom-Json) → hashtable, rekurzivno (PS 5.1 nema -AsHashtable). #>
    param($InputObject)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $h = @{}
        foreach ($k in $InputObject.Keys) { $h[[string]$k] = ConvertTo-MdmHashtable $InputObject[$k] }
        return $h
    }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $InputObject.PSObject.Properties) { $h[$p.Name] = ConvertTo-MdmHashtable $p.Value }
        return $h
    }
    if (($InputObject -is [System.Collections.IEnumerable]) -and -not ($InputObject -is [string])) {
        $list = @()
        foreach ($i in $InputObject) { $list += , (ConvertTo-MdmHashtable $i) }
        return , $list
    }
    return $InputObject
}

function Limit-MdmText {
    param([AllowNull()][string]$Text, [int]$Max = 32768)
    if ($null -eq $Text) { return $null }
    if ($Text.Length -le $Max) { return $Text }
    return $Text.Substring(0, $Max - 20) + "`n…[skraćeno]"
}

function ConvertFrom-MdmNetshWlan {
    <# Izlaz `netsh wlan show interfaces` → @{ Ssid; SignalPct; Rssi }. Otporno na lokalizaciju (traži SSID i postotak). #>
    param([AllowNull()][string[]]$Text)
    $r = @{ Ssid = $null; SignalPct = $null; Rssi = $null }
    if (-not $Text) { return $r }
    foreach ($line in $Text) {
        if ($null -eq $line) { continue }
        if (-not $r.Ssid -and $line -match '^\s*SSID\s*:\s*(.+?)\s*$') { $r.Ssid = $Matches[1] }
        elseif ($null -eq $r.SignalPct -and $line -match ':\s*(\d{1,3})\s*%\s*$') { $r.SignalPct = [int]$Matches[1] }
    }
    if ($null -ne $r.SignalPct) { $r.Rssi = [int]([math]::Round($r.SignalPct / 2) - 100) }
    if (-not $r.Ssid) { $r.SignalPct = $null; $r.Rssi = $null }
    return $r
}

function ConvertTo-MdmAppList {
    <# Stavke iz ...\Uninstall registra → [{ packageName, name, version }], bez komponenti sustava i zakrpa. #>
    param([object[]]$Entries, [int]$Max = 2000)
    $seen = @{}
    $out = New-Object System.Collections.ArrayList
    foreach ($e in @($Entries)) {
        if ($null -eq $e) { continue }
        $h = ConvertTo-MdmHashtable $e
        $name = [string]$h['DisplayName']
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if ($h['SystemComponent'] -eq 1) { continue }
        if (-not [string]::IsNullOrWhiteSpace([string]$h['ParentKeyName'])) { continue }
        if (@('Update', 'Hotfix', 'Security Update') -contains [string]$h['ReleaseType']) { continue }
        $key = [string]$h['PSChildName']
        $pkg = if ($key -match '^\{[0-9A-Fa-f\-]{36}\}$') { $key.ToUpperInvariant() } else { $name.Trim() }
        if ($seen.ContainsKey($pkg.ToLowerInvariant())) { continue }
        $seen[$pkg.ToLowerInvariant()] = $true
        $app = [ordered]@{ packageName = (Limit-MdmText $pkg 200); name = (Limit-MdmText $name.Trim() 200) }
        if ($h['DisplayVersion']) { $app.version = Limit-MdmText ([string]$h['DisplayVersion']).Trim() 100 }
        [void]$out.Add($app)
    }
    $sorted = @($out | Sort-Object { $_.packageName })
    if ($sorted.Count -gt $Max) { $sorted = $sorted[0..($Max - 1)] }
    return , $sorted
}

function ConvertTo-MdmTelemetry {
    <#
      Sirovi podaci (CIM objekti ili hashtable s istim svojstvima) → AgentTelemetry.
      Raw: ComputerSystem, Product, Bios, OS, Now, Batteries, SystemDisk, Adapters, Wifi, Apps, Cpu, AgentVersion
    #>
    param([Parameter(Mandatory)][hashtable]$Raw)
    $cs = ConvertTo-MdmHashtable $Raw.ComputerSystem
    $os = ConvertTo-MdmHashtable $Raw.OS
    $bios = ConvertTo-MdmHashtable $Raw.Bios
    $t = [ordered]@{}

    $serial = if ($bios) { [string]$bios['SerialNumber'] } else { '' }
    $serial = $serial.Trim()
    $bogus = @('', '0', 'None', 'Default string', 'To be filled by O.E.M.', 'System Serial Number', 'Not Specified', 'Not Applicable')
    $t.serial = if ($bogus -contains $serial) { $null } else { Limit-MdmText $serial 100 }
    $t.manufacturer = if ($cs) { Limit-MdmText ([string]$cs['Manufacturer']).Trim() 100 } else { $null }
    $t.model = if ($cs) { Limit-MdmText ([string]$cs['Model']).Trim() 100 } else { $null }
    $t.osVersion = if ($os) { Limit-MdmText ("{0} ({1})" -f ([string]$os['Caption']).Trim(), $os['Version']) 100 } else { $null }
    $t.agentVersion = if ($Raw.AgentVersion) { [string]$Raw.AgentVersion } else { $script:AgentVersion }
    $t.imei = $null

    # mreža: adapter s default gatewayem ima prednost
    $adapters = @($Raw.Adapters | Where-Object { $_ } | ForEach-Object { ConvertTo-MdmHashtable $_ } | Where-Object { $_['IPEnabled'] })
    $best = @($adapters | Where-Object { @($_['DefaultIPGateway'] | Where-Object { $_ }).Count -gt 0 }) + $adapters | Select-Object -First 1
    $t.ipAddress = $null
    $t.macAddress = $null
    if ($best) {
        $ip4 = @($best['IPAddress'] | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notlike '169.254.*' }) | Select-Object -First 1
        $t.ipAddress = $ip4
        if ($best['MACAddress']) { $t.macAddress = ([string]$best['MACAddress']).ToUpperInvariant() }
    }

    $wifi = $Raw.Wifi
    $t.wifiSsid = if ($wifi -and $wifi.Ssid) { Limit-MdmText $wifi.Ssid 64 } else { $null }
    $t.wifiSignal = if ($wifi -and $null -ne $wifi.Rssi) { [int][math]::Max(-150, [math]::Min(0, $wifi.Rssi)) } else { $null }

    $bat = @($Raw.Batteries | Where-Object { $_ } | ForEach-Object { ConvertTo-MdmHashtable $_ }) | Select-Object -First 1
    if ($bat) {
        $t.batteryLevel = [int][math]::Max(0, [math]::Min(100, [int]$bat['EstimatedChargeRemaining']))
        # BatteryStatus: 2 = na mreži, 3 = puna, 6–9 = punjenje
        $t.charging = @(2, 3, 6, 7, 8, 9) -contains [int]$bat['BatteryStatus']
    }
    else {
        $t.batteryLevel = $null
        $t.charging = $null
    }

    $disk = ConvertTo-MdmHashtable $Raw.SystemDisk
    if ($disk -and $disk['Size']) {
        $t.storageFreeMb = [long][math]::Floor([double]$disk['FreeSpace'] / 1MB)
        $t.storageTotalMb = [long][math]::Floor([double]$disk['Size'] / 1MB)
    }
    if ($cs -and $cs['TotalPhysicalMemory']) { $t.ramTotalMb = [long][math]::Floor([double]$cs['TotalPhysicalMemory'] / 1MB) }
    if ($os -and $os['LastBootUpTime']) {
        $now = if ($Raw.Now) { [datetime]$Raw.Now } else { Get-Date }
        $t.uptimeSec = [long][math]::Max(0, [math]::Floor(($now - [datetime]$os['LastBootUpTime']).TotalSeconds))
    }
    if ($null -ne $Raw.Apps) { $t.apps = @($Raw.Apps) }

    $extra = [ordered]@{}
    if ($cs) {
        $extra.computerName = $cs['Name']
        $extra.domain = $cs['Domain']
        $extra.user = $cs['UserName']
    }
    if ($os) { $extra.osBuild = $os['BuildNumber'] }
    if ($Raw.Cpu) { $extra.cpu = ([string]$Raw.Cpu).Trim() }
    $prod = ConvertTo-MdmHashtable $Raw.Product
    if ($prod) { $extra.hardwareUuid = $prod['UUID'] }
    $t.extra = $extra
    return $t
}

$script:TzMap = @{
    'Europe/Zagreb' = 'Central European Standard Time'; 'Europe/Belgrade' = 'Central European Standard Time'
    'Europe/Ljubljana' = 'Central European Standard Time'; 'Europe/Sarajevo' = 'Central European Standard Time'
    'Europe/Skopje' = 'Central European Standard Time'; 'Europe/Podgorica' = 'Central European Standard Time'
    'Europe/Warsaw' = 'Central European Standard Time'
    'Europe/Budapest' = 'Central Europe Standard Time'; 'Europe/Prague' = 'Central Europe Standard Time'
    'Europe/Bratislava' = 'Central Europe Standard Time'
    'Europe/Vienna' = 'W. Europe Standard Time'; 'Europe/Berlin' = 'W. Europe Standard Time'
    'Europe/Rome' = 'W. Europe Standard Time'; 'Europe/Zurich' = 'W. Europe Standard Time'
    'Europe/Amsterdam' = 'W. Europe Standard Time'
    'Europe/Paris' = 'Romance Standard Time'; 'Europe/Brussels' = 'Romance Standard Time'; 'Europe/Madrid' = 'Romance Standard Time'
    'Europe/London' = 'GMT Standard Time'; 'Europe/Dublin' = 'GMT Standard Time'; 'Europe/Lisbon' = 'GMT Standard Time'
    'Europe/Athens' = 'GTB Standard Time'; 'Europe/Bucharest' = 'GTB Standard Time'
    'Europe/Sofia' = 'FLE Standard Time'; 'Europe/Kiev' = 'FLE Standard Time'; 'Europe/Kyiv' = 'FLE Standard Time'
    'Europe/Istanbul' = 'Turkey Standard Time'; 'Europe/Moscow' = 'Russian Standard Time'
    'America/New_York' = 'Eastern Standard Time'; 'America/Chicago' = 'Central Standard Time'
    'America/Los_Angeles' = 'Pacific Standard Time'; 'UTC' = 'UTC'; 'Etc/UTC' = 'UTC'
}

function ConvertTo-MdmWindowsTimeZone {
    <# IANA (Europe/Zagreb) → Windows ID (Central European Standard Time). Windows ID se propušta. #>
    param([AllowNull()][string]$Zone)
    if ([string]::IsNullOrWhiteSpace($Zone)) { return $null }
    $z = $Zone.Trim()
    if ($script:TzMap.ContainsKey($z)) { return $script:TzMap[$z] }
    if ($z -match 'Standard Time$' -or $z -eq 'UTC') { return $z }
    return $null
}

function New-MdmWifiProfileXml {
    <# WLAN profil za `netsh wlan add profile`. #>
    param([Parameter(Mandatory)][string]$Ssid, [string]$Security = 'WPA2', [string]$Passphrase, [switch]$Hidden)
    $esc = [System.Security.SecurityElement]::Escape($Ssid)
    $hex = -join ([System.Text.Encoding]::UTF8.GetBytes($Ssid) | ForEach-Object { $_.ToString('X2') })
    switch ($Security) {
        'NONE' { $auth = 'open'; $enc = 'none' }
        'WPA3' { $auth = 'WPA3SAE'; $enc = 'AES' }
        default { $auth = 'WPA2PSK'; $enc = 'AES' }
    }
    $key = ''
    if ($auth -ne 'open') {
        $pw = [System.Security.SecurityElement]::Escape($Passphrase)
        $key = "<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>$pw</keyMaterial></sharedKey>"
    }
    $nb = if ($Hidden) { 'true' } else { 'false' }
    return @"
<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>$esc</name>
  <SSIDConfig><SSID><hex>$hex</hex><name>$esc</name></SSID><nonBroadcast>$nb</nonBroadcast></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM><security><authEncryption><authentication>$auth</authentication><encryption>$enc</encryption><useOneX>false</useOneX></authEncryption>$key</security></MSM>
</WLANProfile>
"@
}

function Test-MdmWifiNetwork {
    param($Network)
    $n = ConvertTo-MdmHashtable $Network
    if (-not $n -or [string]::IsNullOrWhiteSpace([string]$n['ssid']) -or ([string]$n['ssid']).Length -gt 32) { return $false }
    $sec = if ($n['security']) { [string]$n['security'] } else { 'WPA2' }
    if ($sec -eq 'NONE') { return $true }
    $pw = [string]$n['password']
    return ($pw.Length -ge 8 -and $pw.Length -le 63)
}

function Find-MdmInstalledApp {
    param([object[]]$Installed, [string]$PackageName, [string]$Name)
    foreach ($i in @($Installed)) {
        if ($null -eq $i) { continue }
        $h = ConvertTo-MdmHashtable $i
        if ($PackageName -and ([string]$h['packageName']) -ieq $PackageName) { return $h }
        if ($PackageName -and ([string]$h['name']) -ieq $PackageName) { return $h }
        if ($Name -and ([string]$h['name']) -ieq $Name) { return $h }
    }
    return $null
}

function Get-MdmConfigPlan {
    <#
      EffectiveConfig → popis radnji (redom). Radnje su hashtable s ključem Kind:
      Uninstall, Install, AppConfig, UsbStorage, NoControlPanel, Wifi, TimeZone, ScreenTimeout, StartApp, Warn.
    #>
    param([Parameter(Mandatory)]$Config, [object[]]$InstalledApps = @())
    $cfg = ConvertTo-MdmHashtable $Config
    $s = if ($cfg['settings']) { $cfg['settings'] } else { @{} }
    $r = if ($s['restrictions']) { $s['restrictions'] } else { @{} }
    $plan = New-Object System.Collections.ArrayList

    $apps = @($cfg['apps'] | Where-Object { $_ })
    foreach ($a in $apps) {
        if ($a['remove']) {
            if (Find-MdmInstalledApp $InstalledApps $a['packageName'] $a['name']) {
                [void]$plan.Add(@{ Kind = 'Uninstall'; PackageName = $a['packageName']; Name = $a['name'] })
            }
        }
    }
    foreach ($a in $apps) {
        if ($a['remove']) { continue }
        $have = Find-MdmInstalledApp $InstalledApps $a['packageName'] $a['name']
        $needs = (-not $have) -or ($a['version'] -and ([string]$have['version']) -ne ([string]$a['version']))
        if ($needs) {
            if (-not $a['downloadPath'] -or -not $a['sha256']) {
                [void]$plan.Add(@{ Kind = 'Warn'; Message = "Aplikacija $($a['packageName']): datoteka još nije učitana na poslužitelj — preskačem" })
            }
            else {
                [void]$plan.Add(@{ Kind = 'Install'; App = $a })
            }
        }
    }
    foreach ($a in $apps) {
        if (-not $a['remove'] -and $a['config'] -and $a['config'].Count -gt 0) {
            [void]$plan.Add(@{ Kind = 'AppConfig'; PackageName = $a['packageName']; Values = $a['config'] })
        }
    }

    [void]$plan.Add(@{ Kind = 'UsbStorage'; Disabled = [bool]$r['noUsbFileTransfer'] })
    [void]$plan.Add(@{ Kind = 'NoControlPanel'; Enabled = [bool]$r['noSettings'] })

    foreach ($w in @($s['wifi'] | Where-Object { $_ })) {
        if (Test-MdmWifiNetwork $w) { [void]$plan.Add(@{ Kind = 'Wifi'; Network = $w }) }
        else { [void]$plan.Add(@{ Kind = 'Warn'; Message = "Wi-Fi $($w['ssid']): neispravan SSID ili lozinka (8–63 znaka)" }) }
    }
    if ($s['timezone']) {
        $tz = ConvertTo-MdmWindowsTimeZone $s['timezone']
        if ($tz) { [void]$plan.Add(@{ Kind = 'TimeZone'; Id = $tz }) }
        else { [void]$plan.Add(@{ Kind = 'Warn'; Message = "Nepoznata vremenska zona: $($s['timezone'])" }) }
    }
    if ($s['screenTimeoutSec'] -and [int]$s['screenTimeoutSec'] -gt 0) {
        [void]$plan.Add(@{ Kind = 'ScreenTimeout'; Minutes = [int][math]::Max(1, [math]::Ceiling([int]$s['screenTimeoutSec'] / 60)) })
    }
    # Windows „kiosk" = pokretanje aplikacije pri prijavi (Run ključ); Assigned Access nije podržan.
    $start = $null
    if ($s['startApp']) {
        $start = [string]$s['startApp']
        $byId = $apps | Where-Object { $_['appId'] -eq $start } | Select-Object -First 1
        if ($byId) { $start = [string]$byId['packageName'] }
    }
    [void]$plan.Add(@{ Kind = 'StartApp'; Command = $start; Kiosk = [bool]$s['kiosk'] })
    return , @($plan)
}

function Test-MdmCommandPayload {
    <# Provjera tereta naredbe; vraća hashtable ili baca iznimku s razlogom. #>
    param([Parameter(Mandatory)][string]$Type, $Payload)
    $p = ConvertTo-MdmHashtable $Payload
    if ($null -eq $p) { $p = @{} }
    function need([string]$k) {
        $v = $p[$k]
        if ($null -eq $v -or [string]::IsNullOrWhiteSpace([string]$v)) { throw "Nedostaje '$k'" }
        return ([string]$v).Trim()
    }
    function sha {
        $v = need 'sha256'
        if ($v -notmatch '^[0-9a-fA-F]{64}$') { throw 'Neispravan sha256' }
        return $v.ToLowerInvariant()
    }
    switch ($Type) {
        'INSTALL_APP' {
            $o = @{ packageName = (need 'packageName'); downloadPath = (need 'downloadPath'); sha256 = (sha) }
            $o.version = $p['version']; $o.versionCode = $p['versionCode']; $o.name = $p['name']
            $o.installArgs = $p['installArgs']; $o.appId = $p['appId']
            return $o
        }
        'UNINSTALL_APP' { return @{ packageName = (need 'packageName') } }
        'PUSH_FILE' {
            $name = need 'name'
            if ($name -match '[\\/:*?"<>|]' -or $name -eq '..' -or $name -eq '.') { throw 'Neispravno ime datoteke' }
            return @{ name = $name; downloadPath = (need 'downloadPath'); sha256 = (sha); targetPath = $p['targetPath']; fileId = $p['fileId'] }
        }
        'MESSAGE' { return @{ text = (Limit-MdmText (need 'text') 2000) } }
        'RUN_SCRIPT' {
            $shell = if ($p['shell']) { ([string]$p['shell']).ToLowerInvariant() } else { 'powershell' }
            if (@('powershell', 'cmd') -notcontains $shell) { throw "Nepodržana ljuska: $shell" }
            return @{ script = (need 'script'); shell = $shell }
        }
        'SET_KIOSK' {
            if ($null -eq $p['enabled']) { throw "Nedostaje 'enabled'" }
            return @{ enabled = [bool]$p['enabled']; packageName = $p['packageName'] }
        }
        default { return $p }
    }
}

function Resolve-MdmDownloadUrl {
    <# downloadPath je relativan (§5.2); apsolutna adresa smije biti samo na istom poslužitelju. #>
    param([Parameter(Mandatory)][string]$Server, [Parameter(Mandatory)][string]$Path)
    $srv = $Server.TrimEnd('/')
    if ($Path -match '^https?://') {
        $a = [uri]$srv; $b = [uri]$Path
        if ($a.Scheme -ne $b.Scheme -or $a.Authority -ne $b.Authority) { throw 'Preuzimanje s drugog poslužitelja nije dopušteno' }
        return $Path
    }
    if (-not $Path.StartsWith('/') -or $Path.StartsWith('//')) { throw "Neispravna putanja za preuzimanje: $Path" }
    return $srv + $Path
}

function Resolve-MdmTargetPath {
    <#
      Odredište PUSH_FILE: apsolutna putanja (C:\…); ako završava s \ ili / to je mapa (dodaje se ime).
      Relativna → ispod zadane mape (C:\ProgramData\ERPWMS\files). '..' nije dopušten.
    #>
    param([AllowNull()][string]$TargetPath, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$DefaultDir)
    $t = if ($TargetPath) { $TargetPath.Trim() } else { '' }
    if ($t -split '[\\/]' | Where-Object { $_ -eq '..' }) { throw "Putanja ne smije sadržavati '..'" }
    $isDir = ($t -eq '') -or $t.EndsWith('\') -or $t.EndsWith('/')
    $abs = $t -match '^[A-Za-z]:[\\/]' -or $t.StartsWith('\\')
    $base = if ($abs) { $t } else { Join-Path $DefaultDir ($t -replace '/', '\') }
    $base = $base -replace '/', '\'
    if ($isDir) { return (Join-Path $base.TrimEnd('\') $Name) }
    return $base
}

function Get-MdmBackoffSec {
    <# §10: greške → min(checkinSec, 5 s × 2^n) × slučajno(0,5–1,5); bez grešaka → checkinSec ± 10 %. #>
    param([int]$CheckinSec = 60, [int]$Failures = 0, [double]$Random = -1)
    if ($Random -lt 0) { $Random = (Get-Random -Minimum 0.0 -Maximum 1.0) }
    if ($Failures -le 0) { return [int][math]::Max(1, [math]::Floor($CheckinSec * (0.9 + 0.2 * $Random))) }
    $exp = [math]::Min($Failures - 1, 12)
    $base = [math]::Min($CheckinSec, 5 * [math]::Pow(2, $exp))
    return [int][math]::Max(1, [math]::Floor($base * (0.5 + $Random)))
}

function Get-MdmCheckinSec {
    param($Value)
    $v = 0
    if ($null -ne $Value) { [void][int]::TryParse([string]$Value, [ref]$v) }
    if ($v -le 0) { return 60 }
    return [int][math]::Min(3600, [math]::Max(15, $v))
}

# ============================================================== staze, zapisnik, stanje

function Get-MdmPaths {
    $d = $script:Ctx.DataDir
    return @{
        Data      = $d
        Config    = Join-Path $d 'agent.json'
        State     = Join-Path $d 'state.json'
        Logs      = Join-Path $d 'logs'
        Log       = Join-Path (Join-Path $d 'logs') 'agent.log'
        Requests  = Join-Path (Join-Path $d 'queue') 'requests'
        Responses = Join-Path (Join-Path $d 'queue') 'responses'
        Files     = Join-Path $d 'files'
        Temp      = Join-Path $d 'tmp'
    }
}

function Write-MdmLog {
    param([string]$Message, [ValidateSet('info', 'warn', 'error')][string]$Level = 'info', [string]$Type = 'AGENT', [switch]$Report)
    $at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $line = "$at $($Level.ToUpperInvariant()) [$Type] $Message"
    Write-Verbose $line
    if ($Report -or $Level -ne 'info') {
        [void]$script:Ctx.Events.Add([ordered]@{ at = $at; level = $Level; type = $Type.ToUpperInvariant(); message = (Limit-MdmText $Message 1000) })
        while ($script:Ctx.Events.Count -gt 50) { $script:Ctx.Events.RemoveAt(0) }
    }
    if (-not $script:Ctx.DataDir) { return }
    try {
        $p = Get-MdmPaths
        if (-not (Test-Path $p.Logs)) { New-Item -ItemType Directory -Path $p.Logs -Force | Out-Null }
        if ((Test-Path $p.Log) -and (Get-Item $p.Log).Length -gt 1MB) {
            for ($i = 3; $i -ge 1; $i--) {
                $src = if ($i -eq 1) { $p.Log } else { "$($p.Log).$($i - 1)" }
                if (Test-Path $src) { Move-Item -Force $src "$($p.Log).$i" }
            }
        }
        Add-Content -Path $p.Log -Value $line -Encoding UTF8
    }
    catch { Write-Verbose "Zapisnik: $_" }
}

function Save-MdmJson {
    param([string]$Path, $Object)
    $json = ConvertTo-Json -InputObject $Object -Depth 12
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -Force $tmp $Path
}

function Read-MdmJson {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    $txt = [System.IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($txt)) { return $null }
    return ConvertTo-MdmHashtable (ConvertFrom-Json $txt)
}

function Protect-MdmSecret {
    param([string]$Plain)
    try {
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $b = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($Plain), $null, 'LocalMachine')
        return 'dpapi:' + [Convert]::ToBase64String($b)
    }
    catch { return 'plain:' + $Plain }
}

function Unprotect-MdmSecret {
    param([string]$Stored)
    if (-not $Stored) { return $null }
    if ($Stored.StartsWith('plain:')) { return $Stored.Substring(6) }
    if ($Stored.StartsWith('dpapi:')) {
        try {
            Add-Type -AssemblyName System.Security -ErrorAction Stop
            $b = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($Stored.Substring(6)), $null, 'LocalMachine')
            return [System.Text.Encoding]::UTF8.GetString($b)
        }
        catch { Write-MdmLog "Token se ne može dešifrirati: $_" 'error'; return $null }
    }
    return $Stored
}

function Initialize-MdmAgent {
    param([string]$DataDir, [switch]$DryRun)
    if (-not $DataDir) { $DataDir = if ($env:ERPWMS_DATA) { $env:ERPWMS_DATA } else { Join-Path $env:ProgramData 'ERPWMS' } }
    $script:Ctx.DataDir = $DataDir
    $script:Ctx.DryRun = [bool]$DryRun
    $script:Ctx.Stop = $false
    $p = Get-MdmPaths
    foreach ($d in @($p.Data, $p.Logs, $p.Temp)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
    }
    catch { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }
    try {
        $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
        [System.Net.WebRequest]::DefaultWebProxy = $proxy
    }
    catch { Write-Verbose "Proxy: $_" }
    $script:Ctx.Config = Read-MdmJson $p.Config
    if (-not $script:Ctx.Config) { $script:Ctx.Config = @{} }
    $script:Ctx.State = Read-MdmJson $p.State
    if (-not $script:Ctx.State) { $script:Ctx.State = @{} }
    foreach ($k in @('commands', 'managed')) { if (-not $script:Ctx.State[$k]) { $script:Ctx.State[$k] = @{} } }
    if (-not $script:Ctx.State['appliedConfigVersion']) { $script:Ctx.State['appliedConfigVersion'] = 0 }
    if (-not $script:Ctx.State['checkinSec']) { $script:Ctx.State['checkinSec'] = 60 }
    if (-not $script:Ctx.State['failures']) { $script:Ctx.State['failures'] = 0 }
    $script:Ctx.Events.Clear()
    foreach ($e in @($script:Ctx.State['pendingEvents'] | Where-Object { $_ })) { [void]$script:Ctx.Events.Add($e) }
    Write-MdmLog "Agent $script:AgentVersion pokrenut (podaci: $DataDir$(if ($DryRun) { ', DRY RUN' }))"
}

function Save-MdmState {
    # neposlani događaji preživljavaju ponovno pokretanje agenta (§10)
    $script:Ctx.State['pendingEvents'] = @($script:Ctx.Events.ToArray())
    Save-MdmJson (Get-MdmPaths).State $script:Ctx.State
}
function Save-MdmConfig { Save-MdmJson (Get-MdmPaths).Config $script:Ctx.Config }
function Get-MdmState { return $script:Ctx.State }
function Get-MdmToken { return (Unprotect-MdmSecret $script:Ctx.Config['token']) }

# ============================================================== HTTP

function New-MdmHttpError {
    param([int]$Status, [string]$Message, [string]$Code, $RetryAfter)
    $e = New-Object System.Exception $Message
    $e.Data['Status'] = $Status
    $e.Data['Code'] = $Code
    $e.Data['RetryAfter'] = $RetryAfter
    return $e
}

function Invoke-MdmHttp {
    <# HttpWebRequest (sistemski proxy, TLS 1.2); vraća @{Status; Body; Headers}. Za OutFile piše tijelo u datoteku. #>
    param(
        [string]$Method = 'GET', [Parameter(Mandatory)][string]$Url, [byte[]]$Body, [string]$ContentType,
        [hashtable]$Headers = @{}, [string]$OutFile, [long]$RangeFrom = -1, [int]$TimeoutSec = 30, [switch]$Auth
    )
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = $Method
    $req.Timeout = $TimeoutSec * 1000
    $req.ReadWriteTimeout = 60000
    $req.AllowAutoRedirect = $false
    $req.UserAgent = "ErpWmsMdmAgent/$script:AgentVersion Windows"
    $req.Accept = 'application/json'
    if ($Auth) {
        $tok = Get-MdmToken
        if (-not $tok) { throw (New-MdmHttpError 401 'Nema tokena uređaja' 'UNAUTHORIZED') }
        $req.Headers['Authorization'] = "Device $tok"
    }
    foreach ($k in $Headers.Keys) { $req.Headers[$k] = [string]$Headers[$k] }
    if ($RangeFrom -gt 0) { $req.AddRange([long]$RangeFrom) }
    if ($null -ne $Body) {
        if ($ContentType) { $req.ContentType = $ContentType }
        $req.ContentLength = $Body.Length
        $s = $req.GetRequestStream()
        try { $s.Write($Body, 0, $Body.Length) } finally { $s.Close() }
    }
    $resp = $null
    try { $resp = $req.GetResponse() }
    catch {
        $ex = $_.Exception
        while ($ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
        if ($ex -and $ex.Response) { $resp = $ex.Response } else { throw }
    }
    try {
        $status = [int]$resp.StatusCode
        $stream = $resp.GetResponseStream()
        if ($OutFile -and $status -ge 200 -and $status -lt 300) {
            $mode = if ($status -eq 206 -and $RangeFrom -gt 0) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
            $fs = New-Object System.IO.FileStream($OutFile, $mode, [System.IO.FileAccess]::Write)
            try { $stream.CopyTo($fs) } finally { $fs.Close() }
            $text = ''
        }
        else {
            $sr = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            $text = $sr.ReadToEnd()
            $sr.Close()
        }
        return @{ Status = $status; Body = $text; Headers = $resp.Headers }
    }
    finally { $resp.Close() }
}

function Invoke-MdmApi {
    <# JSON poziv na /api/mdm/agent/<Path>; greške kao iznimke s Data.Status/Code/RetryAfter. #>
    param([Parameter(Mandatory)][string]$Path, $Json, [switch]$NoAuth, [int]$TimeoutSec = 30)
    $server = ([string]$script:Ctx.Config['server']).TrimEnd('/')
    if (-not $server) { throw 'Poslužitelj nije postavljen (agent.json)' }
    $body = $null
    if ($null -ne $Json) { $body = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Json -Depth 12 -Compress)) }
    $r = Invoke-MdmHttp -Method 'POST' -Url "$server/api/mdm/agent$Path" -Body $body -ContentType 'application/json; charset=utf-8' -Auth:(-not $NoAuth) -TimeoutSec $TimeoutSec
    if ($r.Status -ge 200 -and $r.Status -lt 300) {
        if ([string]::IsNullOrWhiteSpace($r.Body)) { return @{} }
        return ConvertTo-MdmHashtable (ConvertFrom-Json $r.Body)
    }
    $msg = $r.Body; $code = $null
    try { $j = ConvertFrom-Json $r.Body; if ($j.error) { $msg = $j.error }; $code = $j.code } catch { Write-Verbose 'Tijelo greške nije JSON' }
    $ra = $null
    if ($r.Headers -and $r.Headers['Retry-After']) { $ra = [int]$r.Headers['Retry-After'] }
    throw (New-MdmHttpError $r.Status "HTTP $($r.Status): $msg" $code $ra)
}

function Get-MdmFileHash256 {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Invoke-MdmDownload {
    <# Preuzimanje s nastavkom (Range + If-Range) i provjerom SHA-256. #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination, [Parameter(Mandatory)][string]$Sha256)
    $url = Resolve-MdmDownloadUrl -Server $script:Ctx.Config['server'] -Path $Path
    $part = "$Destination.part"
    $want = $Sha256.ToLowerInvariant()
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $have = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
        $r = Invoke-MdmHttp -Url $url -OutFile $part -RangeFrom $have -Headers $(if ($have -gt 0) { @{ 'If-Range' = "`"$want`"" } } else { @{} }) -Auth -TimeoutSec 60
        if ($r.Status -eq 416) { Remove-Item -Force $part -ErrorAction SilentlyContinue; continue }
        if ($r.Status -eq 410) { throw (New-MdmHttpError 410 'Uređaj je uklonjen' 'RETIRED') }
        if ($r.Status -eq 401) { throw (New-MdmHttpError 401 'Token ne vrijedi' 'UNAUTHORIZED') }
        if ($r.Status -lt 200 -or $r.Status -ge 300) { throw "Preuzimanje nije uspjelo: HTTP $($r.Status)" }
        $srvSha = if ($r.Headers) { $r.Headers['X-Content-SHA256'] } else { $null }
        if ($srvSha -and $srvSha.ToLowerInvariant() -ne $want) { Remove-Item -Force $part -ErrorAction SilentlyContinue; throw 'Poslužitelj javlja drugačiji SHA-256 od očekivanog' }
        $got = Get-MdmFileHash256 $part
        if ($got -ne $want) {
            Remove-Item -Force $part -ErrorAction SilentlyContinue
            if ($attempt -eq 1 -and $have -gt 0) { continue }
            throw "SHA-256 se ne podudara (očekivano $want, dobiveno $got)"
        }
        if (Test-Path $Destination) { Remove-Item -Force $Destination }
        Move-Item $part $Destination
        return $Destination
    }
    throw 'Preuzimanje nije uspjelo'
}

function Send-MdmUpload {
    param([Parameter(Mandatory)][string]$Kind, [string]$CommandId, [Parameter(Mandatory)][string]$File, [string]$ContentType = 'application/octet-stream')
    $server = ([string]$script:Ctx.Config['server']).TrimEnd('/')
    $q = "kind=$Kind"
    if ($CommandId) { $q += '&commandId=' + [uri]::EscapeDataString($CommandId) }
    $bytes = [System.IO.File]::ReadAllBytes($File)
    $name = [System.IO.Path]::GetFileName($File)
    $r = Invoke-MdmHttp -Method 'POST' -Url "$server/api/mdm/agent/upload?$q" -Body $bytes -ContentType $ContentType -Headers @{ 'X-File-Name' = $name } -Auth -TimeoutSec 300
    if ($r.Status -lt 200 -or $r.Status -ge 300) { throw "Slanje datoteke nije uspjelo: HTTP $($r.Status) $($r.Body)" }
    return ConvertTo-MdmHashtable (ConvertFrom-Json $r.Body)
}

# ============================================================== prikupljanje telemetrije (IO)

function Get-MdmUninstallEntries {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $out = @()
    foreach ($k in $keys) {
        $out += @(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue |
            Select-Object PSChildName, PSPath, DisplayName, DisplayVersion, Publisher, SystemComponent, ParentKeyName, ReleaseType, WindowsInstaller, UninstallString, QuietUninstallString)
    }
    return $out
}

function ConvertFrom-MdmCim {
    <# CimInstance → hashtable svojstava (da čiste funkcije rade s hashtablicama). #>
    param($InputObject)
    if ($null -eq $InputObject) { return $null }
    $h = @{}
    foreach ($prop in $InputObject.CimInstanceProperties) { $h[$prop.Name] = $prop.Value }
    return $h
}

function Get-MdmRawInventory {
    $raw = @{ Now = Get-Date; AgentVersion = $script:AgentVersion }
    $q = {
        param($c, $f)
        $a = @{ ClassName = $c; ErrorAction = 'Stop' }
        if ($f) { $a.Filter = $f }
        try { @(Get-CimInstance @a) | ForEach-Object { ConvertFrom-MdmCim $_ } } catch { $null }
    }
    $raw.ComputerSystem = & $q 'Win32_ComputerSystem' $null
    $raw.Product = & $q 'Win32_ComputerSystemProduct' $null
    $raw.Bios = & $q 'Win32_BIOS' $null
    $raw.OS = & $q 'Win32_OperatingSystem' $null
    $raw.Batteries = @(& $q 'Win32_Battery' $null)
    $raw.SystemDisk = & $q 'Win32_LogicalDisk' "DeviceID='$($env:SystemDrive)'"
    $raw.Adapters = @(& $q 'Win32_NetworkAdapterConfiguration' 'IPEnabled=True')
    $cpu = & $q 'Win32_Processor' $null
    if ($cpu) { $raw.Cpu = @($cpu)[0]['Name'] }
    $raw.Wifi = @{ Ssid = $null; Rssi = $null }
    try {
        $netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
        if (Test-Path $netsh) { $raw.Wifi = ConvertFrom-MdmNetshWlan (& $netsh wlan show interfaces 2>$null) }
    }
    catch { Write-Verbose "netsh: $_" }
    return $raw
}

$script:LastAppsHash = $null
$script:LastAppsAt = [datetime]::MinValue

function Get-MdmTelemetry {
    param([switch]$ForceApps)
    $raw = Get-MdmRawInventory
    $apps = ConvertTo-MdmAppList (Get-MdmUninstallEntries)
    $hash = (($apps | ForEach-Object { "$($_.packageName)=$($_.version)" }) -join ';').GetHashCode()
    $send = $ForceApps -or $hash -ne $script:LastAppsHash -or ((Get-Date) - $script:LastAppsAt).TotalMinutes -gt 60
    if ($send) { $raw.Apps = $apps; $script:LastAppsHash = $hash; $script:LastAppsAt = Get-Date }
    return ConvertTo-MdmTelemetry -Raw $raw
}

function Get-MdmHardwareId {
    try {
        $u = (Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
        if ($u -and $u -ne 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF' -and $u -ne '00000000-0000-0000-0000-000000000000') { return $u }
    }
    catch { Write-Verbose "UUID: $_" }
    try { return (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -ErrorAction Stop).MachineGuid } catch { return $env:COMPUTERNAME }
}

# ============================================================== korisnička sesija (red u ProgramData)

function Test-MdmUserHelper {
    $p = Get-MdmPaths
    if (-not (Test-Path $p.Responses)) { return $false }
    $hb = Get-ChildItem -Path $p.Responses -Filter 'heartbeat-*.txt' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -gt (Get-Date).ToUniversalTime().AddSeconds(-60) }
    return [bool]$hb
}

function Invoke-MdmUserRequest {
    <# Šalje zahtjev pomoćniku u korisničkoj sesiji (SCREENSHOT/MESSAGE/LOCK) i čeka odgovor. #>
    param([Parameter(Mandatory)][string]$Type, [hashtable]$Data = @{}, [int]$TimeoutSec = 60)
    $p = Get-MdmPaths
    foreach ($d in @($p.Requests, $p.Responses)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
    $id = [guid]::NewGuid().ToString('N')
    $req = @{ id = $id; type = $Type; createdAt = (Get-Date).ToUniversalTime().ToString('o') }
    foreach ($k in $Data.Keys) { $req[$k] = $Data[$k] }
    Save-MdmJson (Join-Path $p.Requests "$id.json") $req
    $respPath = Join-Path $p.Responses "$id.json"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    try {
        while ((Get-Date) -lt $deadline) {
            if (Test-Path $respPath) {
                Start-Sleep -Milliseconds 300
                $r = Read-MdmJson $respPath
                $r['dir'] = $p.Responses
                return $r
            }
            Start-Sleep -Milliseconds 500
        }
        return @{ ok = $false; error = 'Pomoćnik u korisničkoj sesiji nije odgovorio (nema prijavljenog korisnika?)' }
    }
    finally {
        Remove-Item -Force (Join-Path $p.Requests "$id.json") -ErrorAction SilentlyContinue
        Remove-Item -Force $respPath -ErrorAction SilentlyContinue
    }
}

function Publish-MdmStatus {
    <# Stanje za pomoćnika (prikaz koda za upis u obavijesti). #>
    $p = Get-MdmPaths
    if (-not (Test-Path $p.Requests)) { return }
    $s = $script:Ctx.State
    try { Save-MdmJson (Join-Path $p.Requests 'status.json') @{ status = $s['status']; enrollCode = $s['enrollCode']; deviceName = $s['deviceName'] } }
    catch { Write-Verbose "status.json: $_" }
}

# ============================================================== primjena konfiguracije (IO)

function Invoke-MdmSystem {
    <# Izvršava radnju nad sustavom osim u DryRun načinu (tada samo zapisuje). #>
    param([string]$What, [scriptblock]$Action)
    if ($script:Ctx.DryRun) { Write-MdmLog "DRYRUN: $What" 'info' 'DRYRUN'; return $null }
    return & $Action
}

function Install-MdmPackage {
    param([Parameter(Mandatory)][hashtable]$App)
    $p = Get-MdmPaths
    $ext = '.bin'
    $dl = Join-Path $p.Temp ("pkg-" + [guid]::NewGuid().ToString('N') + $ext)
    Invoke-MdmDownload -Path $App['downloadPath'] -Destination $dl -Sha256 $App['sha256'] | Out-Null
    try {
        $head = New-Object byte[] 8
        $fs = [System.IO.File]::OpenRead($dl); [void]$fs.Read($head, 0, 8); $fs.Close()
        $isMsi = ($head[0] -eq 0xD0 -and $head[1] -eq 0xCF -and $head[2] -eq 0x11 -and $head[3] -eq 0xE0)
        $target = if ($isMsi) { [System.IO.Path]::ChangeExtension($dl, '.msi') } else { [System.IO.Path]::ChangeExtension($dl, '.exe') }
        Move-Item -Force $dl $target
        $dl = $target
        $extraArgs = [string]$App['installArgs']
        if ($isMsi) {
            $argList = "/i `"$dl`" /qn /norestart $extraArgs".Trim()
            $exe = Join-Path $env:SystemRoot 'System32\msiexec.exe'
        }
        else {
            $argList = $extraArgs
            $exe = $dl
        }
        $code = Invoke-MdmSystem "instalacija $($App['packageName']): $exe $argList" {
            $pr = if ($argList) { Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden } else { Start-Process -FilePath $exe -Wait -PassThru -WindowStyle Hidden }
            $pr.ExitCode
        }
        if ($null -ne $code -and @(0, 3010, 1641) -notcontains [int]$code) { throw "Instalacija $($App['packageName']) nije uspjela (izlazni kod $code)" }
        Write-MdmLog "Instalirano: $($App['packageName']) $($App['version'])" 'info' 'INSTALL' -Report
    }
    finally { Remove-Item -Force $dl -ErrorAction SilentlyContinue }
}

function Uninstall-MdmPackage {
    <# Tiho uklanjanje po ProductCode ili nazivu; vraća $false ako aplikacija nije instalirana. #>
    param([Parameter(Mandatory)][string]$PackageName)
    $entry = Get-MdmUninstallEntries | Where-Object {
        $_.DisplayName -and ($_.PSChildName -ieq $PackageName -or $_.DisplayName -ieq $PackageName)
    } | Select-Object -First 1
    if (-not $entry) { return $false }
    $msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
    if ($entry.PSChildName -match '^\{[0-9A-Fa-f\-]{36}\}$' -and ($entry.WindowsInstaller -eq 1 -or [string]$entry.UninstallString -match 'msiexec')) {
        $exe = $msiexec; $argList = "/x $($entry.PSChildName) /qn /norestart"
    }
    else {
        $cmd = if ($entry.QuietUninstallString) { [string]$entry.QuietUninstallString } else { [string]$entry.UninstallString + ' /S' }
        if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') { $exe = $Matches[1]; $argList = $Matches[2] }
        elseif ($cmd -match '^\s*(\S+\.exe)\s*(.*)$') { $exe = $Matches[1]; $argList = $Matches[2] }
        else { throw "Ne mogu protumačiti naredbu za uklanjanje: $cmd" }
    }
    $code = Invoke-MdmSystem "uklanjanje $PackageName`: $exe $argList" {
        $pr = if ($argList) { Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden } else { Start-Process -FilePath $exe -Wait -PassThru -WindowStyle Hidden }
        $pr.ExitCode
    }
    if ($null -ne $code -and @(0, 3010, 1605, 1641) -notcontains [int]$code) { throw "Uklanjanje $PackageName nije uspjelo (izlazni kod $code)" }
    Write-MdmLog "Uklonjeno: $PackageName" 'info' 'INSTALL' -Report
    return $true
}

function Set-MdmRegistryValue {
    param([string]$Path, [string]$Name, $Value, [string]$Type = 'String')
    Invoke-MdmSystem "registar $Path\$Name = $Value" {
        if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
        New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
    } | Out-Null
}

function Remove-MdmRegistryValue {
    param([string]$Path, [string]$Name)
    Invoke-MdmSystem "registar: brisanje $Path\$Name" {
        if (Test-Path $Path) { Remove-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue }
    } | Out-Null
}

$script:RunKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$script:ExplorerPolicy = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer'
$script:UsbStor = 'HKLM:\SYSTEM\CurrentControlSet\Services\USBSTOR'

function Set-MdmStartApp {
    param([AllowNull()][string]$Command)
    if ($Command) { Set-MdmRegistryValue $script:RunKey 'ErpWmsStartApp' $Command }
    else { Remove-MdmRegistryValue $script:RunKey 'ErpWmsStartApp' }
    $script:Ctx.State['managed']['startApp'] = $Command
}

function Invoke-MdmConfigAction {
    param([Parameter(Mandatory)][hashtable]$Action)
    switch ($Action.Kind) {
        'Warn' { Write-MdmLog $Action.Message 'warn' 'CONFIG' }
        'Uninstall' { [void](Uninstall-MdmPackage $Action.PackageName) }
        'Install' { Install-MdmPackage $Action.App }
        'AppConfig' {
            $path = "HKLM:\SOFTWARE\WmsMdm\Apps\$($Action.PackageName)"
            foreach ($k in $Action.Values.Keys) { Set-MdmRegistryValue $path $k ([string]$Action.Values[$k]) }
        }
        'UsbStorage' {
            # 4 = onemogućeno, 3 = ručno (zadano)
            $v = if ($Action.Disabled) { 4 } else { 3 }
            if ($Action.Disabled -or $script:Ctx.State['managed']['usb']) {
                Set-MdmRegistryValue $script:UsbStor 'Start' $v 'DWord'
                $script:Ctx.State['managed']['usb'] = [bool]$Action.Disabled
            }
        }
        'NoControlPanel' {
            if ($Action.Enabled) { Set-MdmRegistryValue $script:ExplorerPolicy 'NoControlPanel' 1 'DWord'; $script:Ctx.State['managed']['noControlPanel'] = $true }
            elseif ($script:Ctx.State['managed']['noControlPanel']) { Remove-MdmRegistryValue $script:ExplorerPolicy 'NoControlPanel'; $script:Ctx.State['managed']['noControlPanel'] = $false }
        }
        'Wifi' {
            $n = $Action.Network
            $sec = if ($n['security']) { [string]$n['security'] } else { 'WPA2' }
            $xml = New-MdmWifiProfileXml -Ssid $n['ssid'] -Security $sec -Passphrase ([string]$n['password']) -Hidden:([bool]$n['hidden'])
            $file = Join-Path (Get-MdmPaths).Temp ("wifi-" + [guid]::NewGuid().ToString('N') + '.xml')
            [System.IO.File]::WriteAllText($file, $xml, (New-Object System.Text.UTF8Encoding($false)))
            try {
                $out = Invoke-MdmSystem "netsh wlan add profile ($($n['ssid']))" {
                    $o = & (Join-Path $env:SystemRoot 'System32\netsh.exe') wlan add profile "filename=$file" user=all 2>&1
                    if ($LASTEXITCODE -ne 0) { throw "netsh: $o" }
                    $o
                }
                Write-Verbose "$out"
            }
            finally { Remove-Item -Force $file -ErrorAction SilentlyContinue }
        }
        'TimeZone' { Invoke-MdmSystem "Set-TimeZone $($Action.Id)" { Set-TimeZone -Id $Action.Id } | Out-Null }
        'ScreenTimeout' {
            Invoke-MdmSystem "powercfg monitor-timeout $($Action.Minutes) min" {
                & powercfg.exe /change monitor-timeout-ac $Action.Minutes | Out-Null
                & powercfg.exe /change monitor-timeout-dc $Action.Minutes | Out-Null
            } | Out-Null
        }
        'StartApp' { Set-MdmStartApp $Action.Command }
        default { Write-MdmLog "Nepoznata radnja: $($Action.Kind)" 'warn' 'CONFIG' }
    }
}

function Invoke-MdmApplyConfig {
    <# Primjena konfiguracije (§6). Verzija se bilježi samo ako su svi koraci uspjeli. #>
    param([Parameter(Mandatory)]$Config)
    $cfg = ConvertTo-MdmHashtable $Config
    Write-MdmLog "Primjenjujem konfiguraciju v$($cfg['version'])" 'info' 'CONFIG'
    $installed = ConvertTo-MdmAppList (Get-MdmUninstallEntries)
    $plan = Get-MdmConfigPlan -Config $cfg -InstalledApps $installed
    $errors = @()
    foreach ($a in $plan) {
        try { Invoke-MdmConfigAction $a }
        catch { $errors += "$($a.Kind): $($_.Exception.Message)" }
    }
    $script:Ctx.State['lastConfig'] = $cfg
    if ($errors.Count -eq 0) {
        $script:Ctx.State['appliedConfigVersion'] = [int]$cfg['version']
        Write-MdmLog "Konfiguracija v$($cfg['version']) primijenjena ($($plan.Count) koraka)" 'info' 'CONFIG' -Report
    }
    else {
        Write-MdmLog ("Konfiguracija v$($cfg['version']) nije potpuno primijenjena: " + ($errors -join '; ')) 'error' 'CONFIG'
    }
    Save-MdmState
    return ($errors.Count -eq 0)
}

function Remove-MdmPolicies {
    <# Vraća postavke koje je agent mijenjao (FORGET, 410, deinstalacija). #>
    $m = $script:Ctx.State['managed']
    if (-not $m) { return }
    if ($m['usb']) { Set-MdmRegistryValue $script:UsbStor 'Start' 3 'DWord' }
    if ($m['noControlPanel']) { Remove-MdmRegistryValue $script:ExplorerPolicy 'NoControlPanel' }
    if ($m['startApp']) { Remove-MdmRegistryValue $script:RunKey 'ErpWmsStartApp' }
    $script:Ctx.State['managed'] = @{}
}

# ============================================================== naredbe

function New-MdmOutcome {
    param([bool]$Ok, [string]$ErrorText, $Result = @{}, [scriptblock]$After)
    return @{ ok = $Ok; error = $ErrorText; result = $Result; after = $After }
}

function Invoke-MdmScript {
    <# RUN_SCRIPT: izvršava kao SYSTEM s vremenskim ograničenjem, hvata izlaz (najviše 32 KiB po toku). #>
    param([Parameter(Mandatory)][string]$Script, [string]$Shell = 'powershell', [int]$TimeoutSec = 600)
    $p = Get-MdmPaths
    $id = [guid]::NewGuid().ToString('N')
    $out = Join-Path $p.Temp "$id.out"; $err = Join-Path $p.Temp "$id.err"
    if ($Shell -eq 'cmd') {
        $file = Join-Path $p.Temp "$id.cmd"
        [System.IO.File]::WriteAllText($file, $Script, [System.Text.Encoding]::Default)
        $exe = Join-Path $env:SystemRoot 'System32\cmd.exe'; $argList = "/c `"$file`""
    }
    else {
        $file = Join-Path $p.Temp "$id.ps1"
        [System.IO.File]::WriteAllText($file, $Script, (New-Object System.Text.UTF8Encoding($true)))
        $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'; $argList = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$file`""
    }
    try {
        $pr = Start-Process -FilePath $exe -ArgumentList $argList -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
        $null = $pr.Handle  # bez ovoga je ExitCode prazan (poznata osobina Start-Process -PassThru)
        $done = $pr.WaitForExit($TimeoutSec * 1000)
        if (-not $done) {
            try { & taskkill.exe /PID $pr.Id /T /F | Out-Null } catch { $pr.Kill() }
            throw "Skripta je prekinuta nakon $TimeoutSec s"
        }
        $pr.WaitForExit()
        $so = if (Test-Path $out) { [System.IO.File]::ReadAllText($out) } else { '' }
        $se = if (Test-Path $err) { [System.IO.File]::ReadAllText($err) } else { '' }
        return @{ exitCode = $pr.ExitCode; stdout = (Limit-MdmText $so 32768); stderr = (Limit-MdmText $se 32768) }
    }
    finally { Remove-Item -Force $file, $out, $err -ErrorAction SilentlyContinue }
}

function New-MdmLogBundle {
    <# Zapisnici agenta + nedavni događaji System/Application (greške i upozorenja) → zip. #>
    $p = Get-MdmPaths
    $dir = Join-Path $p.Temp ("logs-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Get-ChildItem -Path $p.Logs -Filter 'agent.log*' -ErrorAction SilentlyContinue | Copy-Item -Destination $dir
    $info = @(
        "ERP/WMS MDM agent $script:AgentVersion",
        "Računalo: $env:COMPUTERNAME",
        "Vrijeme: $((Get-Date).ToString('o'))",
        "Stanje: $($script:Ctx.State['status']), konfiguracija v$($script:Ctx.State['appliedConfigVersion'])"
    )
    [System.IO.File]::WriteAllLines((Join-Path $dir 'info.txt'), $info)
    foreach ($log in @('System', 'Application')) {
        try {
            $ev = Get-WinEvent -FilterHashtable @{ LogName = $log; Level = 1, 2, 3; StartTime = (Get-Date).AddDays(-2) } -MaxEvents 500 -ErrorAction Stop |
                Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message | Format-List | Out-String -Width 300
        }
        catch { $ev = "Nema događaja ili nedostupno: $($_.Exception.Message)" }
        [System.IO.File]::WriteAllText((Join-Path $dir "eventlog-$log.txt"), $ev, (New-Object System.Text.UTF8Encoding($false)))
    }
    $zip = Join-Path $p.Temp ("logs-$env:COMPUTERNAME-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
    Compress-Archive -Path (Join-Path $dir '*') -DestinationPath $zip -Force
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    return $zip
}

function Invoke-MdmForgetCleanup {
    param([string]$FinalStatus = 'FORGOTTEN')
    Write-MdmLog "Odjava uređaja ($FinalStatus) — uklanjam postavke agenta" 'warn' 'FORGET'
    Remove-MdmPolicies
    $script:Ctx.Config.Remove('token')
    $script:Ctx.Config.Remove('enrollToken')
    Save-MdmConfig
    $script:Ctx.State = @{ status = $FinalStatus; commands = @{}; managed = @{}; appliedConfigVersion = 0 }
    Save-MdmState
    Publish-MdmStatus
    Invoke-MdmSystem 'uklanjanje zakazanih zadataka agenta' {
        foreach ($t in @('ERPWMS Agent', 'ERPWMS Agent (korisnik)')) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
    } | Out-Null
    $script:Ctx.Stop = $true
}

function Invoke-MdmCommand {
    <# Izvršava jednu naredbu; vraća @{ok; error; result; after}. [after] se izvodi tek nakon slanja rezultata. #>
    param([Parameter(Mandatory)][hashtable]$Command)
    $type = [string]$Command['type']
    $payload = $Command['payload']
    if ($payload -and $payload['error']) { return (New-MdmOutcome $false ([string]$payload['error'])) }
    $p = Test-MdmCommandPayload -Type $type -Payload $payload
    switch ($type) {
        'REBOOT' {
            return (New-MdmOutcome $true $null @{} {
                    Invoke-MdmSystem 'ponovno pokretanje za 60 s' {
                        & shutdown.exe /r /t 60 /c "Administrator je zatražio ponovno pokretanje računala (ERP/WMS MDM)." | Out-Null
                    } | Out-Null
                })
        }
        'LOCK' {
            if ($script:Ctx.DryRun) { Write-MdmLog 'DRYRUN: zaključavanje zaslona' 'info' 'DRYRUN'; return (New-MdmOutcome $true $null @{}) }
            $r = Invoke-MdmUserRequest 'LOCK' @{} 20
            if ($r['ok']) { return (New-MdmOutcome $true $null @{}) }
            return (New-MdmOutcome $false ([string]$r['error']))
        }
        'MESSAGE' {
            if ($script:Ctx.DryRun) { Write-MdmLog "DRYRUN: poruka '$($p.text)'" 'info' 'DRYRUN'; return (New-MdmOutcome $true $null @{}) }
            if (Test-MdmUserHelper) {
                $r = Invoke-MdmUserRequest 'MESSAGE' @{ text = $p.text } 20
                if ($r['ok']) { return (New-MdmOutcome $true $null @{}) }
            }
            $msg = Join-Path $env:SystemRoot 'System32\msg.exe'
            if (Test-Path $msg) {
                & $msg '*' '/TIME:86400' $p.text 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) { return (New-MdmOutcome $true $null @{ via = 'msg.exe' }) }
            }
            return (New-MdmOutcome $false 'Poruku nije moguće prikazati (nema prijavljenog korisnika ni msg.exe)')
        }
        'INSTALL_APP' {
            $have = Find-MdmInstalledApp (ConvertTo-MdmAppList (Get-MdmUninstallEntries)) $p.packageName $p.name
            if ($have -and $p.version -and ([string]$have['version']) -eq ([string]$p.version)) {
                return (New-MdmOutcome $true $null @{ packageName = $p.packageName; version = $p.version; versionCode = $p.versionCode; skipped = $true })
            }
            Install-MdmPackage $p
            return (New-MdmOutcome $true $null @{ packageName = $p.packageName; version = $p.version; versionCode = $p.versionCode })
        }
        'UNINSTALL_APP' {
            if (-not (Uninstall-MdmPackage $p.packageName)) { return (New-MdmOutcome $true $null @{ packageName = $p.packageName; notInstalled = $true }) }
            return (New-MdmOutcome $true $null @{ packageName = $p.packageName })
        }
        'PUSH_FILE' {
            $dest = Resolve-MdmTargetPath -TargetPath $p.targetPath -Name $p.name -DefaultDir (Get-MdmPaths).Files
            $tmp = Join-Path (Get-MdmPaths).Temp ("push-" + [guid]::NewGuid().ToString('N'))
            Invoke-MdmDownload -Path $p.downloadPath -Destination $tmp -Sha256 $p.sha256 | Out-Null
            $dir = Split-Path -Parent $dest
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            Move-Item -Force $tmp $dest
            Write-MdmLog "Datoteka spremljena: $dest" 'info' 'FILE' -Report
            return (New-MdmOutcome $true $null @{ path = $dest })
        }
        'UPLOAD_LOGS' {
            $zip = New-MdmLogBundle
            try { $u = Send-MdmUpload -Kind 'LOGS' -CommandId $Command['id'] -File $zip -ContentType 'application/zip' }
            finally { Remove-Item -Force $zip -ErrorAction SilentlyContinue }
            return (New-MdmOutcome $true $null @{ fileId = $u['fileId'] })
        }
        'SCREENSHOT' {
            $r = Invoke-MdmUserRequest 'SCREENSHOT' @{} 60
            if (-not $r['ok']) { return (New-MdmOutcome $false ([string]$r['error'])) }
            # mapa odgovora je korisnicima zapisiva — prihvaća se samo očekivano ime datoteke
            $fileName = [string]$r['file']
            if ($fileName -notmatch '^[0-9a-f]{32}\.png$') { return (New-MdmOutcome $false 'Neispravan odgovor pomoćnika') }
            $png = Join-Path $r['dir'] $fileName
            try { $u = Send-MdmUpload -Kind 'SCREENSHOT' -CommandId $Command['id'] -File $png -ContentType 'image/png' }
            finally { Remove-Item -Force $png -ErrorAction SilentlyContinue }
            return (New-MdmOutcome $true $null @{ fileId = $u['fileId'] })
        }
        'RUN_SCRIPT' {
            $res = Invoke-MdmScript -Script $p.script -Shell $p.shell
            return (New-MdmOutcome ($res.exitCode -eq 0) $(if ($res.exitCode -ne 0) { "Izlazni kod $($res.exitCode)" } else { $null }) $res)
        }
        'SET_KIOSK' {
            $cmd = $p.packageName
            if (-not $cmd -and $script:Ctx.State['lastConfig']) { $cmd = $script:Ctx.State['lastConfig']['settings']['startApp'] }
            if ($p.enabled) {
                if (-not $cmd) { return (New-MdmOutcome $false 'Nije zadana aplikacija (packageName ni startApp)') }
                Set-MdmStartApp $cmd
            }
            else { Set-MdmStartApp $null }
            Save-MdmState
            return (New-MdmOutcome $true $null @{ enabled = $p.enabled })
        }
        'APPLY_CONFIG' {
            $cfg = $null
            if ($script:Ctx.Response -and $script:Ctx.Response['config']) { $cfg = $script:Ctx.Response['config'] }
            elseif ($script:Ctx.State['lastConfig']) { $cfg = $script:Ctx.State['lastConfig'] }
            if (-not $cfg) { return (New-MdmOutcome $false 'Nema konfiguracije za primjenu') }
            $ok = $true
            if (-not $script:Ctx.Applied) { $ok = Invoke-MdmApplyConfig $cfg; $script:Ctx.Applied = $true }
            elseif ([int]$script:Ctx.State['appliedConfigVersion'] -ne [int]$cfg['version']) { $ok = $false }
            if (-not $ok) { return (New-MdmOutcome $false "Konfiguracija v$($cfg['version']) nije potpuno primijenjena") }
            return (New-MdmOutcome $true $null @{ configVersion = [int]$cfg['version'] })
        }
        'FORGET' { return (New-MdmOutcome $true $null @{} { Invoke-MdmForgetCleanup 'FORGOTTEN' }) }
        'WIPE' { return (New-MdmOutcome $false 'UNSUPPORTED: WIPE nije podržan na Windowsu') }
        default { return (New-MdmOutcome $false "UNSUPPORTED: $type") }
    }
}

# ============================================================== ciklus agenta

function Register-MdmDevice {
    $cs = $null
    try { $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop } catch { Write-Verbose "CIM: $_" }
    $os = $null
    try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch { Write-Verbose "CIM: $_" }
    $serial = $null
    try { $serial = (Get-CimInstance Win32_BIOS -ErrorAction Stop).SerialNumber } catch { Write-Verbose "CIM: $_" }
    $body = [ordered]@{
        protocol     = $script:Protocol
        platform     = 'WINDOWS'
        enrollToken  = $(if ($script:Ctx.Config['enrollToken']) { [string]$script:Ctx.Config['enrollToken'] } else { $null })
        hardwareId   = (Get-MdmHardwareId)
        serial       = $(if ($serial) { ([string]$serial).Trim() } else { $null })
        manufacturer = $(if ($cs) { $cs.Manufacturer } else { $null })
        model        = $(if ($cs) { $cs.Model } else { $null })
        osVersion    = $(if ($os) { "$($os.Caption) ($($os.Version))" } else { $null })
        agentVersion = $script:AgentVersion
        name         = $env:COMPUTERNAME
    }
    try { $r = Invoke-MdmApi -Path '/register' -Json $body -NoAuth }
    catch {
        if ($_.Exception.Data['Status'] -eq 403 -and $body.enrollToken) {
            Write-MdmLog "Ključ upisa ne vrijedi ($($_.Exception.Message)) — prijava bez ključa, upis kodom" 'error' 'ENROLL'
            $script:Ctx.Config.Remove('enrollToken'); Save-MdmConfig
            $body.enrollToken = $null
            $r = Invoke-MdmApi -Path '/register' -Json $body -NoAuth
        }
        else { throw }
    }
    $script:Ctx.Config['token'] = Protect-MdmSecret ([string]$r['token'])
    $script:Ctx.Config['deviceId'] = $r['deviceId']
    Save-MdmConfig
    $script:Ctx.State['status'] = $r['status']
    $script:Ctx.State['enrollCode'] = $r['enrollCode']
    $script:Ctx.State['checkinSec'] = Get-MdmCheckinSec $r['checkinSec']
    $script:Ctx.State['appliedConfigVersion'] = 0
    Save-MdmState
    if ($r['status'] -eq 'PENDING') {
        Write-MdmLog "KOD ZA UPIS: $($r['enrollCode']) — upišite ga u portalu (MDM → Upis uređaja)" 'info' 'ENROLL' -Report
    }
    else { Write-MdmLog "Prijavljen i upisan ($($r['status']))" 'info' 'ENROLL' -Report }
    Publish-MdmStatus
}

function Send-MdmCommandResult {
    param([hashtable]$Command, [hashtable]$Body)
    try {
        [void](Invoke-MdmApi -Path ('/commands/' + [uri]::EscapeDataString([string]$Command['id'])) -Json $Body)
        return $true
    }
    catch {
        $st = $_.Exception.Data['Status']
        if (($st -eq 410 -or $st -eq 401) -and @('FORGET', 'WIPE') -contains $Command['type']) { return $true }
        if ($st -eq 409 -or $st -eq 404) { Write-MdmLog "Naredba $($Command['id']) zatvorena na poslužitelju ($st) — odbacujem" 'warn' 'COMMAND'; return $false }
        throw
    }
}

function Invoke-MdmCommandQueue {
    param([object[]]$Commands)
    foreach ($c in @($Commands | Where-Object { $_ })) {
        $id = [string]$c['id']
        $store = $script:Ctx.State['commands']
        if ($store.ContainsKey($id) -and $store[$id]['r']) {
            Write-MdmLog "Naredba $id već izvršena — ponovno šaljem rezultat" 'info' 'COMMAND'
            [void](Send-MdmCommandResult $c $store[$id]['r'])
            continue
        }
        Write-MdmLog "Naredba $($c['type']) ($id)" 'info' 'COMMAND'
        try { $o = Invoke-MdmCommand -Command $c }
        catch {
            if ($_.Exception.Data['Status'] -eq 410) { throw }
            $o = New-MdmOutcome $false $_.Exception.Message
        }
        $res = if ($o.result) { $o.result } else { @{} }
        $body = [ordered]@{ ok = [bool]$o.ok; error = $(if ($o.error) { Limit-MdmText ([string]$o.error) 2000 } else { $null }); result = $res }
        $store[$id] = @{ r = $body; t = (Get-Date).ToUniversalTime().ToString('o') }
        if ($store.Count -gt 500) {
            $old = $store.GetEnumerator() | Sort-Object { $_.Value['t'] } | Select-Object -First ($store.Count - 500)
            foreach ($e in @($old)) { $store.Remove($e.Key) }
        }
        Save-MdmState
        if (-not $o.ok) { Write-MdmLog "$($c['type']) nije uspjela: $($o.error)" 'warn' 'COMMAND' }
        $sent = Send-MdmCommandResult $c $body
        if ($sent -and $o.after) {
            try { & $o.after | Out-Null } catch { Write-MdmLog "$($c['type']): $($_.Exception.Message)" 'error' 'COMMAND' }
        }
        if ($script:Ctx.Stop) { break }
    }
}

function Invoke-MdmCycle {
    <# Jedan ciklus; vraća sekunde do sljedećeg (−1 = stani). #>
    $s = $script:Ctx.State
    if (@('RETIRED', 'FORGOTTEN') -contains $s['status']) { return -1 }
    if (-not $script:Ctx.Config['server']) { Write-MdmLog 'Poslužitelj nije postavljen (agent.json)' 'error'; return 300 }
    try {
        if (-not (Get-MdmToken)) { Register-MdmDevice | Out-Null }
        $events = @($script:Ctx.Events.ToArray())
        $script:Ctx.Events.Clear()
        $body = [ordered]@{ appliedConfigVersion = [int]$s['appliedConfigVersion']; telemetry = (Get-MdmTelemetry) }
        if ($events.Count -gt 0) { $body.events = $events }
        try { $r = Invoke-MdmApi -Path '/checkin' -Json $body }
        catch {
            foreach ($e in $events) { $script:Ctx.Events.Insert(0, $e) }
            throw
        }
        $script:Ctx.Response = $r
        $script:Ctx.Applied = $false
        $prev = $s['status']
        $s['status'] = $r['status']
        $s['enrollCode'] = $r['enrollCode']
        $s['deviceName'] = $r['deviceName']
        $s['checkinSec'] = Get-MdmCheckinSec $r['checkinSec']
        $s['lastCheckinAt'] = (Get-Date).ToUniversalTime().ToString('o')
        $s['failures'] = 0
        if ($prev -ne $r['status'] -and $r['status'] -eq 'ENROLLED') { Write-MdmLog "Uređaj je upisan: $($r['deviceName'])" 'info' 'ENROLL' -Report }
        if ($r['status'] -eq 'PENDING') { Write-MdmLog "Čeka upis — kod $($r['enrollCode'])" 'info' 'ENROLL' }
        Save-MdmState
        Publish-MdmStatus

        $busy = $false
        $cmds = @($r['commands'] | Where-Object { $_ })
        $cfg = $r['config']
        $forced = @($cmds | Where-Object { $_['type'] -eq 'APPLY_CONFIG' }).Count -gt 0
        if ($cfg -and ([int]$cfg['version'] -ne [int]$s['appliedConfigVersion'] -or $forced)) {
            $busy = Invoke-MdmApplyConfig $cfg
            $script:Ctx.Applied = $true
        }
        if ($cmds.Count -gt 0) {
            Invoke-MdmCommandQueue $cmds | Out-Null
            $busy = $true
        }
        if ($script:Ctx.Stop) { return -1 }
        if ($busy) { return 2 }
        return (Get-MdmBackoffSec -CheckinSec $s['checkinSec'] -Failures 0)
    }
    catch {
        $st = $_.Exception.Data['Status']
        if ($st -eq 410) {
            Write-MdmLog 'Poslužitelj javlja da je uređaj uklonjen (410)' 'warn'
            Invoke-MdmForgetCleanup 'RETIRED'
            return -1
        }
        $s['failures'] = [int]$s['failures'] + 1
        if ($st -eq 401) {
            Write-MdmLog 'Token ne vrijedi (401) — ponovna prijava' 'warn'
            $script:Ctx.Config.Remove('token'); Save-MdmConfig
            Save-MdmState
            return [math]::Max(60, (Get-MdmBackoffSec -CheckinSec $s['checkinSec'] -Failures $s['failures']))
        }
        Write-MdmLog "Javljanje nije uspjelo (#$($s['failures'])): $($_.Exception.Message)" 'warn'
        Save-MdmState
        $ra = $_.Exception.Data['RetryAfter']
        if ($ra) { return [int]$ra }
        return (Get-MdmBackoffSec -CheckinSec $s['checkinSec'] -Failures $s['failures'])
    }
}

Export-ModuleMember -Function *-Mdm*
