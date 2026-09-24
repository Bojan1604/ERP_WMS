# MDM agenti (Android i Windows)

Agenti na uređajima za MDM modul ERP/WMS-a. Javljaju se poslužitelju preko `/api/mdm/agent/*`
prema protokolu v1 (`docs/mdm-agent-protocol.md`, tipovi u `src/domain/mdm.ts`).

```
agents/
  android/          Kotlin aplikacija hr.erpwms.mdm.agent (Device Owner / DPC), Gradle wrapper
  windows/          PowerShell 5.1 agent: WmsAgent.ps1 + WmsAgent.psm1, UserAgent.ps1, install.ps1, uninstall.ps1
    tests/          Pester 5 testovi, lažni poslužitelj (mock-server.js), dimni test (Smoke.ps1)
  build-dist.sh     kopira CI artefakte u agents/dist/ (poslužitelj ih nudi na /api/mdm/agent/download/*)
```

CI: `.github/workflows/mdm-agents.yml` (pokreće se na promjene u `agents/**` na granama `main` i
`mdm-agents`, ili ručno). Posao **android** pokreće JVM testove i gradi APK, a posao **windows**
pokreće PSScriptAnalyzer, Pester, dimni test s lažnim poslužiteljem, instalaciju i deinstalaciju te
pakira `wms-agent.zip`.

---

## Android

### Upis QR kodom (preporučeno — puni nadzor, Device Owner)

1. Uređaj vratite na tvorničke postavke (ili uzmite nov). Agent postaje *Device Owner* samo na
   uređaju koji još nije postavljen.
2. Na zaslonu dobrodošlice **dodirnite 6 puta** isto mjesto na zaslonu. Otvara se čitač QR koda
   (na Androidu 8 i starijima prvo se preuzme čitač, pa uređaj mora imati internet).
3. Skenirajte QR kod iz portala **MDM → Upis** (`/mdm/upis`). QR sadrži adresu za preuzimanje APK-a,
   kontrolni zbroj potpisa i u „admin extras" adresu poslužitelja i ključ upisa.
4. Spojite uređaj na Wi-Fi kad to zatraži. Android preuzima agenta, provjerava potpis i postavlja ga za
   vlasnika uređaja. Agent se sam prijavljuje ključem upisa i odmah je **Upisan** u organizaciju i
   lokaciju ključa.

Poslužitelj treba varijablu `MDM_ANDROID_SIGNATURE_CHECKSUM`: to je vrijednost
**PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM** iz sažetka CI posla *Android agent* (base64url
SHA-256 certifikata kojim je APK potpisan; `build-dist.sh` je sprema i u
`dist/android/signature-checksum.txt`). Dok se APK potpisuje istim ključem, vrijednost se ne mijenja.

Neki uređaji imaju posebnosti:
- **Sunmi, Zebra i drugi terminali** koji imaju vlastiti postupak (StageNow, Sunmi Partner) mogu
  koristiti isti QR/JSON ako podržavaju standardni Android Enterprise provisioning.
- Na Androidu 12+ agent odgovara na `GET_PROVISIONING_MODE` (potpuno upravljani uređaj) i
  `ADMIN_POLICY_COMPLIANCE`.

### Ručna instalacija (bez Device Ownera)

APK (`/api/mdm/agent/download/android`) instalirajte ručno i otvorite aplikaciju. Zatim na zupčaniku
upišite adresu poslužitelja (i po želji ključ upisa). Bez ključa aplikacija prikaže **Welcome!** i
veliki šesteroznamenkasti kod. Taj kod upišite u portalu (MDM → Upis uređaja).

Bez Device Ownera **rade** prijava i upis, telemetrija (bez IMEI-ja i MAC adrese), poruke, slanje
datoteka, zapisnici i snimka zaslona uz pristanak. Instalacija aplikacija radi samo uz potvrdu
korisnika.
**Ne rade:** restrikcije, kiosk, skrivanje aplikacija, postavke aplikacija, Wi-Fi mreže, vremenska zona
i istek zaslona, zaključavanje (osim ako je agent uključen kao administrator uređaja), ponovno
pokretanje i brisanje. Aplikacija to i napiše na glavnom zaslonu.

### Zaslon agenta

Prikazuje naziv aplikacije i model uređaja. Dok uređaj čeka upis, prikazuje **Welcome!** i kod za upis.
Nakon upisa prikazuje **Upisano: \<naziv uređaja\>**, serijski broj, Wi-Fi, IP, poslužitelj i zadnje
javljanje. Zupčanik otvara ručne postavke, zaštićene servisnim PIN-om (`maintenancePin` iz profila).
Isti PIN služi i za privremeni izlaz iz kiosk načina (do ponovnog pokretanja ili nove konfiguracije).

### Izgradnja

```sh
cd agents/android
./gradlew testDebugUnitTest      # JVM testovi (protokol, plan restrikcija, putanje, odgoda)
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
# potpisani release (isti ključ = isti QR checksum):
ANDROID_KEYSTORE_PATH=/put/do/release.jks ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=… ANDROID_KEY_PASSWORD=… \
  ./gradlew assembleRelease
```

