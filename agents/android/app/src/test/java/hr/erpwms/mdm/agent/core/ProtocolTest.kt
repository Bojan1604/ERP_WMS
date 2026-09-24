package hr.erpwms.mdm.agent.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    @Test
    fun parsesRegisterResponse() {
        val r = RegisterResponse.parse("""{"deviceId":"d1","token":"tok","status":"PENDING","enrollCode":"123456","checkinSec":60}""")
        assertEquals("d1", r.deviceId)
        assertEquals("tok", r.token)
        assertEquals(DeviceStatus.PENDING, r.status)
        assertEquals("123456", r.enrollCode)
        assertEquals(60, r.checkinSec)
    }

    @Test(expected = ProtocolException::class)
    fun registerWithoutTokenFails() {
        RegisterResponse.parse("""{"deviceId":"d1","status":"PENDING"}""")
    }

    @Test
    fun parsesCheckinWithConfigAndCommands() {
        val json = """
        {"status":"ENROLLED","enrollCode":null,"deviceName":"Blagajna 1","checkinSec":30,
         "config":{"version":7,"settings":{"kiosk":true,"startApp":"app1","adb":false,
            "restrictions":{"noInstallApps":true,"noCamera":true},
            "wifi":[{"ssid":"Trgovina","security":"WPA2","password":"tajna1234"},{"ssid":"Gost","security":"NONE","hidden":true}],
            "maintenancePin":"2468","screenTimeoutSec":120,"timezone":"Europe/Zagreb","systemUpdates":"WINDOWED"},
          "apps":[{"appId":"app1","packageName":"hr.pos.app","name":"POS","version":"1.2","versionCode":12,
                   "downloadPath":"/api/mdm/agent/files/f1","sha256":"${"A".repeat(64)}","config":{"url":"https://x","n":5}}]},
         "commands":[{"id":"c1","type":"REBOOT","payload":{}},{"id":"c2","type":"MESSAGE","payload":{"text":"Bok"}},{"type":"BROKEN"}]}
        """
        val r = CheckinResponse.parse(json)
        assertEquals(DeviceStatus.ENROLLED, r.status)
        assertNull(r.enrollCode)
        assertEquals("Blagajna 1", r.deviceName)
        assertEquals(30, r.checkinSec)
        assertEquals(2, r.commands.size)
        assertEquals("MESSAGE", r.commands[1].type)
        assertEquals("Bok", r.commands[1].payload.getString("text"))
        val c = r.config!!
        assertEquals(7, c.version)
        assertTrue(c.settings.kiosk)
        assertEquals(false, c.settings.adb)
        assertTrue(c.settings.restrictions.noInstallApps)
        assertTrue(c.settings.restrictions.noCamera)
        assertFalse(c.settings.restrictions.noSettings)
        assertEquals(2, c.settings.wifi.size)
        assertEquals(WifiSecurity.NONE, c.settings.wifi[1].security)
        assertTrue(c.settings.wifi[1].hidden)
        assertEquals("2468", c.settings.maintenancePin)
        assertEquals(SystemUpdates.WINDOWED, c.settings.systemUpdates)
        val app = c.apps.single()
        assertEquals("hr.pos.app", app.packageName)
        assertEquals(12L, app.versionCode)
        assertEquals("a".repeat(64), app.sha256)
        assertEquals(mapOf("url" to "https://x", "n" to "5"), app.config)
        assertTrue(r.configJson!!.contains("\"version\":7"))
    }

    @Test
    fun missingConfigAndNullsAreHandled() {
        val r = CheckinResponse.parse("""{"status":"PENDING","enrollCode":"654321","deviceName":"","checkinSec":null,"config":null,"commands":[]}""")
        assertNull(r.config)
        assertNull(r.deviceName)
        assertEquals(60, r.checkinSec)
        assertEquals("654321", r.enrollCode)
    }

    @Test
    fun checkinIntervalIsClamped() {
        assertEquals(60, sanitizeCheckin(null))
        assertEquals(15, sanitizeCheckin(1))
        assertEquals(3600, sanitizeCheckin(100000))
        assertEquals(90, sanitizeCheckin(90))
    }

    @Test
    fun unknownStatusDefaultsToPending() {
        assertEquals(DeviceStatus.PENDING, DeviceStatus.parse("XYZ"))
        assertEquals(DeviceStatus.RETIRED, DeviceStatus.parse("RETIRED"))
    }

    @Test
    fun buildsCheckinRequest() {
        val t = Telemetry(serial = "S1", batteryLevel = 80, charging = true, apps = listOf(AppInfo("a.b", "AB", "1.0", 3)), extra = mapOf("securityPatch" to "2024-05-01"))
        val events = (1..60).map { AgentEvent("2024-01-01T00:00:00Z", "info", "t", "m$it") }
        val o = Requests.checkin(t, 4, events)
        assertEquals(4, o.getInt("appliedConfigVersion"))
        val tel = o.getJSONObject("telemetry")
        assertEquals("S1", tel.getString("serial"))
        assertEquals(80, tel.getInt("batteryLevel"))
        assertTrue(tel.getBoolean("charging"))
        assertTrue(tel.isNull("imei"))
        assertEquals("a.b", tel.getJSONArray("apps").getJSONObject(0).getString("packageName"))
        assertEquals(3L, tel.getJSONArray("apps").getJSONObject(0).getLong("versionCode"))
        assertEquals("2024-05-01", tel.getJSONObject("extra").getString("securityPatch"))
        assertEquals(50, o.getJSONArray("events").length())
        assertEquals("m60", o.getJSONArray("events").getJSONObject(49).getString("message"))
    }

    @Test
    fun buildsRegisterAndResult() {
        val r = Requests.register("ANDROID", null, "hw", "SER", "Sunmi", "V2s", "Android 11", "1.0.0", null)
        assertEquals(1, r.getInt("protocol"))
        assertEquals("ANDROID", r.getString("platform"))
        assertTrue(r.isNull("enrollToken"))
        val res = Requests.commandResult(false, "x", JSONObject().put("a", 1))
        assertFalse(res.getBoolean("ok"))
        assertEquals("x", res.getString("error"))
        assertEquals(1, res.getJSONObject("result").getInt("a"))
    }
}
