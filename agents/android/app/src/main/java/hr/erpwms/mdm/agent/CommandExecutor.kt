package hr.erpwms.mdm.agent

import android.app.admin.DevicePolicyManager
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.UserManager
import android.provider.MediaStore
import hr.erpwms.mdm.agent.core.AgentCommand
import hr.erpwms.mdm.agent.core.ConfigPlanner
import hr.erpwms.mdm.agent.core.EffectiveConfig
import hr.erpwms.mdm.agent.core.Payloads
import hr.erpwms.mdm.agent.core.Restriction
import hr.erpwms.mdm.agent.policy.Kiosk
import org.json.JSONObject
import java.io.File
import java.util.zip.GZIPOutputStream

/**
 * Ishod naredbe. [after] se izvršava NAKON slanja rezultata (REBOOT, WIPE,
 * FORGET — inače poslužitelj nikad ne bi saznao ishod). [deferred] = rezultat
 * šalje netko drugi kasnije (SCREENSHOT nakon pristanka korisnika).
 */
data class CommandOutcome(
    val ok: Boolean,
    val error: String? = null,
    val result: JSONObject? = null,
    val after: (() -> Unit)? = null,
    val deferred: Boolean = false,
) {
    companion object {
        fun ok(result: JSONObject? = null, after: (() -> Unit)? = null) = CommandOutcome(true, null, result, after)
        fun fail(error: String) = CommandOutcome(false, error)
        val DEFERRED = CommandOutcome(true, deferred = true)
    }
}

class CommandExecutor(private val ctx: Context, private val agent: Agent) {
    private val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
    private val admin = AdminReceiver.component(ctx)
    private val prefs = Prefs(ctx)
    private val owner get() = dpm.isDeviceOwnerApp(ctx.packageName)

    private fun needOwner(what: String) {
        if (!owner) throw IllegalStateException("$what traži da je agent vlasnik uređaja (Device Owner / QR upis)")
    }

    fun execute(cmd: AgentCommand): CommandOutcome {
        val p = cmd.payload
        return when (cmd.type) {
            "REBOOT" -> {
                needOwner("Ponovno pokretanje")
                CommandOutcome.ok(after = { Thread.sleep(2000); dpm.reboot(admin) })
            }
            "LOCK" -> {
                if (!dpm.isAdminActive(admin)) return CommandOutcome.fail("Agent nije administrator uređaja")
                dpm.lockNow()
                CommandOutcome.ok()
            }
            "WIPE" -> {
                needOwner("Brisanje uređaja")
                CommandOutcome.ok(after = {
                    Thread.sleep(2000)
                    if (Build.VERSION.SDK_INT >= 34) dpm.wipeDevice(0) else dpm.wipeData(0)
                })
            }
            "APPLY_CONFIG" -> {
                // ponovno primijeni zadnju poznatu i zatraži svježu pri sljedećem javljanju
                val last = prefs.lastConfig
                prefs.appliedConfigVersion = 0
                if (last != null) agent.applyConfig(EffectiveConfig.parse(JSONObject(last)))
                CommandOutcome.ok(JSONObject().put("reapplied", last != null))
            }
            "INSTALL_APP" -> installApp(p)
            "UNINSTALL_APP" -> {
                val pkg = Payloads.uninstallApp(p)
                withPackageRestrictionLifted(Restriction.UNINSTALL_APPS) { agent.control().uninstall(pkg) }
                CommandOutcome.ok(JSONObject().put("packageName", pkg))
            }
            "SCREENSHOT" -> {
                ScreenCapture.request(ctx, cmd.id)
                CommandOutcome.DEFERRED
            }
            "UPLOAD_LOGS" -> uploadLogs(cmd.id)
            "MESSAGE" -> {
                Notifier.showMessage(ctx, Payloads.message(p))
                CommandOutcome.ok()
            }
            "PUSH_FILE" -> pushFile(p)
            "RUN_SCRIPT" -> CommandOutcome.fail("RUN_SCRIPT nije podržan na Androidu")
            "SET_KIOSK" -> {
                needOwner("Kiosk")
                val k = Payloads.kiosk(p)
                val pkg = k.packageName ?: prefs.kioskPackage ?: prefs.lastConfig?.let {
                    val c = EffectiveConfig.parse(JSONObject(it))
                    ConfigPlanner.resolveStartApp(c.settings.startApp, c.apps)
                }
                Kiosk.suspended = false
                Kiosk.set(ctx, k.enabled, pkg)
                CommandOutcome.ok(JSONObject().put("enabled", k.enabled).put("packageName", pkg ?: JSONObject.NULL))
            }
            "FORGET" -> CommandOutcome.ok(after = { Forget.run(ctx) })
            else -> CommandOutcome.fail("Nepoznata naredba: ${cmd.type}")
        }
    }

