package hr.erpwms.mdm.agent

import hr.erpwms.mdm.agent.core.CheckinResponse
import hr.erpwms.mdm.agent.core.Hashing
import hr.erpwms.mdm.agent.core.RegisterResponse
import hr.erpwms.mdm.agent.core.UrlPolicy
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

open class HttpException(val code: Int, message: String) : IOException(message)

/** HTTP 410 — uređaj je umirovljen na poslužitelju: agent staje i briše vjerodajnice. */
class RetiredException : HttpException(410, "Uređaj je uklonjen iz sustava (410)")

/** Klijent za /api/mdm/agent/* preko HttpURLConnection (bez dodatnih biblioteka). */
class ApiClient(private val server: String, private val token: String?) {

    init {
        require(UrlPolicy.isAllowed(server)) { "Poslužitelj mora koristiti HTTPS (http samo za lokalne adrese)" }
    }

    fun register(body: JSONObject): RegisterResponse = RegisterResponse.parse(postJson("/api/mdm/agent/register", body, auth = false))

    fun checkin(body: JSONObject): CheckinResponse = CheckinResponse.parse(postJson("/api/mdm/agent/checkin", body))

    fun commandResult(id: String, body: JSONObject) {
        postJson("/api/mdm/agent/commands/" + URLEncoder.encode(id, "UTF-8"), body)
    }

    /** Šalje datoteku (SCREENSHOT/LOGS) kao sirovo tijelo; vraća JSON odgovor poslužitelja. */
    fun upload(kind: String, commandId: String?, file: File, contentType: String, fileName: String): JSONObject {
        val q = "kind=" + URLEncoder.encode(kind, "UTF-8") +
            (commandId?.let { "&commandId=" + URLEncoder.encode(it, "UTF-8") } ?: "") +
            "&name=" + URLEncoder.encode(fileName, "UTF-8")
        val c = open("/api/mdm/agent/upload?$q", "POST", auth = true, readTimeoutMs = 120_000)
        c.setRequestProperty("Content-Type", contentType)
        c.setRequestProperty("X-Content-SHA256", Hashing.sha256Hex(file))
        c.setFixedLengthStreamingMode(file.length())
        c.doOutput = true
        c.outputStream.use { out -> file.inputStream().use { it.copyTo(out) } }
        val text = readResponse(c)
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    /**
     * Preuzimanje s nastavkom (Range) i provjerom SHA-256. Djelomična datoteka
     * `<dest>.part` ostaje između pokušaja.
     */
    fun download(path: String, dest: File, expectedSha256: String, onProgress: ((Long, Long) -> Unit)? = null): File {
        val url = UrlPolicy.resolve(server, path)
        val part = File(dest.parentFile, dest.name + ".part")
        for (attempt in 1..2) {
            val have = if (part.exists()) part.length() else 0L
            val c = openUrl(url, "GET", auth = true, readTimeoutMs = 120_000)
            if (have > 0) c.setRequestProperty("Range", "bytes=$have-")
            val code = c.responseCode
            if (code == 410) throw RetiredException()
            if (code == 416) { part.delete(); c.disconnect(); continue }
            if (code !in 200..299) throw HttpException(code, "Preuzimanje nije uspjelo: HTTP $code")
            val append = code == 206 && have > 0
            val serverSha = c.getHeaderField("X-Content-SHA256")?.lowercase()
            if (serverSha != null && serverSha != expectedSha256.lowercase()) {
                c.disconnect()
                throw IOException("Poslužitelj javlja drugačiji SHA-256 od očekivanog")
            }
            val total = (c.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L).let { if (it >= 0 && append) it + have else it }
            var done = if (append) have else 0L
            c.inputStream.use { input ->
                FileOutputStream(part, append).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        onProgress?.invoke(done, total)
                    }
                }
            }
            val sha = Hashing.sha256Hex(part)
            if (sha != expectedSha256.lowercase()) {
                part.delete()
                if (attempt == 1 && append) continue // nastavak je možda bio pokvaren — ispočetka
                throw IOException("SHA-256 se ne podudara (očekivano $expectedSha256, dobiveno $sha)")
            }
            dest.delete()
            if (!part.renameTo(dest)) throw IOException("Ne mogu preimenovati ${part.name}")
            return dest
        }
        throw IOException("Preuzimanje nije uspjelo")
    }

    // ------------------------------------------------------------ interno

    private fun postJson(path: String, body: JSONObject, auth: Boolean = true): String {
        val c = open(path, "POST", auth)
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        c.setFixedLengthStreamingMode(bytes.size)
        c.doOutput = true
        c.outputStream.use { it.write(bytes) }
        return readResponse(c)
    }

    private fun open(path: String, method: String, auth: Boolean, readTimeoutMs: Int = 60_000): HttpURLConnection =
        openUrl(server.trimEnd('/') + path, method, auth, readTimeoutMs)

    private fun openUrl(url: String, method: String, auth: Boolean, readTimeoutMs: Int): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = readTimeoutMs
        c.instanceFollowRedirects = false
        c.setRequestProperty("Accept", "application/json")
        c.setRequestProperty("User-Agent", "ErpWmsMdmAgent/${BuildConfig.VERSION_NAME} Android")
        if (auth) {
            val t = token ?: throw IOException("Nema tokena uređaja")
            c.setRequestProperty("Authorization", "Device $t")
        }
        return c
    }

    private fun readResponse(c: HttpURLConnection): String {
        try {
            val code = c.responseCode
            if (code == 410) throw RetiredException()
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            if (code !in 200..299) {
                val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf { it.isNotBlank() } ?: text.take(200)
                throw HttpException(code, "HTTP $code: $msg")
            }
            return text
        } finally {
            c.disconnect()
        }
    }

}
