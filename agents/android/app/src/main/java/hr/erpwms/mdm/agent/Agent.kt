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
 * Jedan ciklus agenta (docs/mdm-agent-protocol.md): prijava (ako treba) ->
 * javljanje s telemetrijom -> primjena konfiguracije -> naredbe redom.
 * Vraća broj sekundi do sljedećeg javljanja (-1 = stani).
 */
class Agent(context: Context) {
    private val ctx = context.applicationContext
    private val prefs = Prefs(ctx)

    /** Konfiguracija iz trenutnog odgovora (APPLY_CONFIG je primjenjuje ponovno). */
    var currentConfig: EffectiveConfig? = null
        private set
    private var currentConfigJson: String? = null
    var appliedThisCycle = false
        private set

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
            val busy = checkin()
            prefs.failures = 0
            prefs.lastError = null
            // nakon naredbi/konfiguracije odmah ponovno (§4), inače redovni interval ±10 %
            if (busy) 2 else Backoff.jitter(prefs.checkinSec)
        } catch (e: RetiredException) {
            AgentLog.w("agent", "Poslužitelj javlja da je uređaj uklonjen (410) — čišćenje kao FORGET")
            Forget.run(ctx, finalStatus = "RETIRED")
            -1
        } catch (e: UnauthorizedException) {
            // token više ne vrijedi -> nova prijava, najviše jednom u minuti (§9)
            AgentLog.w("agent", "Token ne vrijedi (401) — ponovna prijava")
            prefs.token = null
            prefs.lastError = e.message
            val f = prefs.failures + 1
            prefs.failures = f
            maxOf(60, Backoff.delaySec(prefs.checkinSec, f))
        } catch (e: Exception) {
            val f = prefs.failures + 1
            prefs.failures = f
            prefs.lastError = e.message ?: e.javaClass.simpleName
            AgentLog.w("agent", "Javljanje nije uspjelo (#$f)", e)
            (e as? HttpException)?.retryAfterSec ?: Backoff.delaySec(prefs.checkinSec, f)
        }
    }

    private fun registerBody(token: String?) = Requests.register(
        platform = "ANDROID",
        enrollToken = token,
        hardwareId = TelemetryCollector.hardwareId(ctx),
        serial = TelemetryCollector.serial(),
        manufacturer = android.os.Build.MANUFACTURER,
        model = android.os.Build.MODEL,
        osVersion = TelemetryCollector.osVersion(),
        agentVersion = BuildConfig.VERSION_NAME,
        name = runCatching { Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull(),
    )

    private fun register() {
        val client = ApiClient(prefs.server!!, null)
        val r = try {
            client.register(registerBody(prefs.enrollToken))
        } catch (e: HttpException) {
            if (e.code != 403 || prefs.enrollToken == null) throw e
            // ključ upisa istekao/potrošen -> upis kodom (§3)
            AgentLog.e("agent", "Ključ upisa ne vrijedi (${e.message}) — prijava bez ključa, upis kodom")
            prefs.enrollToken = null
            client.register(registerBody(null))
        }
        prefs.deviceId = r.deviceId
        prefs.token = r.token
        prefs.status = r.status.name
        prefs.enrollCode = r.enrollCode
        prefs.checkinSec = r.checkinSec
        prefs.appliedConfigVersion = 0
        AgentLog.i("agent", "Prijavljen na poslužitelj (${r.status}${r.enrollCode?.let { ", kod $it" } ?: ""})", report = true)
    }

    /** @return true ako je bilo posla (konfiguracija ili naredbe) — tada se javlja odmah ponovno. */
    private fun checkin(): Boolean {
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

        currentConfig = r.config
        currentConfigJson = r.configJson
        appliedThisCycle = false
        var busy = false
        val cfg = r.config
        // APPLY_CONFIG u istom odgovoru primjenjuje konfiguraciju i kad je verzija ista
        val forced = r.commands.any { it.type == "APPLY_CONFIG" }
        if (cfg != null && (cfg.version != prefs.appliedConfigVersion || forced)) {
            busy = applyConfig(cfg, r.configJson)
            appliedThisCycle = true
        }
        val store = CommandStore(ctx)
        for (cmd in r.commands) {
            runCommand(cmd, store)
            busy = true
            if (prefs.status == "FORGOTTEN" || prefs.status == "RETIRED") break
        }
        return busy
    }

    /**
     * Primjenjuje konfiguraciju (§6). Verzija se bilježi samo kad je sve uspjelo; inače
     * poslužitelj šalje konfiguraciju ponovno pri svakom javljanju.
     * @return true ako je uspjelo
     */
    fun applyConfig(cfg: EffectiveConfig, json: String?): Boolean {
        AgentLog.i("config", "Primjenjujem konfiguraciju v${cfg.version}")
        prefs.maintenancePin = cfg.settings.maintenancePin
        if (json != null) prefs.lastConfig = json
        val control = control()
        Kiosk.suspended = false
        val plan = ConfigPlanner.plan(cfg, control.installedPackages(), prefs.hiddenPackages, ctx.packageName)
        val report = PolicyApplier(control).apply(plan, prefs.hiddenPackages)
        prefs.hiddenPackages = report.hidden
        cfg.apps.filter { !it.remove && it.downloadPath == null }.forEach {
            AgentLog.w("CONFIG", "Aplikacija ${it.packageName}: datoteka još nije učitana na poslužitelj — preskačem")
        }
        return if (report.ok) {
            prefs.appliedConfigVersion = cfg.version
            AgentLog.i("CONFIG", "Konfiguracija v${cfg.version} primijenjena (${report.actions.size} koraka)", report = true)
            true
        } else {
            AgentLog.e("CONFIG", "Konfiguracija v${cfg.version} nije potpuno primijenjena: " + report.errors.joinToString("; "))
            false
        }
    }

    /** APPLY_CONFIG: ponovno primijeni konfiguraciju iz ovog odgovora (ili zadnju poznatu). */
    fun reapplyConfig(): Int? {
        val cfg = currentConfig
        if (cfg != null) {
            if (!appliedThisCycle) {
                applyConfig(cfg, currentConfigJson)
                appliedThisCycle = true
            }
            return cfg.version
        }
        val last = prefs.lastConfig ?: return null
        val c = EffectiveConfig.parse(JSONObject(last))
        applyConfig(c, null)
        return c.version
    }

    private fun runCommand(cmd: AgentCommand, store: CommandStore) {
        // de-duplikacija po id-u (§5.1): gotova -> ponovno pošalji rezultat; u tijeku -> ignoriraj
        val prev = store.get(cmd.id)
        if (prev != null) {
            AgentLog.i("command", "Naredba ${cmd.id} već izvršena — ponovno šaljem rezultat")
            post(cmd, prev)
            return
        }
        if (store.isRunning(cmd.id)) return
        AgentLog.i("command", "Naredba ${cmd.type} (${cmd.id})")
        val payloadError = if (cmd.payload.has("error") && !cmd.payload.isNull("error")) cmd.payload.optString("error").takeIf { it.isNotBlank() } else null
        val out = try {
            if (payloadError != null) CommandOutcome.fail(payloadError) else CommandExecutor(ctx, this).execute(cmd)
        } catch (e: RetiredException) {
            throw e
        } catch (e: Exception) {
            CommandOutcome.fail(e.message ?: e.javaClass.simpleName)
        }
        if (out.deferred) {
            store.markRunning(cmd.id)
            return
        }
        val body = Requests.commandResult(out.ok, out.error, out.result ?: JSONObject())
        store.put(cmd.id, body)
        if (!out.ok) AgentLog.w("COMMAND", "${cmd.type} nije uspjela: ${out.error}")
        val sent = post(cmd, body)
        // REBOOT/WIPE/FORGET: tek nakon što je poslužitelj primio rezultat (§5.2)
        val after = out.after
        if (sent && after != null) {
            runCatching { after() }.onFailure { e -> AgentLog.e("COMMAND", "${cmd.type}: ${e.message}", e) }
        }
    }

    private fun post(cmd: AgentCommand, body: JSONObject): Boolean {
        return try {
            api().commandResult(cmd.id, body)
            true
        } catch (e: RetiredException) {
            // FORGET/WIPE su upravo umirovili uređaj — očekivano
            if (cmd.type == "FORGET" || cmd.type == "WIPE") true else throw e
        } catch (e: HttpException) {
            if (e.code == 409 || e.code == 404) {
                AgentLog.w("COMMAND", "Naredba ${cmd.id} zatvorena na poslužitelju (${e.code}) — odbacujem")
                false
            } else {
                throw e
            }
        }
    }

    /** Rezultat odgođene naredbe (npr. snimka zaslona nakon pristanka korisnika). */
    fun reportLater(commandId: String, ok: Boolean, error: String?, result: JSONObject?) {
        Thread {
            val body = Requests.commandResult(ok, error, result ?: JSONObject())
            CommandStore(ctx).put(commandId, body)
            runCatching { api().commandResult(commandId, body) }
                .onFailure { AgentLog.w("COMMAND", "Rezultat naredbe $commandId nije poslan (poslat će se pri ponovnoj isporuci)", it) }
            AgentService.start(ctx, checkinNow = true)
        }.start()
    }
}

