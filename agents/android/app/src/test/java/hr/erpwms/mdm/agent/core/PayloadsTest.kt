package hr.erpwms.mdm.agent.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PayloadsTest {
    private val sha = "ab".repeat(32)

    @Test
    fun installAppPayload() {
        val p = Payloads.installApp(JSONObject("""{"appId":"x","packageName":"hr.pos.app","version":"1","versionCode":5,"downloadPath":"/api/mdm/agent/files/f","sha256":"${sha.uppercase()}"}"""))
        assertEquals("hr.pos.app", p.packageName)
        assertEquals(5L, p.versionCode)
        assertEquals(sha, p.sha256)
    }

    @Test(expected = IllegalArgumentException::class)
    fun installAppRejectsBadSha() {
        Payloads.installApp(JSONObject("""{"packageName":"hr.pos.app","downloadPath":"/f","sha256":"123"}"""))
    }

    @Test(expected = IllegalArgumentException::class)
    fun installAppRejectsBadPackage() {
        Payloads.installApp(JSONObject("""{"packageName":"../etc","downloadPath":"/f","sha256":"$sha"}"""))
    }

    @Test(expected = IllegalArgumentException::class)
    fun messageNeedsText() {
        Payloads.message(JSONObject("{}"))
    }

    @Test
    fun pushFileSanitizesName() {
        val p = Payloads.pushFile(JSONObject("""{"fileId":"f","name":"../../evil/cjenik 2024.pdf","downloadPath":"/f","sha256":"$sha","targetPath":"Cjenici"}"""))
        assertEquals("cjenik 2024.pdf", p.name)
        assertEquals("Cjenici", p.targetPath)
        assertEquals("_etc_passwd", Payloads.safeFileName("\$etc*passwd"))
    }

    @Test
    fun kioskPayload() {
        val k = Payloads.kiosk(JSONObject("""{"enabled":true,"packageName":"hr.pos.app"}"""))
        assertTrue(k.enabled)
        assertEquals("hr.pos.app", k.packageName)
        val off = Payloads.kiosk(JSONObject("""{"enabled":false}"""))
        assertFalse(off.enabled)
        assertNull(off.packageName)
    }

    @Test
    fun urlPolicy() {
        assertTrue(UrlPolicy.isAllowed("https://erp.firma.hr"))
        assertTrue(UrlPolicy.isAllowed("http://localhost:3000"))
        assertTrue(UrlPolicy.isAllowed("http://192.168.1.10:3000"))
        assertTrue(UrlPolicy.isAllowed("http://10.0.2.2:3000"))
        assertTrue(UrlPolicy.isAllowed("http://172.20.1.1"))
        assertFalse(UrlPolicy.isAllowed("http://172.40.1.1"))
        assertFalse(UrlPolicy.isAllowed("http://erp.firma.hr"))
        assertFalse(UrlPolicy.isAllowed("ftp://erp.firma.hr"))
        assertEquals("https://erp.firma.hr", UrlPolicy.normalize(" erp.firma.hr/ "))
        assertEquals("https://erp.firma.hr/api/mdm/agent/files/1", UrlPolicy.resolve("https://erp.firma.hr/", "/api/mdm/agent/files/1"))
        assertEquals("https://erp.firma.hr/x", UrlPolicy.resolve("https://erp.firma.hr", "https://ERP.firma.hr/x"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun downloadFromOtherHostIsRejected() {
        UrlPolicy.resolve("https://erp.firma.hr", "https://evil.example/x.apk")
    }

    @Test
    fun backoffGrowsAndCaps() {
        assertEquals(60, Backoff.delaySec(60, 0))
        assertEquals(60, Backoff.delaySec(60, 1))
        assertEquals(120, Backoff.delaySec(60, 2))
        assertEquals(240, Backoff.delaySec(60, 3))
        assertEquals(900, Backoff.delaySec(60, 10))
        assertEquals(900, Backoff.delaySec(60, 50))
    }

    @Test
    fun hashing() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Hashing.sha256Hex(ByteArray(0)))
        // base64url bez nadopune (oblik za PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM)
        assertEquals("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU", Hashing.base64Url(Hashing.fromHex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")))
    }
}
