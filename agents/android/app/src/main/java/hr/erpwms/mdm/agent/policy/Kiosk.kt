package hr.erpwms.mdm.agent.policy

import android.app.ActivityOptions
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import hr.erpwms.mdm.agent.AdminReceiver
import hr.erpwms.mdm.agent.AgentLog
import hr.erpwms.mdm.agent.Prefs
import hr.erpwms.mdm.agent.ui.KioskActivity

/**
 * Zaključani način: agent postaje trajni početni zaslon (HOME) i pokreće
 * zadanu aplikaciju u lock task načinu. Izlaz: servisni PIN na zaslonu agenta.
 */
object Kiosk {
    /** Servisni izlaz (PIN) vrijedi do ponovnog pokretanja ili nove konfiguracije. */
    @Volatile var suspended = false

    fun set(ctx: Context, enabled: Boolean, startPackage: String?) {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = AdminReceiver.component(ctx)
        val prefs = Prefs(ctx)
        val home = ComponentName(ctx, KioskActivity::class.java)
        if (!dpm.isDeviceOwnerApp(ctx.packageName)) throw IllegalStateException("Kiosk traži Device Owner")
        if (enabled) {
            val pkgs = listOfNotNull(ctx.packageName, startPackage).distinct().toTypedArray()
            dpm.setLockTaskPackages(admin, pkgs)
            if (Build.VERSION.SDK_INT >= 28) {
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS)
            }
            ctx.packageManager.setComponentEnabledSetting(home, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            val filter = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            dpm.addPersistentPreferredActivity(admin, filter, home)
            val changed = !prefs.kioskEnabled || prefs.kioskPackage != startPackage
            prefs.kioskEnabled = true
            prefs.kioskPackage = startPackage
            suspended = false
            if (changed) launchHome(ctx)
            AgentLog.i("kiosk", "Kiosk uključen (${startPackage ?: "samo agent"})", report = changed)
        } else {
            val was = prefs.kioskEnabled
            prefs.kioskEnabled = false
            prefs.kioskPackage = null
            dpm.clearPackagePersistentPreferredActivities(admin, ctx.packageName)
            dpm.setLockTaskPackages(admin, emptyArray<String>())
            ctx.packageManager.setComponentEnabledSetting(home, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            if (was) AgentLog.i("kiosk", "Kiosk isključen", report = true)
        }
    }

    fun launchHome(ctx: Context) {
        runCatching {
            ctx.startActivity(Intent(ctx, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
        }.onFailure { AgentLog.w("kiosk", "Ne mogu otvoriti početni zaslon", it) }
    }

    /** Pokreće aplikaciju kiosk načina (u lock task načinu gdje je moguće). */
    fun launchStartApp(ctx: Context, pkg: String): Boolean {
        val intent = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            if (Build.VERSION.SDK_INT >= 28) {
                val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
                if (dpm.isLockTaskPermitted(pkg)) {
                    ctx.startActivity(intent, ActivityOptions.makeBasic().setLockTaskEnabled(true).toBundle())
                    return true
                }
            }
            ctx.startActivity(intent)
            true
        } catch (e: Exception) {
            AgentLog.w("kiosk", "Pokretanje $pkg nije uspjelo", e)
            false
        }
    }
}
