package hr.erpwms.mdm.agent.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Protokol agenta v1 (vidi src/domain/mdm.ts i docs/mdm-agent-protocol.md).
 * Čista logika bez Android okvira (osim org.json) — testira se na JVM-u.
 */
object Protocol {
    const val VERSION = 1
    const val DEFAULT_CHECKIN_SEC = 60
}

// ---------------------------------------------------------------- pomoćne funkcije za JSON

/** Tekst ili null (JSON null, nepostojeći ključ i prazan niz → null). */
fun JSONObject.str(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val v = opt(key) ?: return null
    val s = v.toString()
    return s.ifEmpty { null }
}

fun JSONObject.bool(key: String): Boolean? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is Boolean -> v
        is String -> when (v.lowercase()) { "true", "1", "yes" -> true; "false", "0", "no" -> false; else -> null }
        is Number -> v.toInt() != 0
        else -> null
    }
}

fun JSONObject.int(key: String): Int? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is Number -> v.toInt()
        is String -> v.trim().toIntOrNull()
        else -> null
    }
}

fun JSONObject.long(key: String): Long? {
    if (!has(key) || isNull(key)) return null
    return when (val v = opt(key)) {
        is Number -> v.toLong()
        is String -> v.trim().toLongOrNull()
        else -> null
    }
}

fun JSONObject.obj(key: String): JSONObject? = if (has(key) && !isNull(key)) optJSONObject(key) else null
fun JSONObject.arr(key: String): JSONArray? = if (has(key) && !isNull(key)) optJSONArray(key) else null

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

// ---------------------------------------------------------------- odgovori poslužitelja

enum class DeviceStatus { PENDING, ENROLLED, RETIRED;
    companion object {
        fun parse(s: String?): DeviceStatus = values().firstOrNull { it.name == s } ?: PENDING
    }
}

data class RegisterResponse(
    val deviceId: String,
    val token: String,
    val status: DeviceStatus,
    val enrollCode: String?,
    val checkinSec: Int,
) {
    companion object {
        fun parse(json: String): RegisterResponse {
            val o = JSONObject(json)
            val token = o.str("token") ?: throw ProtocolException("Odgovor bez tokena")
            val id = o.str("deviceId") ?: throw ProtocolException("Odgovor bez deviceId")
            return RegisterResponse(id, token, DeviceStatus.parse(o.str("status")), o.str("enrollCode"), sanitizeCheckin(o.int("checkinSec")))
        }
    }
}

data class AgentCommand(val id: String, val type: String, val payload: JSONObject)

data class CheckinResponse(
    val status: DeviceStatus,
    val enrollCode: String?,
    val deviceName: String?,
    val checkinSec: Int,
    val config: EffectiveConfig?,
    val commands: List<AgentCommand>,
    /** Izvorni JSON konfiguracije (agent ga pamti za ponovnu primjenu). */
    val configJson: String? = null,
) {
    companion object {
        fun parse(json: String): CheckinResponse {
            val o = JSONObject(json)
            val cmds = o.arr("commands")?.objects()?.mapNotNull { c ->
                val id = c.str("id") ?: return@mapNotNull null
                val type = c.str("type") ?: return@mapNotNull null
                AgentCommand(id, type, c.obj("payload") ?: JSONObject())
            } ?: emptyList()
            return CheckinResponse(
                status = DeviceStatus.parse(o.str("status")),
                enrollCode = o.str("enrollCode"),
                deviceName = o.str("deviceName"),
                checkinSec = sanitizeCheckin(o.int("checkinSec")),
                config = o.obj("config")?.let { EffectiveConfig.parse(it) },
                commands = cmds,
                configJson = o.obj("config")?.toString(),
            )
        }
    }
}

/** Interval javljanja: 15 s – 1 h, zadano 60 s. */
fun sanitizeCheckin(sec: Int?): Int = when {
    sec == null || sec <= 0 -> Protocol.DEFAULT_CHECKIN_SEC
    sec < 15 -> 15
    sec > 3600 -> 3600
    else -> sec
}

class ProtocolException(msg: String) : Exception(msg)

// ---------------------------------------------------------------- konfiguracija

