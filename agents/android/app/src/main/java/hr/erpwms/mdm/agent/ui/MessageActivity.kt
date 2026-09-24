package hr.erpwms.mdm.agent.ui

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import hr.erpwms.mdm.agent.Notifier

/** Poruka administratora preko cijelog zaslona (i na zaključanom zaslonu). */
class MessageActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent.getStringExtra(EXTRA_TEXT) ?: ""
        val nid = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)
        AlertDialog.Builder(this)
            .setTitle("Poruka administratora")
            .setMessage(text)
            .setCancelable(false)
            .setPositiveButton("U redu") { _, _ ->
                if (nid >= 0) Notifier.cancel(this, nid)
                finish()
            }
            .show()
    }

    companion object {
        const val EXTRA_TEXT = "text"
        const val EXTRA_NOTIFICATION_ID = "nid"
    }
}
