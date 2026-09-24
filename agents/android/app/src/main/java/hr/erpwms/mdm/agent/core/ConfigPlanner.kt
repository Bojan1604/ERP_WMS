package hr.erpwms.mdm.agent.core

/**
 * Konfiguracija → plan mjera (bez poziva Android API-ja). [hr.erpwms.mdm.agent.policy.PolicyApplier]
 * plan provodi kroz DevicePolicyManager.
 */
object Restriction {
    // Vrijednosti konstanti android.os.UserManager.DISALLOW_* (stabilne od API 21–28).
    const val INSTALL_APPS = "no_install_apps"
    const val UNINSTALL_APPS = "no_uninstall_apps"
    const val INSTALL_UNKNOWN_SOURCES = "no_install_unknown_sources"
    const val CONFIG_WIFI = "no_config_wifi"
    const val CONFIG_BLUETOOTH = "no_config_bluetooth"
    const val CONFIG_MOBILE_NETWORKS = "no_config_mobile_networks"
    const val CONFIG_TETHERING = "no_config_tethering"
    const val CONFIG_VPN = "no_config_vpn"
    const val CONFIG_DATE_TIME = "no_config_date_time"
    const val CONFIG_LOCATION = "no_config_location"
    const val USB_FILE_TRANSFER = "no_usb_file_transfer"
    const val FACTORY_RESET = "no_factory_reset"
    const val DEBUGGING_FEATURES = "no_debugging_features"
    const val SAFE_BOOT = "no_safe_boot"
    const val ADD_USER = "no_add_user"
    const val MOUNT_PHYSICAL_MEDIA = "no_physical_media"

    /** Sve restrikcije kojima agent upravlja (ostale ne dira). */
    val MANAGED: Set<String> = setOf(
        INSTALL_APPS, UNINSTALL_APPS, INSTALL_UNKNOWN_SOURCES,
        CONFIG_WIFI, CONFIG_BLUETOOTH, CONFIG_MOBILE_NETWORKS, CONFIG_TETHERING, CONFIG_VPN, CONFIG_DATE_TIME,
        USB_FILE_TRANSFER, FACTORY_RESET, DEBUGGING_FEATURES, SAFE_BOOT, ADD_USER, MOUNT_PHYSICAL_MEDIA,
    )
}

const val PLAY_STORE_PACKAGE = "com.android.vending"

data class KioskPlan(val enabled: Boolean, val startPackage: String?)

data class InstallPlan(val app: ResolvedApp, val reason: String)

data class PolicyPlan(
    val addRestrictions: Set<String>,
    val clearRestrictions: Set<String>,
    val cameraDisabled: Boolean,
    val statusBarDisabled: Boolean,
    val kiosk: KioskPlan,
    val hide: Set<String>,
    val unhide: Set<String>,
    val appRestrictions: Map<String, Map<String, String>>,
    val installs: List<InstallPlan>,
    val removals: List<String>,
    val wifi: List<WifiNetwork>,
    val skippedWifi: List<String>,
    val screenTimeoutMs: Int?,
    val timezone: String?,
    val volumePct: Int?,
    val systemUpdates: SystemUpdates?,
    val autoStart: List<String>,
)

