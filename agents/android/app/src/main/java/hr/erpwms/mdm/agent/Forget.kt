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

    fun run(ctx: Context) {
        AgentLog.w("forget", "Uređaj odjavljen (FORGET)")
        cleanup(ctx, removeOwner = true)
        val prefs = Prefs(ctx)
        prefs.clearCredentials()
        prefs.status = "FORGOTTEN"
        AgentService.stop(ctx)
    }
}