    private fun installApp(p: JSONObject): CommandOutcome {
        val a = Payloads.installApp(p)
        if (a.packageName == ctx.packageName && !owner) return CommandOutcome.fail("Samoažuriranje traži Device Owner")
        withPackageRestrictionLifted(Restriction.INSTALL_APPS) {
            agent.control().installFromServer(a.packageName, a.downloadPath, a.sha256)
        }
        val installed = agent.control().installedPackages()[a.packageName]
        return CommandOutcome.ok(JSONObject().put("packageName", a.packageName).put("versionCode", installed ?: JSONObject.NULL))
    }

    /** DISALLOW_INSTALL_APPS zabranjuje instalaciju i samom Device Owneru — privremeno se skida. */
    private fun withPackageRestrictionLifted(key: String, block: () -> Unit) {
        val um = ctx.getSystemService(UserManager::class.java)
        val had = owner && um.userRestrictions.getBoolean(key, false)
        if (had) dpm.clearUserRestriction(admin, key)
        try {
            block()
        } finally {
            if (had) dpm.addUserRestriction(admin, key)
        }
    }

    private fun uploadLogs(commandId: String): CommandOutcome {
        val out = File(ctx.cacheDir, "logs-${System.currentTimeMillis()}.txt.gz")
        try {
            GZIPOutputStream(out.outputStream()).bufferedWriter().use { w ->
                w.write("ERP/WMS MDM agent ${BuildConfig.VERSION_NAME}\n")
                w.write("Uređaj: ${Build.MANUFACTURER} ${Build.MODEL}, ${TelemetryCollector.osVersion()}, patch ${Build.VERSION.SECURITY_PATCH}\n")
                w.write("Device Owner: $owner, status: ${prefs.status}, kiosk: ${prefs.kioskEnabled}\n\n")
                for (f in AgentLog.logFiles()) {
                    w.write("===== ${f.name} =====\n")
                    f.bufferedReader().use { it.copyTo(w) }
                }
                w.write("\n===== logcat (proces agenta) =====\n")
                try {
                    val proc = ProcessBuilder("logcat", "-d", "-v", "time", "--pid=${android.os.Process.myPid()}")
                        .redirectErrorStream(true).start()
                    proc.inputStream.bufferedReader().use { r ->
                        r.lineSequence().toList().takeLast(5000).forEach { w.write(it); w.write("\n") }
                    }
                    proc.waitFor()
                } catch (e: Exception) {
                    w.write("logcat nije dostupan: ${e.message}\n")
                }
            }
            val resp = agent.api().upload("LOGS", commandId, out, "application/gzip", "agent-logs.txt.gz")
            return CommandOutcome.ok(resp)
        } finally {
            out.delete()
        }
    }

    private fun pushFile(p: JSONObject): CommandOutcome {
        val f = Payloads.pushFile(p)
        val tmp = File(ctx.cacheDir, "push-${System.currentTimeMillis()}")
        try {
            agent.api().download(f.downloadPath, tmp, f.sha256)
            val sub = f.targetPath?.split('/', '\\')?.map { it.trim() }?.filter { it.isNotEmpty() && it != "." && it != ".." }
                ?.map { Payloads.safeFileName(it) }?.joinToString("/")?.takeIf { it.isNotEmpty() }
            val location = if (Build.VERSION.SDK_INT >= 29) {
                val rel = Environment.DIRECTORY_DOWNLOADS + (sub?.let { "/$it" } ?: "")
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, f.name)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, rel)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val cr = ctx.contentResolver
                val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("MediaStore je odbio datoteku")
                cr.openOutputStream(uri)!!.use { o -> tmp.inputStream().use { it.copyTo(o) } }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                cr.update(uri, values, null, null)
                "$rel/${f.name}"
            } else {
                @Suppress("DEPRECATION")
                val base = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                val dir = if (sub != null) File(base, sub) else base
                dir.mkdirs()
                val dest = File(dir, f.name)
                tmp.copyTo(dest, overwrite = true)
                dest.absolutePath
            }
            AgentLog.i("file", "Datoteka spremljena: $location", report = true)
            return CommandOutcome.ok(JSONObject().put("path", location))
        } finally {
            tmp.delete()
        }
    }
}
