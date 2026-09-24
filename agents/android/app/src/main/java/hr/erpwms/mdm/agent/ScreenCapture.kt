package hr.erpwms.mdm.agent

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import hr.erpwms.mdm.agent.ui.ScreenCaptureActivity
import org.json.JSONObject
import java.io.File

/**
 * Snimka zaslona. Android NE dopušta tiho snimanje zaslona ni Device Owneru:
 * jedini put je MediaProjection uz pristanak korisnika na uređaju (sistemski
 * dijalog pri svakom snimanju). Ako korisnik ne odobri u 3 minute, naredba
 * se javlja kao neuspjela.
 */
object ScreenCapture {
    private const val NOTIF_ID = 42
    private const val TIMEOUT_MS = 3 * 60_000L
    @Volatile var pendingCommandId: String? = null
        private set

    fun request(ctx: Context, commandId: String) {
        val app = ctx.applicationContext
        pendingCommandId = commandId
        val intent = Intent(app, ScreenCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        Notifier.notify(app, NOTIF_ID, "Snimka zaslona", "Administrator traži snimku zaslona. Dodirnite za dopuštenje.", intent)
        runCatching { app.startActivity(intent) }
        Handler(Looper.getMainLooper()).postDelayed({
            if (pendingCommandId == commandId) finish(app, false, "Korisnik nije odobrio snimanje zaslona (Android traži pristanak na uređaju)", null)
        }, TIMEOUT_MS)
    }

    /** Završava naredbu točno jednom. */
    @Synchronized
    fun finish(ctx: Context, ok: Boolean, error: String?, result: JSONObject?) {
        val id = pendingCommandId ?: return
        pendingCommandId = null
        Notifier.cancel(ctx, NOTIF_ID)
        if (!ok) AgentLog.w("screenshot", error ?: "neuspjelo")
        Agent(ctx).reportLater(id, ok, error, result)
    }
}

/** Servis tipa mediaProjection (obavezan od Androida 10/14) — snimi jedan kadar, pošalje PNG i stane. */
class ScreenCaptureService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var done = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = Notifier.serviceNotification(this, "Snimanje zaslona…")
        if (Build.VERSION.SDK_INT >= 29) startForeground(Notifier.SERVICE_ID + 1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(Notifier.SERVICE_ID + 1, n)
        val code = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data = intent?.getParcelableExtra<Intent>(EXTRA_DATA)
        if (data == null) {
            fail("Nema podataka o pristanku")
            return START_NOT_STICKY
        }
        try {
            capture(code, data)
        } catch (e: Exception) {
            fail("Snimanje nije uspjelo: ${e.message}")
        }
        return START_NOT_STICKY
    }

    private fun capture(code: Int, data: Intent) {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val mp = mpm.getMediaProjection(code, data) ?: throw IllegalStateException("MediaProjection nije dostupan")
        projection = mp
        val t = HandlerThread("screenshot").apply { start() }
        thread = t
        val h = Handler(t.looper)
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { cleanup() }
        }, h)
        val metrics = resources.displayMetrics
        val w = metrics.widthPixels
        val ht = metrics.heightPixels
        val r = ImageReader.newInstance(w, ht, PixelFormat.RGBA_8888, 2)
        reader = r
        r.setOnImageAvailableListener({ rd ->
            if (done) return@setOnImageAvailableListener
            val img = rd.acquireLatestImage() ?: return@setOnImageAvailableListener
            done = true
            try {
                val plane = img.planes[0]
                val rowPadding = plane.rowStride - plane.pixelStride * w
                val bmp = Bitmap.createBitmap(w + rowPadding / plane.pixelStride, ht, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(bmp, 0, 0, w, ht)
                val file = File(cacheDir, "screenshot-${System.currentTimeMillis()}.png")
                file.outputStream().use { cropped.compress(Bitmap.CompressFormat.PNG, 100, it) }
                img.close()
                cleanup()
                Thread {
                    try {
                        val id = ScreenCapture.pendingCommandId
                        val resp = Agent(this).api().upload("SCREENSHOT", id, file, "image/png", file.name)
                        ScreenCapture.finish(this, true, null, JSONObject().put("fileId", resp.optString("fileId")).put("width", w).put("height", ht))
                    } catch (e: Exception) {
                        ScreenCapture.finish(this, false, "Slanje snimke nije uspjelo: ${e.message}", null)
                    } finally {
                        file.delete()
                        stopSelf()
                    }
                }.start()
            } catch (e: Exception) {
                runCatching { img.close() }
                fail("Obrada snimke nije uspjela: ${e.message}")
            }
        }, h)
        display = mp.createVirtualDisplay("erpwms-screenshot", w, ht, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, h)
    }

    private fun fail(msg: String) {
        cleanup()
        ScreenCapture.finish(this, false, msg, null)
        stopSelf()
    }

    private fun cleanup() {
        runCatching { display?.release() }
        display = null
        runCatching { reader?.close() }
        reader = null
        runCatching { projection?.stop() }
        projection = null
        thread?.quitSafely()
        thread = null
    }

    override fun onDestroy() {
        cleanup()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
    }
}
