package hr.erpwms.mdm.agent.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import hr.erpwms.mdm.agent.AgentService
import hr.erpwms.mdm.agent.BuildConfig
import hr.erpwms.mdm.agent.Prefs
import hr.erpwms.mdm.agent.R
import hr.erpwms.mdm.agent.TelemetryCollector
import java.text.DateFormat
import java.util.Date

/** Zaslon agenta: kod za upis dok uređaj čeka, zatim naziv uređaja i stanje. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())
    private val refresher = object : Runnable {
        override fun run() { render(); handler.postDelayed(this, 5000) }
    }
    private val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> handler.post { render() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        findViewById<ImageButton>(R.id.gear).setOnClickListener {
            Pin.ask(this, prefs.maintenancePin) { startActivity(Intent(this, SetupActivity::class.java)) }
        }
        if (prefs.server.isNullOrBlank()) {
            startActivity(Intent(this, SetupActivity::class.java))
        } else {
            AgentService.start(this)
        }
        askRuntimePermissions()
    }

    private fun askRuntimePermissions() {
        if (TelemetryCollector.isDeviceOwner(this)) return // Device Owner dodjeljuje dozvole sam sebi
        val want = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= 33) want += Manifest.permission.POST_NOTIFICATIONS
        val missing = want.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1)
    }

    override fun onResume() {
        super.onResume()
        prefs.changeListener(listener)
        handler.post(refresher)
    }

    override fun onPause() {
        prefs.removeListener(listener)
        handler.removeCallbacks(refresher)
        super.onPause()
    }

    private fun render() {
        val status = findViewById<TextView>(R.id.status)
        val code = findViewById<TextView>(R.id.code)
        val hint = findViewById<TextView>(R.id.hint)
        findViewById<TextView>(R.id.model).text = "${Build.MANUFACTURER} ${Build.MODEL}"

        when (prefs.status) {
            "ENROLLED" -> {
                status.text = "Upisano: ${prefs.deviceName ?: ""}"
                code.visibility = View.GONE
                hint.visibility = View.GONE
            }
            "RETIRED" -> {
                status.text = "Uređaj je uklonjen iz sustava"
                code.visibility = View.GONE
                hint.visibility = View.GONE
            }
            "FORGOTTEN" -> {
                status.text = "Uređaj je odjavljen"
                code.visibility = View.GONE
                hint.visibility = View.GONE
            }
            else -> {
                status.text = getString(R.string.welcome)
                val c = prefs.enrollCode
                code.visibility = View.VISIBLE
                code.text = c ?: "······"
                hint.visibility = if (c != null) View.VISIBLE else View.GONE
            }
        }

        val wifi = TelemetryCollector.wifi(this)
        val last = prefs.lastCheckinAt.takeIf { it > 0 }?.let { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM).format(Date(it)) }
        val lines = listOfNotNull(
            "Serijski broj: ${TelemetryCollector.serial() ?: "nije dostupan"}",
            "Wi-Fi: ${wifi.ssid?.let { s -> "$s (${wifi.rssi ?: "?"} dBm)" } ?: "nije spojen"}",
            "IP: ${TelemetryCollector.ipAddress() ?: "—"}",
            "Poslužitelj: ${prefs.server ?: "nije postavljen"}",
            "Zadnje javljanje: ${last ?: "—"}",
            prefs.lastError?.let { "Greška: $it" },
            "Agent ${BuildConfig.VERSION_NAME}",
        )
        findViewById<TextView>(R.id.details).text = lines.joinToString("\n")

        val warning = findViewById<TextView>(R.id.warning)
        if (!TelemetryCollector.isDeviceOwner(this)) {
            warning.visibility = View.VISIBLE
            warning.text = "Agent nije vlasnik uređaja (Device Owner). Radi samo telemetrija, poruke, datoteke i zapisnici. " +
                "Za restrikcije, kiosk, tihu instalaciju, zaključavanje, ponovno pokretanje i brisanje uređaj treba vratiti na " +
                "tvorničke postavke i upisati QR kodom s portala (MDM → Upis)."
        } else {
            warning.visibility = View.GONE
        }
    }
}
