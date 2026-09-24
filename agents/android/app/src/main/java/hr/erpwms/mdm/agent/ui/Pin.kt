package hr.erpwms.mdm.agent.ui

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.widget.EditText
import android.widget.Toast

/** Servisni PIN (maintenancePin iz konfiguracije). Bez postavljenog PIN-a pristup je slobodan. */
object Pin {
    fun ask(activity: Activity, pin: String?, onOk: () -> Unit) {
        if (pin.isNullOrBlank()) { onOk(); return }
        val input = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = "PIN"
        }
        AlertDialog.Builder(activity)
            .setTitle("Servisni PIN")
            .setView(input)
            .setPositiveButton("U redu") { _, _ ->
                if (input.text.toString() == pin) onOk()
                else Toast.makeText(activity, "Pogrešan PIN", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Odustani", null)
            .show()
    }
}
