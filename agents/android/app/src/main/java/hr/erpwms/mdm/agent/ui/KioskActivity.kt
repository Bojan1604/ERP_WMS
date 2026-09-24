package hr.erpwms.mdm.agent.ui

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import hr.erpwms.mdm.agent.Prefs
import hr.erpwms.mdm.agent.policy.Kiosk

/**
 * Početni zaslon (HOME) u kiosk načinu: ulazi u lock task i pokreće zadanu
 * aplikaciju. Kad se ona zatvori, sustav se vraća ovdje i ona se ponovno pokreće.
 */
class KioskActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var text: TextView
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val pad = (24 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(0xFF1E3A8A.toInt())
        }
        text = TextView(this).apply { textSize = 20f; setTextColor(0xFFFFFFFF.toInt()); gravity = Gravity.CENTER }
        root.addView(text)
        root.addView(Button(this).apply {
            this.text = "Pokreni"
            setOnClickListener { launch() }
        })
        root.addView(Button(this).apply {
            this.text = "Servis"
            setOnClickListener {
                Pin.ask(this@KioskActivity, prefs.maintenancePin) {
                    Kiosk.suspended = true
                    runCatching { stopLockTask() }
                    startActivity(Intent(this@KioskActivity, MainActivity::class.java))
                }
            }
        })
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        if (!prefs.kioskEnabled || Kiosk.suspended) {
            text.text = if (Kiosk.suspended) "Kiosk je privremeno isključen (servis)" else "Kiosk nije uključen"
            return
        }
        val dpm = getSystemService(DevicePolicyManager::class.java)
        val am = getSystemService(ActivityManager::class.java)
        if (dpm.isLockTaskPermitted(packageName) && am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
            runCatching { startLockTask() }
        }
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ launch() }, 800)
    }

    override fun onPause() {
        handler.removeCallbacksAndMessages(null)
        super.onPause()
    }

    private fun launch() {
        val pkg = prefs.kioskPackage
        if (pkg == null) { text.text = "Zaključani način"; return }
        text.text = "Pokrećem $pkg…"
        if (!Kiosk.launchStartApp(this, pkg)) text.text = "Aplikacija $pkg nije instalirana — čekam instalaciju"
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // u kiosku nema izlaza tipkom natrag
        if (!prefs.kioskEnabled || Kiosk.suspended) super.onBackPressed()
    }
}
