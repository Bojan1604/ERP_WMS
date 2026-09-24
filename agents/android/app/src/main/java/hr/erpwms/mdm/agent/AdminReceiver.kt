package hr.erpwms.mdm.agent

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import hr.erpwms.mdm.agent.provisioning.Provisioning
import hr.erpwms.mdm.agent.ui.MainActivity

/**
 * Komponenta administratora uređaja. QR s portala navodi
 * `hr.erpwms.mdm.agent/.AdminReceiver` kao PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME.
 */
class AdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        AgentLog.i("admin", "Administrator uređaja uključen")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        AgentLog.w("admin", "Administrator uređaja isključen")
    }

    /** Stari tok (Android 8–11) i završetak provisioninga na novijima. */
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        @Suppress("DEPRECATION")
        val extras = intent.getParcelableExtra<PersistableBundle>(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        Provisioning.storeExtras(context, extras)
        Provisioning.onProvisioned(context)
        runCatching {
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    companion object {
        fun component(ctx: Context) = ComponentName(ctx.applicationContext, AdminReceiver::class.java)
    }
}
