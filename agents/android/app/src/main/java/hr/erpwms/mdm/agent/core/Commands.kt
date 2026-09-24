package hr.erpwms.mdm.agent.core

import org.json.JSONObject

/** Provjera i čitanje korisnog tereta naredbi. Neispravan teret → [IllegalArgumentException]. */
object Payloads {
    private val SHA256 = Regex("^[0-9a-fA-F]{64}$")
    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$")

    data class InstallApp(
        val appId: String?,
        val packageName: String,
        val version: String?,
        val versionCode: Long?,
        val downloadPath: String,
        val sha256: String,
    )

    data class PushFile(val fileId: String?, val name: String, val downloadPath: String, val sha256: String, val targetPath: String?)

    data class Kiosk(val enabled: Boolean, val packageName: String?)

    fun installApp(p: JSONObject): InstallApp {
        val pkg = need(p, "packageName")
        require(PACKAGE.matches(pkg)) { "Neispravan naziv paketa: $pkg" }
        return InstallApp(
            appId = p.str("appId"),
            packageName = pkg,
            version = p.str("version"),
            versionCode = p.long("versionCode"),
            downloadPath = need(p, "downloadPath"),
            sha256 = sha(p),
        )
    }

    fun uninstallApp(p: JSONObject): String {
        val pkg = need(p, "packageName")
        require(PACKAGE.matches(pkg)) { "Neispravan naziv paketa: $pkg" }
        return pkg
    }

    fun pushFile(p: JSONObject): PushFile {
        val name = safeFileName(need(p, "name"))
        return PushFile(p.str("fileId"), name, need(p, "downloadPath"), sha(p), p.str("targetPath"))
    }

    fun message(p: JSONObject): String {
        val t = need(p, "text")
        return t.take(4000)
    }

    fun kiosk(p: JSONObject): Kiosk {
        val enabled = p.bool("enabled") ?: throw IllegalArgumentException("Nedostaje 'enabled'")
        val pkg = p.str("packageName")
        if (pkg != null) require(PACKAGE.matches(pkg)) { "Neispravan naziv paketa: $pkg" }
        return Kiosk(enabled, pkg)
    }

    /** Samo ime datoteke — bez putanje i opasnih znakova. */
    fun safeFileName(name: String): String {
        val base = name.replace('\\', '/').substringAfterLast('/').trim()
        val clean = base.replace(Regex("[^A-Za-z0-9._ ()-]"), "_").trimStart('.')
        require(clean.isNotEmpty()) { "Neispravno ime datoteke" }
        return clean.take(120)
    }

    private fun sha(p: JSONObject): String {
        val s = need(p, "sha256")
        require(SHA256.matches(s)) { "Neispravan sha256" }
        return s.lowercase()
    }

    private fun need(p: JSONObject, key: String): String =
        p.str(key)?.trim()?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("Nedostaje '$key'")
}

/** Pravilo za adresu poslužitelja: HTTPS, osim lokalnih/razvojnih adresa. */
object UrlPolicy {
    fun normalize(input: String): String {
        var s = input.trim().trimEnd('/')
        if (!s.startsWith("http://", true) && !s.startsWith("https://", true)) s = "https://$s"
        return s
    }

    fun isAllowed(url: String): Boolean {
        val m = Regex("^(https?)://([^/:]+)(:\\d+)?(/.*)?$", RegexOption.IGNORE_CASE).find(url.trim()) ?: return false
        val scheme = m.groupValues[1].lowercase()
        if (scheme == "https") return true
        val host = m.groupValues[2].lowercase()
        return isDevHost(host)
    }

    fun isDevHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2") return true
        if (host.startsWith("10.") || host.startsWith("192.168.")) return true
        val m = Regex("^172\\.(\\d+)\\.").find(host)
        if (m != null) { val n = m.groupValues[1].toInt(); if (n in 16..31) return true }
        return false
    }

    /** Relativnu putanju (npr. /api/mdm/agent/files/x) spaja s adresom poslužitelja; apsolutna mora biti na istom poslužitelju. */
    fun resolve(server: String, path: String): String {
        if (path.startsWith("http://", true) || path.startsWith("https://", true)) {
            require(sameOrigin(server, path)) { "Preuzimanje s drugog poslužitelja nije dopušteno" }
            return path
        }
        return server.trimEnd('/') + "/" + path.trimStart('/')
    }

    private fun origin(u: String) = Regex("^(https?://[^/]+)", RegexOption.IGNORE_CASE).find(u)?.value?.lowercase()
    fun sameOrigin(a: String, b: String) = origin(a) != null && origin(a) == origin(b)
}

/** Eksponencijalno odgađanje pri greškama: interval × 2^n, najviše 15 min. */
object Backoff {
    fun delaySec(baseSec: Int, failures: Int): Int {
        if (failures <= 0) return baseSec
        val exp = failures.coerceAtMost(10)
        val d = baseSec.toLong() * (1L shl exp) / 2
        return d.coerceIn(baseSec.toLong().coerceAtMost(30), 900).toInt()
    }
}
