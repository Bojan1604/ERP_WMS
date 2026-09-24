package hr.erpwms.mdm.agent.policy

import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import hr.erpwms.mdm.agent.AdminReceiver
import hr.erpwms.mdm.agent.ApiClient
import hr.erpwms.mdm.agent.AgentLog
import hr.erpwms.mdm.agent.core.DeviceControl
import hr.erpwms.mdm.agent.core.ResolvedApp
import hr.erpwms.mdm.agent.core.SystemUpdates
import hr.erpwms.mdm.agent.core.WifiNetwork
import hr.erpwms.mdm.agent.core.WifiSecurity
import hr.erpwms.mdm.agent.install.Installer
import java.io.File
import java.util.TimeZone

/** Stvarna provedba mjera kroz DevicePolicyManager (agent kao Device Owner). */
class AndroidDeviceControl(private val ctx: Context, private val api: () -> ApiClient) : DeviceControl {
    private val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
    private val admin = AdminReceiver.component(ctx)

    override val isDeviceOwner: Boolean get() = dpm.isDeviceOwnerApp(ctx.packageName)
    override val ownPackage: String get() = ctx.packageName

    override fun installedPackages(): Map<String, Long> =
        ctx.packageManager.getInstalledPackages(PackageManager.MATCH_UNINSTALLED_PACKAGES).filter { isReallyInstalled(it) }
            .associate { it.packageName to versionCode(it) }

    private fun isReallyInstalled(p: PackageInfo) = p.applicationInfo?.let { (it.flags and android.content.pm.ApplicationInfo.FLAG_INSTALLED) != 0 } ?: true

    override fun setRestriction(key: String, enabled: Boolean) {
        if (enabled) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
    }

    override fun setCameraDisabled(disabled: Boolean) = dpm.setCameraDisabled(admin, disabled)

    override fun setStatusBarDisabled(disabled: Boolean) {
        if (!dpm.setStatusBarDisabled(admin, disabled) && disabled) throw IllegalStateException("sustav je odbio (postoji zaključavanje zaslona?)")
    }

    override fun setHidden(packageName: String, hidden: Boolean): Boolean = dpm.setApplicationHidden(admin, packageName, hidden)

    override fun setAppRestrictions(packageName: String, values: Map<String, String>) {
        val b = Bundle()
        // Managed configuration: sve vrijednosti kao tekst (protokol šalje Record<string, string>)
        values.forEach { (k, v) -> b.putString(k, v) }
        dpm.setApplicationRestrictions(admin, packageName, b)
    }

    override fun install(app: ResolvedApp) {
        val path = app.downloadPath ?: throw IllegalArgumentException("nema datoteke za preuzimanje")
        val sha = app.sha256 ?: throw IllegalArgumentException("nema sha256")
        installFromServer(app.packageName, path, sha)
    }

    fun installFromServer(packageName: String, downloadPath: String, sha256: String) {
        val dir = File(ctx.cacheDir, "apk").apply { mkdirs() }
        val apk = File(dir, "$packageName.apk")
        AgentLog.i("install", "Preuzimam $packageName")
        api().download(downloadPath, apk, sha256)
        try {
            Installer.install(ctx, apk, packageName)
            AgentLog.i("install", "Instalirano: $packageName", report = true)
        } finally {
            apk.delete()
        }
    }

    override fun uninstall(packageName: String) {
        if (packageName == ctx.packageName) throw IllegalArgumentException("agent ne uklanja sam sebe (koristite FORGET)")
        Installer.uninstall(ctx, packageName)
        AgentLog.i("install", "Uklonjeno: $packageName", report = true)
    }

    @Suppress("DEPRECATION")
    override fun addWifi(net: WifiNetwork) {
        val wm = ctx.applicationContext.getSystemService(WifiManager::class.java)
        if (!wm.isWifiEnabled) runCatching { wm.setWifiEnabled(true) }
        val quoted = "\"${net.ssid}\""
        val conf = WifiConfiguration().apply {
            SSID = quoted
            hiddenSSID = net.hidden
            when (net.security) {
                WifiSecurity.NONE -> allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
                WifiSecurity.WPA2 -> {
                    allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
                    preSharedKey = "\"${net.password}\""
                }
                WifiSecurity.WPA3 -> {
                    if (Build.VERSION.SDK_INT >= 30) setSecurityParams(WifiConfiguration.SECURITY_TYPE_SAE)
                    else allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
                    preSharedKey = "\"${net.password}\""
                }
            }
        }
        val existing = runCatching { wm.configuredNetworks }.getOrNull()?.firstOrNull { it.SSID == quoted }
        val id = if (existing != null) {
            conf.networkId = existing.networkId
            wm.updateNetwork(conf)
        } else {
            wm.addNetwork(conf)
        }
        if (id < 0) throw IllegalStateException("sustav je odbio mrežu")
        wm.enableNetwork(id, false)
    }

    override fun setScreenTimeout(ms: Int) {
        if (Build.VERSION.SDK_INT < 28) throw UnsupportedOperationException("traži Android 9+")
        dpm.setSystemSetting(admin, Settings.System.SCREEN_OFF_TIMEOUT, ms.toString())
    }

    override fun setTimeZone(tz: String) {
        if (Build.VERSION.SDK_INT < 28) throw UnsupportedOperationException("traži Android 9+")
        if (tz !in TimeZone.getAvailableIDs()) throw IllegalArgumentException("nepoznata vremenska zona")
        if (Build.VERSION.SDK_INT >= 30) dpm.setAutoTimeZoneEnabled(admin, false)
        else dpm.setGlobalSetting(admin, Settings.Global.AUTO_TIME_ZONE, "0")
        if (!dpm.setTimeZone(admin, tz)) throw IllegalStateException("sustav je odbio")
    }

    override fun setVolume(pct: Int) {
        val am = ctx.getSystemService(AudioManager::class.java)
        for (stream in intArrayOf(AudioManager.STREAM_MUSIC, AudioManager.STREAM_RING, AudioManager.STREAM_NOTIFICATION)) {
            val max = am.getStreamMaxVolume(stream)
            runCatching { am.setStreamVolume(stream, (max * pct + 50) / 100, 0) }
        }
    }

    override fun setSystemUpdates(mode: SystemUpdates?) {
        val p = when (mode) {
            SystemUpdates.AUTOMATIC -> SystemUpdatePolicy.createAutomaticInstallPolicy()
            SystemUpdates.WINDOWED -> SystemUpdatePolicy.createWindowedInstallPolicy(120, 240)
            SystemUpdates.POSTPONE -> SystemUpdatePolicy.createPostponeInstallPolicy()
            null -> null
        }
        dpm.setSystemUpdatePolicy(admin, p)
    }

    override fun setKiosk(enabled: Boolean, startPackage: String?) {
        if (Kiosk.suspended && enabled) return
        Kiosk.set(ctx, enabled, startPackage)
    }

    companion object {
        @Suppress("DEPRECATION")
        fun versionCode(p: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()
    }
}