object ConfigPlanner {
    /**
     * @param installed instalirani paketi → versionCode
     * @param previouslyHidden paketi koje je agent ranije sakrio (da ih može otkriti)
     * @param ownPackage paket agenta (nikad se ne sakriva/uklanja, uvijek je u kiosku)
     */
    fun plan(
        cfg: EffectiveConfig,
        installed: Map<String, Long>,
        previouslyHidden: Set<String>,
        ownPackage: String,
    ): PolicyPlan {
        val s = cfg.settings
        val r = s.restrictions

        val add = LinkedHashSet<String>()
        if (r.noInstallApps) add += listOf(Restriction.INSTALL_APPS, Restriction.UNINSTALL_APPS, Restriction.INSTALL_UNKNOWN_SOURCES)
        if (r.noSettings) add += listOf(
            Restriction.CONFIG_WIFI, Restriction.CONFIG_BLUETOOTH, Restriction.CONFIG_MOBILE_NETWORKS,
            Restriction.CONFIG_TETHERING, Restriction.CONFIG_VPN, Restriction.CONFIG_DATE_TIME,
        )
        if (r.noUsbFileTransfer) add += listOf(Restriction.USB_FILE_TRANSFER, Restriction.MOUNT_PHYSICAL_MEDIA)
        if (r.noFactoryReset) add += Restriction.FACTORY_RESET
        if (s.adb == false) add += Restriction.DEBUGGING_FEATURES
        if (s.kiosk) add += listOf(Restriction.SAFE_BOOT, Restriction.ADD_USER)
        val clear = Restriction.MANAGED - add

        val startPackage = resolveStartApp(s.startApp, cfg.apps)

        val hide = LinkedHashSet<String>()
        cfg.apps.filter { it.hidden && !it.remove }.forEach { hide += it.packageName }
        if (r.noPlayStore) hide += PLAY_STORE_PACKAGE
        hide -= ownPackage
        startPackage?.let { hide -= it }
        val unhide = previouslyHidden - hide

        val appRestrictions = cfg.apps.filter { !it.remove && it.config.isNotEmpty() }.associate { it.packageName to it.config }

        val installs = ArrayList<InstallPlan>()
        val removals = ArrayList<String>()
        for (a in cfg.apps) {
            if (a.packageName == ownPackage) {
                // samoažuriranje agenta: samo novija verzija, nikad uklanjanje
                if (!a.remove && canInstall(a) && isNewer(a, installed[a.packageName])) installs += InstallPlan(a, "update")
                continue
            }
            if (a.remove) {
                if (installed.containsKey(a.packageName)) removals += a.packageName
                continue
            }
            if (!canInstall(a)) continue
            val have = installed[a.packageName]
            when {
                have == null -> installs += InstallPlan(a, "install")
                isNewer(a, have) -> installs += InstallPlan(a, "update")
            }
        }

        val (wifiOk, wifiSkip) = s.wifi.partition { validWifi(it) }

        return PolicyPlan(
            addRestrictions = add,
            clearRestrictions = clear,
            cameraDisabled = r.noCamera,
            statusBarDisabled = r.noStatusBar || s.kiosk,
            kiosk = KioskPlan(s.kiosk, startPackage),
            hide = hide,
            unhide = unhide,
            appRestrictions = appRestrictions,
            installs = installs,
            removals = removals,
            wifi = wifiOk,
            skippedWifi = wifiSkip.map { it.ssid },
            screenTimeoutMs = s.screenTimeoutSec?.takeIf { it > 0 }?.coerceIn(10, 24 * 3600)?.times(1000),
            timezone = s.timezone?.takeIf { it.isNotBlank() },
            volumePct = s.volumePct?.coerceIn(0, 100),
            systemUpdates = s.systemUpdates,
            autoStart = cfg.apps.filter { it.autoStart && !it.remove }.map { it.packageName },
        )
    }

    /** startApp je paket ili appId aplikacije iz konfiguracije. */
    fun resolveStartApp(startApp: String?, apps: List<ResolvedApp>): String? {
        val s = startApp?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return apps.firstOrNull { it.appId == s }?.packageName ?: s
    }

    private fun canInstall(a: ResolvedApp) = a.downloadPath != null && a.sha256 != null

    private fun isNewer(a: ResolvedApp, have: Long?): Boolean {
        if (have == null) return true
        val want = a.versionCode ?: return false
        return want > have
    }

    fun validWifi(w: WifiNetwork): Boolean {
        if (w.ssid.isBlank() || w.ssid.length > 32) return false
        return when (w.security) {
            WifiSecurity.NONE -> true
            WifiSecurity.WPA2, WifiSecurity.WPA3 -> (w.password?.length ?: 0) in 8..63
        }
    }
}