data class Restrictions(
    val noInstallApps: Boolean = false,
    val noSettings: Boolean = false,
    val noPlayStore: Boolean = false,
    val noUsbFileTransfer: Boolean = false,
    val noFactoryReset: Boolean = false,
    val noCamera: Boolean = false,
    val noStatusBar: Boolean = false,
) {
    companion object {
        fun parse(o: JSONObject?): Restrictions {
            if (o == null) return Restrictions()
            return Restrictions(
                noInstallApps = o.bool("noInstallApps") ?: false,
                noSettings = o.bool("noSettings") ?: false,
                noPlayStore = o.bool("noPlayStore") ?: false,
                noUsbFileTransfer = o.bool("noUsbFileTransfer") ?: false,
                noFactoryReset = o.bool("noFactoryReset") ?: false,
                noCamera = o.bool("noCamera") ?: false,
                noStatusBar = o.bool("noStatusBar") ?: false,
            )
        }
    }
}

enum class WifiSecurity { NONE, WPA2, WPA3 }

data class WifiNetwork(val ssid: String, val security: WifiSecurity, val password: String?, val hidden: Boolean)

enum class SystemUpdates { AUTOMATIC, WINDOWED, POSTPONE }

data class ProfileSettings(
    val kiosk: Boolean = false,
    val startApp: String? = null,
    val adb: Boolean? = null,
    val restrictions: Restrictions = Restrictions(),
    val wifi: List<WifiNetwork> = emptyList(),
    val maintenancePin: String? = null,
    val screenTimeoutSec: Int? = null,
    val timezone: String? = null,
    val volumePct: Int? = null,
    val systemUpdates: SystemUpdates? = null,
) {
    companion object {
        fun parse(o: JSONObject?): ProfileSettings {
            if (o == null) return ProfileSettings()
            val wifi = o.arr("wifi")?.objects()?.mapNotNull { w ->
                val ssid = w.str("ssid") ?: return@mapNotNull null
                val sec = WifiSecurity.values().firstOrNull { it.name == w.str("security") } ?: WifiSecurity.WPA2
                WifiNetwork(ssid, sec, w.str("password"), w.bool("hidden") ?: false)
            } ?: emptyList()
            return ProfileSettings(
                kiosk = o.bool("kiosk") ?: false,
                startApp = o.str("startApp"),
                adb = o.bool("adb"),
                restrictions = Restrictions.parse(o.obj("restrictions")),
                wifi = wifi,
                maintenancePin = o.str("maintenancePin"),
                screenTimeoutSec = o.int("screenTimeoutSec"),
                timezone = o.str("timezone"),
                volumePct = o.int("volumePct"),
                systemUpdates = SystemUpdates.values().firstOrNull { it.name == o.str("systemUpdates") },
            )
        }
    }
}

data class ResolvedApp(
    val appId: String,
    val packageName: String,
    val name: String?,
    val version: String?,
    val versionCode: Long?,
    val downloadPath: String?,
    val sha256: String?,
    val config: Map<String, String>,
    val hidden: Boolean,
    val autoStart: Boolean,
    val remove: Boolean,
) {
    companion object {
        fun parse(o: JSONObject): ResolvedApp? {
            val pkg = o.str("packageName") ?: return null
            val cfg = LinkedHashMap<String, String>()
            o.obj("config")?.let { c -> c.keys().forEach { k -> if (!c.isNull(k)) cfg[k] = c.opt(k).toString() } }
            return ResolvedApp(
                appId = o.str("appId") ?: pkg,
                packageName = pkg,
                name = o.str("name"),
                version = o.str("version"),
                versionCode = o.long("versionCode"),
                downloadPath = o.str("downloadPath"),
                sha256 = o.str("sha256")?.lowercase(),
                config = cfg,
                hidden = o.bool("hidden") ?: false,
                autoStart = o.bool("autoStart") ?: false,
                remove = o.bool("remove") ?: false,
            )
        }
    }
}

