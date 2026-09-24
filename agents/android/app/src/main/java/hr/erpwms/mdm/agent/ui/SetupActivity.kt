package hr.erpwms.mdm.agent.ui

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import hr.erpwms.mdm.agent.AgentLog
import hr.erpwms.mdm.agent.AgentService
import hr.erpwms.mdm.agent.Prefs
import hr.erpwms.mdm.agent.TelemetryCollector
import hr.erpwms.mdm.agent.core.UrlPolicy
import hr.erpwms.mdm.agent.policy.Kiosk

/**
 * Ručne postavke: adresa poslužitelja i (neobavezni) ključ upisa. Koristi se
 * kad agent nije upisan QR kodom — tada agent NIJE Device Owner.
 */
class SetupActivity : Activity() {
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun label(t: String, size: Float = 14f) = TextView(this).apply { text = t; textSize = size; setPadding(0, pad / 2, 0, pad / 4) }

        root.addView(label("Postavke agenta", 22f))
        val owner = TelemetryCollector.isDeviceOwner(this)
        root.addView(label(
            if (owner) "Agent je vlasnik uređaja (Device Owner) — sve funkcije su dostupne."
            else "Agent NIJE vlasnik uređaja. Ručnom instalacijom rade samo: prijava i kod za upis, telemetrija, poruke, " +
                "slanje datoteka, zapisnici i (uz pristanak) snimka zaslona. Restrikcije, kiosk, tiha instalacija, Wi-Fi, " +
                "ponovno pokretanje i brisanje traže upis QR kodom nakon vraćanja na tvorničke postavke.",
        ))

        root.addView(label("Adresa poslužitelja (https://…)"))
        val server = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.server ?: "")
            hint = "https://erp.example.hr"
        }
        root.addView(server, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(label("Ključ upisa (neobavezno — bez njega se upisuje šesteroznamenkastim kodom)"))
        val token = EditText(this).apply { setText(prefs.enrollToken ?: ""); inputType = InputType.TYPE_CLASS_TEXT }
        root.addView(token, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        root.addView(Button(this).apply {
            text = "Spremi i poveži"
            setOnClickListener {
                val s = UrlPolicy.normalize(server.text.toString())
                if (!UrlPolicy.isAllowed(s)) {
                    Toast.makeText(this@SetupActivity, "Dopušten je samo HTTPS (http samo za lokalne adrese 10.x, 192.168.x, localhost)", Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                if (prefs.server != s || prefs.status == "RETIRED" || prefs.status == "FORGOTTEN") prefs.clearCredentials()
                prefs.server = s
                prefs.enrollToken = token.text.toString().trim().ifEmpty { null }
                AgentLog.i("setup", "Ručno postavljen poslužitelj $s", report = true)
                AgentService.start(this@SetupActivity, checkinNow = true)
                finish()
            }
        })
        root.addView(Button(this).apply {
            text = "Javi se sada"
            setOnClickListener { AgentService.start(this@SetupActivity, checkinNow = true); Toast.makeText(this@SetupActivity, "Javljanje pokrenuto", Toast.LENGTH_SHORT).show() }
        })
        if (owner && prefs.kioskEnabled) {
            root.addView(Button(this).apply {
                text = "Privremeno izađi iz kiosk načina"
                setOnClickListener {
                    Kiosk.suspended = true
                    runCatching { stopLockTask() }
                    Toast.makeText(this@SetupActivity, "Kiosk je privremeno isključen do ponovnog pokretanja ili nove konfiguracije", Toast.LENGTH_LONG).show()
                }
            })
        }

        root.addView(label("Zapisnik agenta", 16f))
        root.addView(TextView(this).apply {
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 11f
            text = AgentLog.tail(40).reversed().joinToString("\n")
        })
        setContentView(ScrollView(this).apply { addView(root) })
    }
}
