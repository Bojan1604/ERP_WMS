package hr.erpwms.mdm.agent.ui

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import hr.erpwms.mdm.agent.ScreenCapture
import hr.erpwms.mdm.agent.ScreenCaptureService

/** Traži sistemski pristanak za snimanje zaslona (MediaProjection) i pokreće servis snimanja. */
class ScreenCaptureActivity : Activity() {
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (ScreenCapture.pendingCommandId == null) { finish(); return }
        val mpm = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ)
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ) {
            if (resultCode == RESULT_OK && data != null) {
                startForegroundService(
                    Intent(this, ScreenCaptureService::class.java)
                        .putExtra(ScreenCaptureService.EXTRA_CODE, resultCode)
                        .putExtra(ScreenCaptureService.EXTRA_DATA, data),
                )
            } else {
                ScreenCapture.finish(this, false, "Korisnik je odbio snimanje zaslona", null)
            }
        }
        finish()
    }

    companion object { private const val REQ = 7 }
}
