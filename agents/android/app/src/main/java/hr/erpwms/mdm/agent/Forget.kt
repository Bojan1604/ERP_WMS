package hr.erpwms.mdm.agent

import android.app.admin.DevicePolicyManager
import hr.erpwms.mdm.agent.core.Restriction
import hr.erpwms.mdm.agent.policy.Kiosk
import android.content.Context

/** FORGET: uklanja sve mjere agenta, briše vjerodajnice i odriče se vlasništva nad uređajem. */
object Forget {
    fun cleanup(ctx: Context, removeOwner: Boolean) {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = AdminReceiver.component(ctx)
        val prefs = Prefs(ctx)
        if (dpm.isDeviceOwnerApp(ctx.packageName)) {
            runCatching { Kiosk.set(ctx, false, null) }
            Restriction.MANAGED.forEach { r -> runCatching { dpm.clearUserRestriction(admin, r) } }
            runCatching { dpm.setCameraDisabled(admin, false) }
            runCatching { dpm.setStatusBarDisabled(admin, false) }
            runCatching { dpm.setSystemUpdatePolicy(admin, null) }
            prefs.hiddenPackages.forEach { p -> runCatching { dpm.setApplicationHidden(admin, p, false) } }
            prefs.hiddenPackages = emptySet()
            if (removeOwner) {
                AgentLog.w("forget", "Agent se odriče vlasništva nad uređajem")
                runCatching { dpm.clearDeviceOwnerApp(ctx.packageName) }.onFailure { AgentLog.e("forget", "clearDeviceOwnerApp", it) }
            }
        } else if (removeOwner && dpm.isAdminActive(admin)) {
            runCatching { dpm.removeActiveAdmin(admin) }
        }
    }

    /** FORGET i HTTP 410 (§9): isto čišćenje; agent se više ne javlja dok se ponovno ne postavi. */
    fun run(ctx: Context, finalStatus: String = "FORGOTTEN") {
        AgentLog.w("forget", "Uređaj odjavljen ($finalStatus)")
        cleanup(ctx, removeOwner = true)
        val prefs = Prefs(ctx)
        prefs.clearCredentials()
        prefs.status = finalStatus
        AgentService.stop(ctx)
    }
}
