package hr.erpwms.mdm.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfigPlannerTest {
    private val own = "hr.erpwms.mdm.agent"
    private val sha = "cd".repeat(32)

    private fun app(id: String, pkg: String, vc: Long? = 10, hidden: Boolean = false, remove: Boolean = false, config: Map<String, String> = emptyMap(), download: Boolean = true) =
        ResolvedApp(id, pkg, pkg, "1", vc, if (download) "/api/mdm/agent/files/$id" else null, if (download) sha else null, config, hidden, false, remove)

    private fun cfg(settings: ProfileSettings, apps: List<ResolvedApp> = emptyList()) = EffectiveConfig(3, settings, apps)

    @Test
    fun emptyConfigClearsEverything() {
        val p = ConfigPlanner.plan(cfg(ProfileSettings()), emptyMap(), emptySet(), own)
        assertTrue(p.addRestrictions.isEmpty())
        assertEquals(Restriction.MANAGED, p.clearRestrictions)
        assertFalse(p.cameraDisabled)
        assertFalse(p.statusBarDisabled)
        assertFalse(p.kiosk.enabled)
        assertNull(p.screenTimeoutMs)
        assertTrue(p.installs.isEmpty())
    }

    @Test
    fun restrictionsMapToUserRestrictions() {
        val s = ProfileSettings(
            adb = false,
            restrictions = Restrictions(noInstallApps = true, noSettings = true, noUsbFileTransfer = true, noFactoryReset = true, noCamera = true, noStatusBar = true, noPlayStore = true),
        )
        val p = ConfigPlanner.plan(cfg(s), emptyMap(), emptySet(), own)
        for (r in listOf(
            Restriction.INSTALL_APPS, Restriction.UNINSTALL_APPS, Restriction.INSTALL_UNKNOWN_SOURCES, Restriction.CONFIG_WIFI,
            Restriction.CONFIG_DATE_TIME, Restriction.USB_FILE_TRANSFER, Restriction.FACTORY_RESET, Restriction.DEBUGGING_FEATURES,
        )) assertTrue(r, r in p.addRestrictions)
        assertTrue(p.clearRestrictions.intersect(p.addRestrictions).isEmpty())
        assertEquals(Restriction.MANAGED, p.addRestrictions + p.clearRestrictions)
        assertTrue(p.cameraDisabled)
        assertTrue(p.statusBarDisabled)
        assertTrue(PLAY_STORE_PACKAGE in p.hide)
    }

    @Test
    fun adbTrueOrUnsetDoesNotBlockDebugging() {
        assertTrue(Restriction.DEBUGGING_FEATURES in ConfigPlanner.plan(cfg(ProfileSettings(adb = true)), emptyMap(), emptySet(), own).clearRestrictions)
        assertTrue(Restriction.DEBUGGING_FEATURES in ConfigPlanner.plan(cfg(ProfileSettings(adb = null)), emptyMap(), emptySet(), own).clearRestrictions)
    }

    @Test
    fun kioskResolvesStartAppByAppId() {
        val p = ConfigPlanner.plan(cfg(ProfileSettings(kiosk = true, startApp = "app1"), listOf(app("app1", "hr.pos.app"))), emptyMap(), emptySet(), own)
        assertTrue(p.kiosk.enabled)
        assertEquals("hr.pos.app", p.kiosk.startPackage)
        assertTrue(p.statusBarDisabled)
        assertTrue(Restriction.SAFE_BOOT in p.addRestrictions)
        // paket kao startApp
        assertEquals("com.x.y", ConfigPlanner.resolveStartApp("com.x.y", emptyList()))
        assertNull(ConfigPlanner.resolveStartApp("  ", emptyList()))
    }

    @Test
    fun installsUpdatesAndRemovals() {
        val apps = listOf(
            app("a", "hr.a", vc = 10), // nije instalirana → install
            app("b", "hr.b", vc = 10), // starija instalirana → update
            app("c", "hr.c", vc = 10), // ista verzija → ništa
            app("d", "hr.d", remove = true), // instalirana → ukloni
            app("e", "hr.e", remove = true), // nije instalirana → ništa
            app("f", "hr.f", download = false), // nema datoteke → ništa
            app("g", "hr.g", vc = null), // instalirana, nepoznata verzija → ništa
            app("own", own, vc = 99, remove = true), // agent se nikad ne uklanja
        )
        val installed = mapOf("hr.b" to 5L, "hr.c" to 10L, "hr.d" to 1L, "hr.g" to 3L, own to 1L)
        val p = ConfigPlanner.plan(cfg(ProfileSettings(), apps), installed, emptySet(), own)
        assertEquals(listOf("hr.a" to "install", "hr.b" to "update"), p.installs.map { it.app.packageName to it.reason })
        assertEquals(listOf("hr.d"), p.removals)
    }

    @Test
    fun agentSelfUpdate() {
        val p = ConfigPlanner.plan(cfg(ProfileSettings(), listOf(app("own", own, vc = 5))), mapOf(own to 4L), emptySet(), own)
        assertEquals(listOf(own), p.installs.map { it.app.packageName })
    }

    @Test
    fun hiddenAppsAndUnhide() {
        val apps = listOf(app("a", "hr.a", hidden = true), app("b", "hr.b", config = mapOf("server" to "https://x")), app("own", own, hidden = true))
        val p = ConfigPlanner.plan(cfg(ProfileSettings(), apps), emptyMap(), setOf("hr.old", "hr.a"), own)
        assertEquals(setOf("hr.a"), p.hide)
        assertEquals(setOf("hr.old"), p.unhide)
        assertEquals(mapOf("hr.b" to mapOf("server" to "https://x")), p.appRestrictions)
    }

    @Test
    fun wifiValidationAndSystemSettings() {
        val s = ProfileSettings(
            wifi = listOf(
                WifiNetwork("Ok", WifiSecurity.WPA2, "12345678", false),
                WifiNetwork("Short", WifiSecurity.WPA2, "123", false),
                WifiNetwork("Open", WifiSecurity.NONE, null, false),
            ),
            screenTimeoutSec = 5,
            volumePct = 150,
            timezone = "Europe/Zagreb",
            systemUpdates = SystemUpdates.POSTPONE,
        )
        val p = ConfigPlanner.plan(cfg(s), emptyMap(), emptySet(), own)
        assertEquals(listOf("Ok", "Open"), p.wifi.map { it.ssid })
        assertEquals(listOf("Short"), p.skippedWifi)
        assertEquals(10_000, p.screenTimeoutMs)
        assertEquals(100, p.volumePct)
        assertEquals("Europe/Zagreb", p.timezone)
        assertEquals(SystemUpdates.POSTPONE, p.systemUpdates)
    }
}
