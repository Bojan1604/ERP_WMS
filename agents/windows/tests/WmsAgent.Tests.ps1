#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }
# Pester 5 testovi čistih funkcija agenta (bez utjecaja na sustav).

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\WmsAgent.psm1') -Force
}

Describe 'ConvertFrom-MdmNetshWlan' {
    It 'čita SSID i signal (engleski izlaz)' {
        $text = @(
            'There is 1 interface on the system:',
            '    Name                   : Wi-Fi',
            '    State                  : connected',
            '    SSID                   : Lokal-5G',
            '    BSSID                  : aa:bb:cc:dd:ee:ff',
            '    Signal                 : 86%'
        )
        $r = ConvertFrom-MdmNetshWlan $text
        $r.Ssid | Should -Be 'Lokal-5G'
        $r.SignalPct | Should -Be 86
        $r.Rssi | Should -Be -57
    }
    It 'bez Wi-Fi sučelja vraća prazno' {
        $r = ConvertFrom-MdmNetshWlan @('There is no wireless interface on the system.')
        $r.Ssid | Should -BeNullOrEmpty
        $r.Rssi | Should -BeNullOrEmpty
    }
    It 'podnosi lokalizirane oznake' {
        $r = ConvertFrom-MdmNetshWlan @('    SSID                   : Trgovina', '    Jačina signala         : 40 %')
        $r.Ssid | Should -Be 'Trgovina'
        $r.Rssi | Should -Be -80
    }
}

Describe 'ConvertTo-MdmAppList' {
    It 'filtrira sistemske komponente i zakrpe, koristi ProductCode' {
        $entries = @(
            [pscustomobject]@{ PSChildName = '{12345678-1234-1234-1234-1234567890AB}'; DisplayName = 'POS Blagajna'; DisplayVersion = '2.4.1'; SystemComponent = $null; ParentKeyName = $null; ReleaseType = $null },
            [pscustomobject]@{ PSChildName = 'Notepad++'; DisplayName = 'Notepad++ (64-bit)'; DisplayVersion = '8.6'; SystemComponent = $null; ParentKeyName = $null; ReleaseType = $null },
            [pscustomobject]@{ PSChildName = 'KB123'; DisplayName = 'Security Update'; DisplayVersion = '1'; SystemComponent = $null; ParentKeyName = 'Office'; ReleaseType = 'Security Update' },
            [pscustomobject]@{ PSChildName = 'Hidden'; DisplayName = 'Runtime'; DisplayVersion = '1'; SystemComponent = 1; ParentKeyName = $null; ReleaseType = $null },
            [pscustomobject]@{ PSChildName = 'NoName'; DisplayName = $null; DisplayVersion = '1'; SystemComponent = $null; ParentKeyName = $null; ReleaseType = $null },
            [pscustomobject]@{ PSChildName = 'Notepad++dup'; DisplayName = 'Notepad++ (64-bit)'; DisplayVersion = '8.6'; SystemComponent = $null; ParentKeyName = $null; ReleaseType = $null }
        )
        $apps = ConvertTo-MdmAppList $entries
        $apps.Count | Should -Be 2
        $pos = $apps | Where-Object { $_.name -eq 'POS Blagajna' }
        $pos.packageName | Should -Be '{12345678-1234-1234-1234-1234567890AB}'
        $pos.version | Should -Be '2.4.1'
        @($apps | Where-Object { $_.packageName -eq 'Notepad++ (64-bit)' }).Count | Should -Be 1
    }
}

