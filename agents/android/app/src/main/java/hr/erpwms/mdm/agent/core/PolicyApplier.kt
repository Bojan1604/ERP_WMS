package hr.erpwms.mdm.agent.core

/**
 * Tanko sučelje prema DevicePolicyManageru i ostatku sustava — stvarna
 * implementacija je [hr.erpwms.mdm.agent.policy.AndroidDeviceControl], a u
 * testovima se koristi lažna.
 */
interface DeviceControl {
    val isDeviceOwner: Boolean
    val ownPackage: String
    fun installedPackages(): Map<String, Long>
    fun setRestriction(key: String, enabled: Boolean)
    fun setCameraDisabled(disabled: Boolean)
    fun setStatusBarDisabled(disabled: Boolean)
    fun setHidden(packageName: String, hidden: Boolean): Boolean
    fun setAppRestrictions(packageName: String, values: Map<String, String>)
    /** Preuzima i tiho instalira; baca iznimku s razlogom pri neuspjehu. */
    fun install(app: ResolvedApp)
    fun uninstall(packageName: String)
    fun addWifi(net: WifiNetwork)
    fun setScreenTimeout(ms: Int)
    fun setTimeZone(tz: String)
    fun setVolume(pct: Int)
    fun setSystemUpdates(mode: SystemUpdates?)
    fun setKiosk(enabled: Boolean, startPackage: String?)
}

data class ApplyReport(val actions: List<String>, val errors: List<String>, val hidden: Set<String>) {
    val ok get() = errors.isEmpty()
}

/** Provodi [PolicyPlan] redom koji izbjegava sukobe (npr. instalacija prije zabrane instalacije). */
class PolicyApplier(private val ctl: DeviceControl) {

    fun apply(plan: PolicyPlan, previouslyHidden: Set<String>): ApplyReport {
        val actions = ArrayList<String>()
        val errors = ArrayList<String>()
        fun step(name: String, block: () -> Unit) {
            try {
                block()
                actions += name
            } catch (e: Exception) {
                errors += "$name: ${e.message ?: e.javaClass.simpleName}"
            }
        }

        if (!ctl.isDeviceOwner) {
            errors += "Agent nije vlasnik uređaja (Device Owner) — restrikcije, kiosk i tiha instalacija nisu mogući"
            return ApplyReport(actions, errors, previouslyHidden)
        }

        // 1) skini restrikcije koje više ne vrijede + privremeno dopusti (de)instalaciju
        plan.clearRestrictions.forEach { r -> step("clear $r") { ctl.setRestriction(r, false) } }
        val installBlockers = listOf(Restriction.INSTALL_APPS, Restriction.UNINSTALL_APPS).filter { it in plan.addRestrictions }
        val needsPackages = plan.installs.isNotEmpty() || plan.removals.isNotEmpty()
        if (needsPackages) installBlockers.forEach { r -> step("temp-clear $r") { ctl.setRestriction(r, false) } }

        // 2) aplikacije
        plan.removals.forEach { p -> step("uninstall $p") { ctl.uninstall(p) } }
        plan.installs.forEach { i -> step("${i.reason} ${i.app.packageName} ${i.app.version ?: ""}".trim()) { ctl.install(i.app) } }

        // 3) restrikcije i hardver
        plan.addRestrictions.forEach { r -> step("add $r") { ctl.setRestriction(r, true) } }
        step("camera ${if (plan.cameraDisabled) "off" else "on"}") { ctl.setCameraDisabled(plan.cameraDisabled) }
        step("statusbar ${if (plan.statusBarDisabled) "off" else "on"}") { ctl.setStatusBarDisabled(plan.statusBarDisabled) }

        // 4) skrivene aplikacije i postavke aplikacija
        val hidden = LinkedHashSet(previouslyHidden)
        plan.unhide.forEach { p -> step("unhide $p") { ctl.setHidden(p, false); hidden -= p } }
        plan.hide.forEach { p ->
            step("hide $p") {
                if (ctl.setHidden(p, true)) hidden += p else throw IllegalStateException("paket nije pronađen")
            }
        }
        plan.appRestrictions.forEach { (p, v) -> step("appconfig $p") { ctl.setAppRestrictions(p, v) } }

        // 5) mreža i sustav
        plan.wifi.forEach { w -> step("wifi ${w.ssid}") { ctl.addWifi(w) } }
        plan.skippedWifi.forEach { s -> errors += "wifi $s: neispravan SSID ili lozinka (8–63 znaka)" }
        plan.screenTimeoutMs?.let { ms -> step("screen-timeout $ms") { ctl.setScreenTimeout(ms) } }
        plan.timezone?.let { tz -> step("timezone $tz") { ctl.setTimeZone(tz) } }
        plan.volumePct?.let { v -> step("volume $v") { ctl.setVolume(v) } }
        step("system-updates ${plan.systemUpdates ?: "default"}") { ctl.setSystemUpdates(plan.systemUpdates) }

        // 6) kiosk na kraju — početna aplikacija je sada instalirana
        step("kiosk ${if (plan.kiosk.enabled) "on ${plan.kiosk.startPackage ?: ""}".trim() else "off"}") {
            ctl.setKiosk(plan.kiosk.enabled, plan.kiosk.startPackage)
        }
        return ApplyReport(actions, errors, hidden)
    }
}