data class EffectiveConfig(val version: Int, val settings: ProfileSettings, val apps: List<ResolvedApp>) {
    companion object {
        fun parse(o: JSONObject): EffectiveConfig = EffectiveConfig(
            version = o.int("version") ?: 0,
            settings = ProfileSettings.parse(o.obj("settings")),
            apps = o.arr("apps")?.objects()?.mapNotNull { ResolvedApp.parse(it) } ?: emptyList(),
        )
    }
}

// ---------------------------------------------------------------- zahtjevi agenta

data class AppInfo(val packageName: String, val name: String?, val version: String?, val versionCode: Long?)

data class Telemetry(
    val serial: String? = null,
    val manufacturer: String? = null,
    val model: String? = null,
    val osVersion: String? = null,
    val agentVersion: String? = null,
    val imei: String? = null,
    val macAddress: String? = null,
    val ipAddress: String? = null,
    val wifiSsid: String? = null,
    val wifiSignal: Int? = null,
    val batteryLevel: Int? = null,
    val charging: Boolean? = null,
    val storageFreeMb: Long? = null,
    val storageTotalMb: Long? = null,
    val ramTotalMb: Long? = null,
    val uptimeSec: Long? = null,
    val apps: List<AppInfo>? = null,
    val extra: Map<String, Any?> = emptyMap(),
) {
    fun toJson(): JSONObject {
        val o = JSONObject()
        fun put(k: String, v: Any?) { o.put(k, v ?: JSONObject.NULL) }
        put("serial", serial); put("manufacturer", manufacturer); put("model", model)
        put("osVersion", osVersion); put("agentVersion", agentVersion); put("imei", imei)
        put("macAddress", macAddress); put("ipAddress", ipAddress); put("wifiSsid", wifiSsid)
        put("wifiSignal", wifiSignal); put("batteryLevel", batteryLevel); put("charging", charging)
        put("storageFreeMb", storageFreeMb); put("storageTotalMb", storageTotalMb)
        put("ramTotalMb", ramTotalMb); put("uptimeSec", uptimeSec)
        if (apps != null) {
            val a = JSONArray()
            apps.forEach { app ->
                val j = JSONObject().put("packageName", app.packageName)
                app.name?.let { j.put("name", it) }
                app.version?.let { j.put("version", it) }
                app.versionCode?.let { j.put("versionCode", it) }
                a.put(j)
            }
            o.put("apps", a)
        }
        val ex = JSONObject()
        extra.forEach { (k, v) -> ex.put(k, v ?: JSONObject.NULL) }
        o.put("extra", ex)
        return o
    }
}

data class AgentEvent(val at: String, val level: String, val type: String, val message: String) {
    fun toJson(): JSONObject = JSONObject().put("at", at).put("level", level).put("type", type).put("message", message.take(1000))
}

object Requests {
    fun register(
        platform: String, enrollToken: String?, hardwareId: String, serial: String?, manufacturer: String?,
        model: String?, osVersion: String?, agentVersion: String?, name: String?,
    ): JSONObject = JSONObject()
        .put("protocol", Protocol.VERSION)
        .put("platform", platform)
        .put("enrollToken", enrollToken ?: JSONObject.NULL)
        .put("hardwareId", hardwareId)
        .put("serial", serial ?: JSONObject.NULL)
        .put("manufacturer", manufacturer ?: JSONObject.NULL)
        .put("model", model ?: JSONObject.NULL)
        .put("osVersion", osVersion ?: JSONObject.NULL)
        .put("agentVersion", agentVersion ?: JSONObject.NULL)
        .put("name", name ?: JSONObject.NULL)

    fun checkin(telemetry: Telemetry, appliedConfigVersion: Int?, events: List<AgentEvent>): JSONObject {
        val o = JSONObject().put("telemetry", telemetry.toJson())
        if (appliedConfigVersion != null) o.put("appliedConfigVersion", appliedConfigVersion)
        if (events.isNotEmpty()) o.put("events", JSONArray().apply { events.takeLast(50).forEach { put(it.toJson()) } })
        return o
    }

    fun commandResult(ok: Boolean, error: String?, result: JSONObject?): JSONObject = JSONObject()
        .put("ok", ok)
        .put("error", error?.take(2000) ?: JSONObject.NULL)
        .put("result", result ?: JSONObject.NULL)
}
