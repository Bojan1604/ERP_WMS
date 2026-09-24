package hr.erpwms.mdm.agent

import android.content.Context
import android.provider.Settings
import hr.erpwms.mdm.agent.core.AgentCommand
import hr.erpwms.mdm.agent.core.Backoff
import hr.erpwms.mdm.agent.core.ConfigPlanner
import hr.erpwms.mdm.agent.core.DeviceStatus
import hr.erpwms.mdm.agent.core.EffectiveConfig
import hr.erpwms.mdm.agent.core.PolicyApplier
import hr.erpwms.mdm.agent.core.Requests
import hr.erpwms.mdm.agent.policy.AndroidDeviceControl
import hr.erpwms.mdm.agent.policy.Kiosk
import org.json.JSONObject

/**
 * Jedan ciklus agenta: prijava (ako treba) → javljanje s telemetrijom →
 * primjena konfiguracije → izvršavanje naredbi. Vraća broj sekundi do
 * sljedećeg javljanja.
 */
class Agent(context: Context) {
    private val ctx = context.applicationContext
    private val prefs = Prefs(ctx)

    fun api(): ApiClient = ApiClient(prefs.server ?: throw IllegalStateException("Poslužitelj nije postavljen"), prefs.token)

    fun control() = AndroidDeviceControl(ctx) { api() }

    @Synchronized
    fun runOnce(): Int {
        if (prefs.status == "RETIRED" || prefs.status == "FORGOTTEN") return -1
        val server = prefs.server
        if (server.isNullOrBlank()) {
            prefs.lastError = "Poslužitelj nije postavljen (Postavke agenta)"
            return 300
        }
        return try {
            if (prefs.token == null) register()
            checkin()
            prefs.failures = 0
            prefs.lastError = null
            prefs.checkinSec
        } catch (e: RetiredException) {
            AgentLog.w("agent", "Poslužitelj javlja da je uređaj uklonjen (410)")
            retired()
            -1
        } catch (e: Exception) {
            val f = prefs.failures + 1
            prefs.failures = f
            prefs.lastError = e.message ?: e.javaClass.simpleName
            AgentLog.w("agent", "Javljanje nije uspjelo (#$f)", e)
            Backoff.delaySec(prefs.checkinSec, f)
        }
    }

    private fun register() {
        val body = Requests.register(
            platform = "ANDROID",
            enrollToken = prefs.enrollToken,
            hardwareId = TelemetryCollector.hardwareId(ctx),
            serial = TelemetryCollector.serial(),
            manufacturer = android.os.Build.MANUFACTURER,
            model = android.os.Build.MODEL,
            osVersion = TelemetryCollector.osVersion(),
            agentVersion = BuildConfig.VERSION_NAME,
            name = runCatching { Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull(),
        )
        val r = ApiClient(prefs.server!!, null).register(body)
        prefs.deviceId = r.deviceId
        prefs.token = r.token
        prefs.status = r.status.name
        prefs.enrollCode = r.enrollCode
        prefs.checkinSec = r.checkinSec
        AgentLog.i("agent", "Prijavljen na poslužitelj (${r.status}${r.enrollCode?.let { ", kod $it" } ?: ""})", report = true)
    }

    private fun checkin() {
        val events = AgentLog.drainEvents()
        val tel = TelemetryCollector.collect(ctx)
        val body = Requests.checkin(tel, prefs.appliedConfigVersion, events)
        val r = try {
            api().checkin(body)
        } catch (e: Exception) {
            AgentLog.requeue(events)
            throw e
        }
        prefs.lastCheckinAt = System.currentTimeMillis()
        prefs.checkinSec = r.checkinSec
        prefs.enrollCode = r.enrollCode
        r.deviceName?.let { prefs.deviceName = it }
        val was = prefs.status
        prefs.status = r.status.name
        if (r.status == DeviceStatus.RETIRED) throw RetiredException()
        if (was != r.status.name && r.status == DeviceStatus.ENROLLED) AgentLog.i("agent", "Uređaj je upisan: ${r.deviceName}", report = true)

        r.config?.let {
            applyConfig(it)
            prefs.lastConfig = r.configJson
        }
        for (cmd in r.commands) runCommand(cmd)
    }

    /** Primjenjuje konfiguraciju i pamti je (servisni PIN, kiosk nakon ponovnog pokretanja). */
    fun applyConfig(cfg: EffectiveConfig) {
        AgentLog.i("config", "Primjenjujem konfiguraciju v${cfg.version}")
        prefs.maintenancePin = cfg.settings.maintenancePin
        val control = control()
        Kiosk.suspended = false
        val plan = ConfigPlanner.plan(cfg, control.installedPackages(), prefs.hiddenPackages, ctx.packageName)
        val report = PolicyApplier(control).apply(plan, prefs.hiddenPackages)
        prefs.hiddenPackages = report.hidden
        prefs.appliedConfigVersion = cfg.version
        if (report.ok) AgentLog.i("config", "Konfiguracija v${cfg.version} primijenjena (${report.actions.size} koraka)", report = true)
        else report.errors.forEach { AgentLog.w("config", "v${cfg.version}: $it") }
    }

    private fun runCommand(cmd: AgentCommand) {
        AgentLog.i("command", "Naredba ${cmd.type} (${cmd.id})")
        val out = try {
            CommandExecutor(ctx, this).execute(cmd)
        } catch (e: Exception) {
            CommandOutcome.fail(e.message ?: e.javaClass.simpleName)
        }
        if (out.deferred) return
        try {
            api().commandResult(cmd.id, Requests.commandResult(out.ok, out.error, out.result))
        } catch (e: RetiredException) {
            throw e
        } catch (e: Exception) {
            AgentLog.w("command", "Rezultat naredbe ${cmd.id} nije poslan", e)
        }
        if (!out.ok) AgentLog.w("command", "${cmd.type} nije uspjela: ${out.error}")
        out.after?.let { runCatching(it).onFailure { e -> AgentLog.e("command", "${cmd.type}: ${e.message}", e) } }
    }

    /** Rezultat odgođene naredbe (npr. snimka zaslona nakon pristanka korisnika). */
    fun reportLater(commandId: String, ok: Boolean, error: String?, result: JSONObject?) {
        Thread {
            runCatching { api().commandResult(commandId, Requests.commandResult(ok, error, result)) }
                .onFailure { AgentLog.w("command", "Rezultat naredbe $commandId nije poslan", it) }
        }.start()
    }

    private fun retired() {
        runCatching { Forget.cleanup(ctx, removeOwner = false) }
        prefs.clearCredentials()
        prefs.status = "RETIRED"
        AgentService.stop(ctx)
    }
}