Describe 'ConvertTo-MdmTelemetry' {
    It 'mapira CIM podatke u telemetriju protokola' {
        $boot = [datetime]'2026-09-24T08:00:00'
        $raw = @{
            Now            = [datetime]'2026-09-24T10:00:00'
            AgentVersion   = '1.2.3'
            ComputerSystem = @{ Manufacturer = 'LENOVO '; Model = 'ThinkCentre'; TotalPhysicalMemory = 8GB; Domain = 'WORKGROUP'; UserName = 'PC\blagajna'; Name = 'BLAGAJNA1' }
            Product        = @{ UUID = 'ABCD' }
            Bios           = @{ SerialNumber = ' PF12345 ' }
            OS             = @{ Caption = 'Microsoft Windows 11 Pro'; Version = '10.0.22631'; BuildNumber = '22631'; LastBootUpTime = $boot }
            Batteries      = @(@{ EstimatedChargeRemaining = 83; BatteryStatus = 2 })
            SystemDisk     = @{ FreeSpace = 10GB; Size = 100GB }
            Adapters       = @(
                @{ IPEnabled = $true; IPAddress = @('169.254.1.1'); MACAddress = '00:11:22:33:44:55'; DefaultIPGateway = $null },
                @{ IPEnabled = $true; IPAddress = @('192.168.1.23', 'fe80::1'); MACAddress = 'aa:bb:cc:dd:ee:ff'; DefaultIPGateway = @('192.168.1.1') }
            )
            Wifi           = @{ Ssid = 'Lokal'; Rssi = -58 }
            Apps           = @(@{ packageName = 'x'; name = 'X' })
            Cpu            = 'Intel N100 '
        }
        $t = ConvertTo-MdmTelemetry -Raw $raw
        $t.serial | Should -Be 'PF12345'
        $t.manufacturer | Should -Be 'LENOVO'
        $t.osVersion | Should -Be 'Microsoft Windows 11 Pro (10.0.22631)'
        $t.agentVersion | Should -Be '1.2.3'
        $t.ipAddress | Should -Be '192.168.1.23'
        $t.macAddress | Should -Be 'AA:BB:CC:DD:EE:FF'
        $t.wifiSsid | Should -Be 'Lokal'
        $t.wifiSignal | Should -Be -58
        $t.batteryLevel | Should -Be 83
        $t.charging | Should -BeTrue
        $t.storageFreeMb | Should -Be 10240
        $t.storageTotalMb | Should -Be 102400
        $t.ramTotalMb | Should -Be 8192
        $t.uptimeSec | Should -Be 7200
        @($t.apps).Count | Should -Be 1
        $t.extra.cpu | Should -Be 'Intel N100'
        $t.extra.domain | Should -Be 'WORKGROUP'
        $t.extra.hardwareUuid | Should -Be 'ABCD'
    }
    It 'stolno računalo bez baterije i s lažnim serijskim brojem' {
        $t = ConvertTo-MdmTelemetry -Raw @{ Bios = @{ SerialNumber = 'To be filled by O.E.M.' }; Batteries = @(); Adapters = @() }
        $t.serial | Should -BeNullOrEmpty
        $t.batteryLevel | Should -BeNullOrEmpty
        $t.charging | Should -BeNullOrEmpty
        $t.Contains('apps') | Should -BeFalse
    }
    It 'serijalizira se u JSON' {
        $t = ConvertTo-MdmTelemetry -Raw @{ Bios = @{ SerialNumber = 'S1' } }
        $j = ConvertTo-Json -InputObject $t -Depth 5 -Compress
        $j | Should -Match '"serial":"S1"'
    }
}

Describe 'Get-MdmConfigPlan' {
    BeforeAll {
        $script:sha = 'a' * 64
        $script:cfg = [pscustomobject]@{
            version  = 4
            settings = [pscustomobject]@{
                kiosk            = $true
                startApp         = 'app1'
                restrictions     = [pscustomobject]@{ noUsbFileTransfer = $true; noSettings = $true }
                wifi             = @([pscustomobject]@{ ssid = 'Lokal'; security = 'WPA2'; password = 'tajna1234' }, [pscustomobject]@{ ssid = 'Los'; security = 'WPA2'; password = '1' })
                timezone         = 'Europe/Zagreb'
                screenTimeoutSec = 90
            }
            apps     = @(
                [pscustomobject]@{ appId = 'app1'; packageName = 'C:\POS\pos.exe'; name = 'POS'; version = '2.0'; downloadPath = '/api/mdm/agent/files/f1'; sha256 = $script:sha; config = [pscustomobject]@{ url = 'https://x' } },
                [pscustomobject]@{ appId = 'app2'; packageName = 'Old Tool'; name = 'Old Tool'; remove = $true },
                [pscustomobject]@{ appId = 'app3'; packageName = 'Pending'; name = 'Pending'; version = '1'; downloadPath = $null; sha256 = $null },
                [pscustomobject]@{ appId = 'app4'; packageName = 'Same'; name = 'Same'; version = '1.0'; downloadPath = '/f'; sha256 = $script:sha }
            )
        }
    }
    It 'plan redom: uklanjanje, instalacija, postavke, restrikcije, Wi-Fi, zona, zaslon, pokretanje' {
        $installed = @(@{ packageName = 'Old Tool'; name = 'Old Tool'; version = '1' }, @{ packageName = 'Same'; name = 'Same'; version = '1.0' }, @{ packageName = 'POS'; name = 'POS'; version = '1.0' })
        $plan = Get-MdmConfigPlan -Config $script:cfg -InstalledApps $installed
        $kinds = @($plan | ForEach-Object { $_.Kind })
        $kinds | Should -Be @('Uninstall', 'Install', 'Warn', 'AppConfig', 'UsbStorage', 'NoControlPanel', 'Wifi', 'Warn', 'TimeZone', 'ScreenTimeout', 'StartApp')
        ($plan | Where-Object Kind -EQ 'Uninstall').PackageName | Should -Be 'Old Tool'
        ($plan | Where-Object Kind -EQ 'Install').App.packageName | Should -Be 'C:\POS\pos.exe'
        ($plan | Where-Object Kind -EQ 'UsbStorage').Disabled | Should -BeTrue
        ($plan | Where-Object Kind -EQ 'TimeZone').Id | Should -Be 'Central European Standard Time'
        ($plan | Where-Object Kind -EQ 'ScreenTimeout').Minutes | Should -Be 2
        ($plan | Where-Object Kind -EQ 'StartApp').Command | Should -Be 'C:\POS\pos.exe'
        ($plan | Where-Object Kind -EQ 'AppConfig').Values.url | Should -Be 'https://x'
    }
    It 'prazna konfiguracija vraća zadane vrijednosti' {
        $plan = Get-MdmConfigPlan -Config @{ version = 1; settings = @{}; apps = @() }
        @($plan | ForEach-Object { $_.Kind }) | Should -Be @('UsbStorage', 'NoControlPanel', 'StartApp')
        ($plan | Where-Object Kind -EQ 'StartApp').Command | Should -BeNullOrEmpty
        ($plan | Where-Object Kind -EQ 'UsbStorage').Disabled | Should -BeFalse
    }
}