Treba JDK 17 i Android SDK (platforma 34). Nema ovisnosti o Firebaseu ni Play Servicesima.
U CI-ju release potpis traži tajne `ANDROID_KEYSTORE_BASE64` (keystore u base64),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` i `ANDROID_KEY_PASSWORD`. Bez njih se gradi debug APK
s privremenim ključem, pa se kontrolni zbroj mijenja pri svakoj izgradnji (dobro za testiranje, ne za
proizvodnju). Ključ se napravi ovako:
`keytool -genkeypair -v -keystore release.jks -alias erpwms -keyalg RSA -keysize 4096 -validity 10000`,
a za tajnu `base64 -w0 release.jks`.

---

## Windows

### Instalacija (jedan redak s portala)

U portalu (MDM → Upis) kopirajte naredbu i pokrenite je u **PowerShellu kao administrator**, npr.:

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr https://erp.example.hr/api/mdm/agent/download/windows-install -OutFile $env:TEMP\wms-agent-install.ps1; & $env:TEMP\wms-agent-install.ps1 -Server https://erp.example.hr -Token XXXX"
```

Ili ručno iz raspakiranog `wms-agent.zip`: `.\install.ps1 -Server https://erp.example.hr [-Token XXXX]`.

Što instalacija napravi:
- kopira agenta u `C:\Program Files\ERPWMS\Agent`;
- sprema postavke u `C:\ProgramData\ERPWMS\agent.json` s pristupom samo za SYSTEM i Administratore
  (token uređaja dodatno je šifriran DPAPI-jem, LocalMachine);
- registrira zakazani zadatak **ERPWMS Agent**. Radi kao SYSTEM, pokreće se pri paljenju računala,
  svakih 5 minuta provjerava da agent radi i ponovno ga pokreće ako padne;
- registrira zakazani zadatak **ERPWMS Agent (korisnik)**. Pokreće se pri prijavi korisnika i obavlja
  ono što SYSTEM ne može: snimku zaslona, poruke, zaključavanje i obavijest s kodom za upis. Zahtjevi
  idu kroz red u `C:\ProgramData\ERPWMS\queue`. U `requests` korisnici smiju samo čitati, a u
  `responses` pisati;
- zapisnik se vodi u `C:\ProgramData\ERPWMS\logs\agent.log` (rotacija 4 × 1 MB).

Bez ključa upisa kod za upis ispisuje se u zapisnik (redak `KOD ZA UPIS: 123456`) i prikazuje u
obavijesti prijavljenom korisniku.

Agent forsira TLS 1.2, koristi sistemski proxy i provjerava SHA-256 svake preuzete datoteke.
Uklanjanje: `& "C:\Program Files\ERPWMS\Agent\uninstall.ps1"` (vraća USB, upravljačku ploču i
automatsko pokretanje; `-KeepData` čuva zapisnike).

### Testovi i razvoj

```powershell
cd agents/windows
Invoke-Pester ./tests/WmsAgent.Tests.ps1           # Pester 5, čiste funkcije
./tests/Smoke.ps1                                  # lažni poslužitelj (Node) + agent u -DryRun načinu
./WmsAgent.ps1 -DataDir C:\temp\agent -DryRun -Once -Verbose   # jedan ciklus bez promjena sustava
node tests/mock-server.js 18080                    # samo lažni poslužitelj (vidi /_control/*)
```

`-DryRun` ne mijenja sustav: ne pokreće računalo ponovno i ne dira registar, `netsh`, vremensku zonu,
instalacije ni zakazane zadatke, nego samo zapisuje što bi napravio. `RUN_SCRIPT` se i tada izvršava.

---

## Naredbe po platformama