/** Trajni zapis zadnjih ~500 naredbi i njihovih rezultata (de-duplikacija, §5.1). */
class CommandStore(ctx: Context) {
    private val file = java.io.File(ctx.filesDir, "commands.json")

    private fun load(): JSONObject = try { JSONObject(file.readText()) } catch (_: Exception) { JSONObject() }

    fun get(id: String): JSONObject? = synchronized(LOCK) { load().optJSONObject(id)?.optJSONObject("r") }

    fun isRunning(id: String): Boolean = synchronized(LOCK) { load().optJSONObject(id)?.optBoolean("running") == true }

    fun markRunning(id: String) = save(id, JSONObject().put("running", true).put("t", System.currentTimeMillis()))

    fun put(id: String, result: JSONObject) = save(id, JSONObject().put("r", result).put("t", System.currentTimeMillis()))

    private fun save(id: String, entry: JSONObject) {
        synchronized(LOCK) {
            val o = load()
            o.put(id, entry)
            if (o.length() > 500) {
                val keys = o.keys().asSequence().toList().sortedBy { o.optJSONObject(it)?.optLong("t") ?: 0L }
                keys.take(o.length() - 500).forEach { o.remove(it) }
            }
            try { file.writeText(o.toString()) } catch (_: Exception) { }
        }
    }

    companion object { private val LOCK = Any() }
}