Describe 'Test-MdmCommandPayload' {
    It 'INSTALL_APP traži paket, putanju i sha256' {
        $p = Test-MdmCommandPayload -Type 'INSTALL_APP' -Payload @{ packageName = 'POS'; downloadPath = '/api/mdm/agent/files/1'; sha256 = ('A' * 64); installArgs = '/S' }
        $p.sha256 | Should -Be ('a' * 64)
        $p.installArgs | Should -Be '/S'
        { Test-MdmCommandPayload -Type 'INSTALL_APP' -Payload @{ packageName = 'POS'; downloadPath = '/x'; sha256 = '12' } } | Should -Throw '*sha256*'
        { Test-MdmCommandPayload -Type 'INSTALL_APP' -Payload @{ downloadPath = '/x'; sha256 = ('a' * 64) } } | Should -Throw "*packageName*"
    }
    It 'MESSAGE skraćuje na 2000 znakova' {
        (Test-MdmCommandPayload -Type 'MESSAGE' -Payload @{ text = ('x' * 3000) }).text.Length | Should -BeLessOrEqual 2000
        { Test-MdmCommandPayload -Type 'MESSAGE' -Payload @{} } | Should -Throw
    }
    It 'RUN_SCRIPT dopušta samo powershell i cmd' {
        (Test-MdmCommandPayload -Type 'RUN_SCRIPT' -Payload @{ script = 'dir' }).shell | Should -Be 'powershell'
        (Test-MdmCommandPayload -Type 'RUN_SCRIPT' -Payload @{ script = 'dir'; shell = 'CMD' }).shell | Should -Be 'cmd'
        { Test-MdmCommandPayload -Type 'RUN_SCRIPT' -Payload @{ script = 'x'; shell = 'bash' } } | Should -Throw
    }
    It 'PUSH_FILE odbija ime s putanjom' {
        { Test-MdmCommandPayload -Type 'PUSH_FILE' -Payload @{ name = '..\evil.exe'; downloadPath = '/f'; sha256 = ('b' * 64) } } | Should -Throw
    }
    It 'SET_KIOSK traži enabled' {
        (Test-MdmCommandPayload -Type 'SET_KIOSK' -Payload @{ enabled = $false }).enabled | Should -BeFalse
        { Test-MdmCommandPayload -Type 'SET_KIOSK' -Payload @{} } | Should -Throw
    }
}

