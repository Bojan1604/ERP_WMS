package hr.erpwms.mdm.agent.provisioning

import android.Manifest
import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import hr.erpwms.mdm.agent.AdminReceiver
import hr.erpwms.mdm.agent.AgentLog
import hr.erpwms.mdm.agent.AgentService
import hr.erpwms.mdm.agent.Prefs
import hr.erpwms.mdm.agent.core.UrlPolicy

object Provisioning {
    /**
     * Admin extras iz QR koda: {"server": "https://…", "enrollToken": "…"}.
     * (Prihvaćaju se i "serverUrl"/"token".)
     */
    fun storeExtras(ctx: Context, extras: PersistableBundle?) {
        if (extras == null) return
        val server = extras.getString("server") ?: extras.getString("serverUrl")
        val token = extras.getString("enrollToken") ?: extras.getString("token")
        val prefs = Prefs(ctx)
        if (!server.isNullOrBlank()) {
            val s = UrlPolicy.normalize(server)
            if (UrlPolicy.isAllowed(s)) {
                if (prefs.server != s) prefs.clearCredentials()
                prefs.server = s
            } else {
                AgentLog.e("provisioning", "Adresa poslužitelja iz QR koda nije dopuštena: $s")
            }
        }
        if (!token.isNullOrBlank()) prefs.enrollToken = token
        AgentLog.i("provisioning", "Postavke iz provisioninga spremljene (poslužitelj: ${prefs.server})", report = true)
    }

    /** Nakon što je agent postao Device Owner: dozvole i pokretanje servisa. */
    fun onProvisioned(ctx: Context) {
        grantPermissions(ctx)
        AgentService.start(ctx)
    }

    fun grantPermissions(ctx: Context) {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        if (!dpm.isDeviceOwnerApp(ctx.packageName)) return
        val admin = AdminReceiver.component(ctx)
        val perms = mutableListOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= 29) perms += Manifest.permission.ACCESS_BACKGROUND_LOCATION
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        if (Build.VERSION.SDK_INT <= 28) perms += Manifest.permission.WRITE_EXTERNAL_STORAGE
        for (p in perms) {
            runCatching {
                dpm.setPermissionGrantState(admin, ctx.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
            }.onFailure { AgentLog.w("provisioning", "Dozvola $p nije dodijeljena", it) }
        }
    }

    @Suppress("DEPRECATION")
    fun extrasFrom(intent: Intent?): PersistableBundle? =
        intent?.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
}

/** Android 12+: sustav pita koji način provisioninga agent želi → potpuno upravljani uređaj. */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val extras = Provisioning.extrasFrom(intent)
        Provisioning.storeExtras(this, extras)
        val result = Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE)
        if (extras != null) result.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, extras)
        setResult(RESULT_OK, result)
        finish()
    }
}

/** Android 12+: posljednji korak provisioninga — agent primjenjuje početne postavke. */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Provisioning.storeExtras(this, Provisioning.extrasFrom(intent))
        Provisioning.onProvisioned(this)
        setResult(RESULT_OK)
        finish()
    }
}