| Naredba | Android (Device Owner) | Windows |
|---|---|---|
| `REBOOT` | `DevicePolicyManager.reboot` (nakon slanja rezultata) | `shutdown /r /t 60` s porukom korisniku |
| `LOCK` | `lockNow` | `LockWorkStation` u korisničkoj sesiji (pomoćnik) |
| `WIPE` | `wipeData` / `wipeDevice` (Android 14) | nije podržano (`UNSUPPORTED`) |
| `FORGET` | skida restrikcije, kiosk i skrivanje, briše token, `clearDeviceOwnerApp`, gasi servis | vraća postavke, briše token, uklanja zakazane zadatke |
| `APPLY_CONFIG` | ponovno primjenjuje konfiguraciju iz odgovora | isto |
| `INSTALL_APP` | preuzimanje s nastavkom (Range/If-Range), SHA-256, tiha instalacija PackageInstallerom; ista verzija → `skipped` | MSI: `msiexec /i … /qn /norestart <installArgs>`; EXE: `<installArgs>` (npr. `/S`) |
| `UNINSTALL_APP` | PackageInstaller (tiho) | po ProductCode (`msiexec /x`) ili nazivu (QuietUninstallString / UninstallString `/S`) |
| `SCREENSHOT` | MediaProjection **uz pristanak korisnika** (vidi ograničenja) | pomoćnik u sesiji: `CopyFromScreen` → PNG |
| `UPLOAD_LOGS` | zapisnik agenta + logcat vlastitog procesa → gzip | zapisnik agenta + događaji System/Application (2 dana, upozorenja i greške) → zip |
| `MESSAGE` | obavijest + dijalog preko cijelog zaslona | poruka preko pomoćnika, inače `msg.exe *` |
| `PUSH_FILE` | `Download/…` → javna mapa Download (MediaStore), ostalo → mapa aplikacije | apsolutna putanja; mapa ako završava s `\`; relativno → `C:\ProgramData\ERPWMS\files` |
| `RUN_SCRIPT` | nije podržano | PowerShell ili cmd kao SYSTEM, najviše 10 min, izlaz do 32 KiB |
| `SET_KIOSK` | lock task + trajni početni zaslon koji pokreće aplikaciju | aplikacija u automatskom pokretanju (Run ključ) |

Primjena konfiguracije (profil + izmjene uređaja):

| Postavka | Android | Windows |
|---|---|---|
| `restrictions.noInstallApps` | `DISALLOW_INSTALL_APPS`, `…UNINSTALL_APPS`, `…INSTALL_UNKNOWN_SOURCES` | — |
| `restrictions.noSettings` | `DISALLOW_CONFIG_WIFI/BLUETOOTH/MOBILE_NETWORKS/TETHERING/VPN/DATE_TIME` | politika `NoControlPanel` |
| `restrictions.noUsbFileTransfer` | `DISALLOW_USB_FILE_TRANSFER`, `…MOUNT_PHYSICAL_MEDIA` | `USBSTOR Start=4` |
| `restrictions.noFactoryReset` | `DISALLOW_FACTORY_RESET` | — |
| `restrictions.noCamera` / `noStatusBar` | `setCameraDisabled` / `setStatusBarDisabled` | — |
| `restrictions.noPlayStore` | skriva `com.android.vending` | — |
| `adb: false` | `DISALLOW_DEBUGGING_FEATURES` | — |
| `kiosk` + `startApp` | lock task, trajni HOME, `DISALLOW_SAFE_BOOT`/`ADD_USER`, bez statusne trake | `startApp` u `HKLM\…\Run` |
| `wifi[]` | `WifiManager.addNetwork` (WPA2/WPA3/otvorena) | `netsh wlan add profile` (generirani XML) |
| `timezone` | `setTimeZone` (Android 9+) | `Set-TimeZone` (IANA → Windows ID) |
| `screenTimeoutSec` | `setSystemSetting(SCREEN_OFF_TIMEOUT)` (Android 9+) | `powercfg monitor-timeout` |
| `volumePct` | glasnoća medija, zvona i obavijesti | — |
| `systemUpdates` | `SystemUpdatePolicy` (automatski / 02–04 h / odgoda) | — |
| `apps[]` | instalacija/nadogradnja po `versionCode`, `remove`, `hidden`, `config` → managed configuration | instalacija po `version`, `remove`, `config` → `HKLM\SOFTWARE\WmsMdm\Apps\<paket>` |

Konfiguracija se bilježi kao primijenjena (`appliedConfigVersion`) tek kad svi koraci uspiju. Inače
agent šalje događaj s greškom, a poslužitelj konfiguraciju šalje ponovno pri sljedećem javljanju.

## Poznata ograničenja

- **Android — snimka zaslona:** Android ne dopušta tiho snimanje zaslona ni vlasniku uređaja. Agent
  prikazuje sistemski dijalog MediaProjection. Ako korisnik u 3 minute ne pristane (ili odbije),
  naredba završava kao neuspjela s objašnjenjem.
- **Android — IMEI i serijski broj:** čitaju se kao Device Owner. Bez toga su prazni na Androidu 10+.
- **Android — Wi-Fi** koristi zastarjeli `WifiConfiguration`, koji Device Owner još smije koristiti.
  Enterprise (802.1X) mreže nisu podržane.
- **Android — ponovna prijava:** nakon `FORGET` ili uklanjanja u portalu (HTTP 410) agent staje.
  Ponovni upis ide kroz ručne postavke ili novi QR upis.
- **Windows — kiosk je osnovni:** samo automatsko pokretanje aplikacije pri prijavi. Pravi zaključani
  način (Assigned Access / Shell Launcher) nije implementiran.
- **Windows — `autoStart`, `hidden` i `volumePct`** se ne primjenjuju. `WIPE` nije podržan.
- **Windows — pomoćnik u sesiji** radi samo dok je korisnik prijavljen. Bez njega snimka zaslona i
  zaključavanje ne uspijevaju, a poruka ide preko `msg.exe` (nema ga na izdanjima Home).
- Nijedan agent nije ispitan na stvarnim uređajima u CI-ju. Android se samo gradi i testira na JVM-u,
  a Windows agent prolazi dimni test protiv lažnog poslužitelja na `windows-latest`.
