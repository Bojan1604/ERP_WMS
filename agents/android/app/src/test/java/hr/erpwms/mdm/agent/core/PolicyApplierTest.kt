package hr.erpwms.mdm.agent.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyApplierTest {
    private class Fake(override val isDeviceOwner: Boolean = true) : DeviceControl {
        val calls = ArrayList<String>()
        val restrictions = HashSet<String>()
        var failInstall = false
        override val ownPackage = "hr.erpwms.mdm.agent"
        override fun installedPackages() = emptyMap<String, Long>()
        override fun setRestriction(key: String, enabled: Boolean) {
            calls += "restr $key $enabled"
            if (enabled) restrictions += key else restrictions -= key
        }
        override fun setCameraDisabled(disabled: Boolean) { calls += "camera $disabled" }
        override fun setStatusBarDisabled(disabled: Boolean) { calls += "statusbar $disabled" }
        override fun setHidden(packageName: String, hidden: Boolean): Boolean { calls += "hidden $packageName $hidden"; return packageName != "missing" }
        override fun setAppRestrictions(packageName: String, values: Map<String, String>) { calls += "appcfg $packageName" }
        override fun install(app: ResolvedApp) {
            calls += "install ${app.packageName} blocked=${Restriction.INSTALL_APPS in restrictions}"
            if (failInstall) throw IllegalStateException("boom")
        }
        override fun uninstall(packageName: String) { calls += "uninstall $packageName" }
        override fun addWifi(net: WifiNetwork) { calls += "wifi ${net.ssid}" }
        override fun setScreenTimeout(ms: Int) { calls += "timeout $ms" }
        override fun setTimeZone(tz: String) { calls += "tz $tz" }
        override fun setVolume(pct: Int) { calls += "volume $pct" }
        override fun setSystemUpdates(mode: SystemUpdates?) { calls += "updates $mode" }
        override fun setKiosk(enabled: Boolean, startPackage: String?) { calls += "kiosk $enabled $startPackage" }
    }

    private val sha = "ef".repeat(32)
    private fun plan(s: ProfileSettings, apps: List<ResolvedApp> = emptyList(), hidden: Set<String> = emptySet()) =
        ConfigPlanner.plan(EffectiveConfig(1, s, apps), emptyMap(), hidden, "hr.erpwms.mdm.agent")

    @Test
    fun installsBeforeRestrictingAndKioskLast() {
        val f = Fake()
        f.restrictions += Restriction.INSTALL_APPS // već zabranjeno od prije
        val apps = listOf(ResolvedApp("a", "hr.pos", "POS", "1", 1, "/f", sha, emptyMap(), false, false, false))
        val r = PolicyApplier(f).apply(plan(ProfileSettings(kiosk = true, startApp = "a", restrictions = Restrictions(noInstallApps = true)), apps), emptySet())
        assertTrue(r.errors.toString(), r.ok)
        assertTrue("install hr.pos blocked=false" in f.calls)
        val installAt = f.calls.indexOf("install hr.pos blocked=false")
        val restrictAt = f.calls.indexOf("restr ${Restriction.INSTALL_APPS} true")
        assertTrue(installAt in 0 until restrictAt)
        assertEquals("kiosk true hr.pos", f.calls.last())
        assertTrue(Restriction.INSTALL_APPS in f.restrictions)
    }

    @Test
    fun errorsAreCollectedAndDoNotStopOtherSteps() {
        val f = Fake().apply { failInstall = true }
        val apps = listOf(
            ResolvedApp("a", "hr.pos", "POS", "1", 1, "/f", sha, emptyMap(), false, false, false),
            ResolvedApp("m", "missing", null, null, null, null, null, emptyMap(), true, false, false),
        )
        val r = PolicyApplier(f).apply(plan(ProfileSettings(timezone = "Europe/Zagreb"), apps, hidden = setOf("hr.old")), setOf("hr.old"))
        assertFalse(r.ok)
        assertEquals(2, r.errors.size) // instalacija + skrivanje nepostojećeg paketa
        assertTrue("tz Europe/Zagreb" in f.calls)
        assertTrue("hidden hr.old false" in f.calls)
        assertEquals(emptySet<String>(), r.hidden)
    }

    @Test
    fun notDeviceOwnerDoesNothing() {
        val f = Fake(isDeviceOwner = false)
        val r = PolicyApplier(f).apply(plan(ProfileSettings(kiosk = true)), setOf("x"))
        assertFalse(r.ok)
        assertTrue(f.calls.isEmpty())
        assertEquals(setOf("x"), r.hidden)
    }
}
