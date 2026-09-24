package hr.erpwms.mdm.agent

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.telephony.TelephonyManager
import hr.erpwms.mdm.agent.core.AppInfo
import hr.erpwms.mdm.agent.core.Telemetry
import java.net.Inet4Address
import java.net.NetworkInterface

/** Prikuplja telemetriju uređaja. Svako polje je zasebno zaštićeno — greška jednog ne ruši ostale. */
object TelemetryCollector {
    private var lastAppsHash = 0
    private var lastAppsAt = 0L

    private inline fun <T> safe(block: () -> T?): T? = try { block() } catch (_: Throwable) { null }

    fun hardwareId(ctx: Context): String =
        safe { Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) } ?: "android-unknown"

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission", "HardwareIds")
    fun serial(): String? {
        val s = safe { Build.getSerial() } ?: Build.SERIAL
        return s?.takeIf { it.isNotBlank() && !it.equals(Build.UNKNOWN, true) }
    }

    fun osVersion(): String = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"

    fun isDeviceOwner(ctx: Context): Boolean = safe { ctx.getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(ctx.packageName) } ?: false

    data class Wifi(val ssid: String?, val rssi: Int?)

    @Suppress("DEPRECATION")
    fun wifi(ctx: Context): Wifi {
        val wm = safe { ctx.applicationContext.getSystemService(WifiManager::class.java) } ?: return Wifi(null, null)
        val info = safe { wm.connectionInfo } ?: return Wifi(null, null)
        if (info.networkId == -1 && info.rssi <= -127) return Wifi(null, null)
        val ssid = info.ssid?.removeSurrounding("\"")?.takeIf { it.isNotBlank() && it != "<unknown ssid>" && it != WifiManager.UNKNOWN_SSID }
        val rssi = info.rssi.takeIf { it in -126..0 }
        return Wifi(ssid, if (ssid == null && info.networkId == -1) null else rssi)
    }

    @SuppressLint("MissingPermission", "HardwareIds")
    fun collect(ctx: Context, forceApps: Boolean = false): Telemetry {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val owner = isDeviceOwner(ctx)
        val wifi = wifi(ctx)
        val battery = safe { ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }
        val level = battery?.let {
            val l = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val s = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (l >= 0 && s > 0) l * 100 / s else null
        }
        val charging = battery?.let {
            val st = it.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL || it.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        }
        val stat = safe { StatFs(Environment.getDataDirectory().path) }
        val mem = safe { ActivityManager.MemoryInfo().also { ctx.getSystemService(ActivityManager::class.java).getMemoryInfo(it) } }
        val imei = safe {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            tm?.imei
        }?.takeIf { it.isNotBlank() }
        val mac = if (owner) safe { dpm.getWifiMacAddress(AdminReceiver.component(ctx)) } else null

        val prefs = Prefs(ctx)
        val extra = linkedMapOf<String, Any?>(
            "securityPatch" to Build.VERSION.SECURITY_PATCH,
            "sdk" to Build.VERSION.SDK_INT,
            "brand" to Build.BRAND,
            "device" to Build.DEVICE,
            "product" to Build.PRODUCT,
            "fingerprint" to Build.FINGERPRINT,
            "deviceOwner" to owner,
            "kiosk" to prefs.kioskEnabled,
            "kioskPackage" to prefs.kioskPackage,
            "ramAvailMb" to mem?.availMem?.let { it / MB },
        )

        val apps = installedApps(ctx)
        val hash = apps.hashCode()
        val now = System.currentTimeMillis()
        val sendApps = forceApps || hash != lastAppsHash || now - lastAppsAt > 60 * 60_000
        if (sendApps) { lastAppsHash = hash; lastAppsAt = now }

        return Telemetry(
            serial = serial(),
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            osVersion = osVersion(),
            agentVersion = BuildConfig.VERSION_NAME,
            imei = imei,
            macAddress = mac,
            ipAddress = ipAddress(),
            wifiSsid = wifi.ssid,
            wifiSignal = wifi.rssi,
            batteryLevel = level,
            charging = charging,
            storageFreeMb = stat?.availableBytes?.let { it / MB },
            storageTotalMb = stat?.totalBytes?.let { it / MB },
            ramTotalMb = mem?.totalMem?.let { it / MB },
            uptimeSec = SystemClock.elapsedRealtime() / 1000,
            apps = if (sendApps) apps else null,
            extra = extra,
        )
    }

    /** Prva IPv4 adresa koja nije loopback (Wi-Fi, Ethernet ili mobilna mreža). */
    fun ipAddress(): String? = safe {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .sortedBy { if (it.name.startsWith("wlan")) 0 else if (it.name.startsWith("eth")) 1 else 2 }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }?.hostAddress
    }

    /** Korisničke aplikacije + ažurirane sistemske (bez čistih sistemskih). */
    fun installedApps(ctx: Context): List<AppInfo> = safe {
        val pm = ctx.packageManager
        pm.getInstalledPackages(PackageManager.GET_META_DATA).mapNotNull { p ->
            val ai = p.applicationInfo ?: return@mapNotNull null
            val system = (ai.flags and ApplicationInfo.FLAG_SYSTEM) != 0
            val updated = (ai.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
            if (system && !updated) return@mapNotNull null
            AppInfo(
                packageName = p.packageName,
                name = safe { pm.getApplicationLabel(ai).toString() },
                version = p.versionName,
                versionCode = hr.erpwms.mdm.agent.policy.AndroidDeviceControl.versionCode(p),
            )
        }.sortedBy { it.packageName }
    } ?: emptyList()

    private const val MB = 1024L * 1024L
}