Describe 'Putanje i adrese' {
    It 'Resolve-MdmDownloadUrl spaja relativnu putanju i odbija drugi poslužitelj' {
        Resolve-MdmDownloadUrl -Server 'https://erp.hr/' -Path '/api/mdm/agent/files/1' | Should -Be 'https://erp.hr/api/mdm/agent/files/1'
        { Resolve-MdmDownloadUrl -Server 'https://erp.hr' -Path 'https://evil.example/x' } | Should -Throw
        { Resolve-MdmDownloadUrl -Server 'https://erp.hr' -Path '//evil.example/x' } | Should -Throw
    }
    It 'Resolve-MdmTargetPath' {
        Resolve-MdmTargetPath -TargetPath 'C:\ProgramData\ERPWMS\files\' -Name 'a.pdf' -DefaultDir 'C:\D' | Should -Be 'C:\ProgramData\ERPWMS\files\a.pdf'
        Resolve-MdmTargetPath -TargetPath 'C:\Cjenik\novo.pdf' -Name 'a.pdf' -DefaultDir 'C:\D' | Should -Be 'C:\Cjenik\novo.pdf'
        Resolve-MdmTargetPath -TargetPath 'a.pdf' -Name 'a.pdf' -DefaultDir 'C:\D' | Should -Be 'C:\D\a.pdf'
        Resolve-MdmTargetPath -TargetPath $null -Name 'b.txt' -DefaultDir 'C:\D' | Should -Be 'C:\D\b.txt'
        { Resolve-MdmTargetPath -TargetPath 'C:\x\..\Windows\y' -Name 'a' -DefaultDir 'C:\D' } | Should -Throw
    }
}

Describe 'Get-MdmBackoffSec' {
    It 'eksponencijalno uz jitter, najviše checkinSec' {
        Get-MdmBackoffSec -CheckinSec 60 -Failures 1 -Random 0.5 | Should -Be 5
        Get-MdmBackoffSec -CheckinSec 60 -Failures 3 -Random 0.5 | Should -Be 20
        Get-MdmBackoffSec -CheckinSec 60 -Failures 10 -Random 0.5 | Should -Be 60
        Get-MdmBackoffSec -CheckinSec 60 -Failures 10 -Random 0 | Should -Be 30
        Get-MdmBackoffSec -CheckinSec 60 -Failures 0 -Random 0 | Should -Be 54
        Get-MdmBackoffSec -CheckinSec 60 -Failures 0 -Random 0.5 | Should -Be 60
    }
    It 'Get-MdmCheckinSec ograničava interval' {
        Get-MdmCheckinSec $null | Should -Be 60
        Get-MdmCheckinSec 5 | Should -Be 15
        Get-MdmCheckinSec 99999 | Should -Be 3600
    }
}

Describe 'Ostalo' {
    It 'New-MdmWifiProfileXml je ispravan XML s escapeom' {
        $x = New-MdmWifiProfileXml -Ssid 'A&B <5G>' -Security 'WPA2' -Passphrase 'p"w<d>1234' -Hidden
        $doc = [xml]$x
        $doc.WLANProfile.name | Should -Be 'A&B <5G>'
        $doc.WLANProfile.SSIDConfig.nonBroadcast | Should -Be 'true'
        $doc.WLANProfile.MSM.security.sharedKey.keyMaterial | Should -Be 'p"w<d>1234'
        ([xml](New-MdmWifiProfileXml -Ssid 'Open' -Security 'NONE')).WLANProfile.MSM.security.authEncryption.authentication | Should -Be 'open'
    }
    It 'ConvertTo-MdmWindowsTimeZone' {
        ConvertTo-MdmWindowsTimeZone 'Europe/Zagreb' | Should -Be 'Central European Standard Time'
        ConvertTo-MdmWindowsTimeZone 'W. Europe Standard Time' | Should -Be 'W. Europe Standard Time'
        ConvertTo-MdmWindowsTimeZone 'Mars/Olympus' | Should -BeNullOrEmpty
        # svaka mapirana zona postoji u Windowsu
        foreach ($z in @('Europe/Zagreb', 'Europe/Vienna', 'Europe/London', 'Europe/Paris', 'Europe/Budapest', 'Europe/Athens', 'Europe/Sofia', 'UTC')) {
            { [System.TimeZoneInfo]::FindSystemTimeZoneById((ConvertTo-MdmWindowsTimeZone $z)) } | Should -Not -Throw
        }
    }
    It 'Limit-MdmText' {
        (Limit-MdmText ('a' * 100) 50).Length | Should -BeLessOrEqual 50
        Limit-MdmText 'kratko' 50 | Should -Be 'kratko'
    }
    It 'ConvertTo-MdmHashtable čuva nizove od jednog elementa' {
        $h = ConvertTo-MdmHashtable (ConvertFrom-Json '{"a":[{"b":1}],"c":null,"d":{"e":"f"}}')
        @($h.a).Count | Should -Be 1
        $h.a[0].b | Should -Be 1
        $h.c | Should -BeNullOrEmpty
        $h.d.e | Should -Be 'f'
    }
}
