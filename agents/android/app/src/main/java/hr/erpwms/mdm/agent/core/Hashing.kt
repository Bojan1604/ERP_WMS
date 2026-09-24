package hr.erpwms.mdm.agent.core

import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64

object Hashing {
    fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun sha256Hex(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return hex(md.digest())
    }

    fun sha256Hex(file: File): String = file.inputStream().use { sha256Hex(it) }

    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** Base64url bez nadopune — oblik koji traži PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM. */
    fun base64Url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    fun fromHex(s: String): ByteArray {
        val c = s.trim().lowercase()
        require(c.length % 2 == 0) { "Neparan broj znakova" }
        return ByteArray(c.length / 2) { i -> c.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}
