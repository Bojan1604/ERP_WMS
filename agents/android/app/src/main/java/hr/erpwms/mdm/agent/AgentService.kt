package hr.erpwms.mdm.agent

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import hr.erpwms.mdm.agent.policy.Kiosk

/**
 * Servis u prvom planu (trajna obavijest niskog prioriteta — nužna za mrežu u
 * pozadini). Petlja javljanja radi na zasebnoj niti; AlarmManager svakih 15
 * minuta provjerava da servis živi (rezerva ako ga sustav ugasi).
 */
class AgentService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private val tick = Runnable { cycle() }

    override fun onCreate() {
        super.onCreate()
        val n = Notifier.serviceNotification(this, getString(R.string.service_running))
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(Notifier.SERVICE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(Notifier.SERVICE_ID, n)
        }
        thread = HandlerThread("agent-loop").apply { start() }
        handler = Handler(thread.looper)
        running = true
        scheduleWatchdog(this)
        handler.post(tick)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CHECKIN_NOW && ::handler.isInitialized) {
            handler.removeCallbacks(tick)
            handler.post(tick)
        }
        return START_STICKY
    }

    private fun cycle() {
        val wl = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "erpwms:agent")
        wl.acquire(15 * 60_000L)
        val next = try {
            Agent(this).runOnce()
        } catch (e: Throwable) {
            AgentLog.e("service", "Neočekivana greška", e)
            60
        } finally {
            if (wl.isHeld) wl.release()
        }
        if (next < 0) {
            stopSelf()
            return
        }
        val p = Prefs(this)
        val status = when (p.status) {
            "ENROLLED" -> "Upisano: ${p.deviceName ?: ""}"
            "PENDING" -> "Čeka upis — kod ${p.enrollCode ?: "…"}"
            else -> getString(R.string.service_running)
        }
        runCatching { Notifier.updateService(this, if (p.lastError != null) "$status (greška veze)" else status) }
        handler.postDelayed(tick, next * 1000L)
    }

    override fun onDestroy() {
        running = false
        if (::thread.isInitialized) thread.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_CHECKIN_NOW = "hr.erpwms.mdm.agent.CHECKIN_NOW"
        @Volatile var running = false

        fun start(ctx: Context, checkinNow: Boolean = false) {
            val p = Prefs(ctx)
            if (p.server.isNullOrBlank() || p.status == "RETIRED" || p.status == "FORGOTTEN") return
            val i = Intent(ctx, AgentService::class.java)
            if (checkinNow) i.action = ACTION_CHECKIN_NOW
            try {
                ctx.startForegroundService(i)
            } catch (e: Exception) {
                AgentLog.w("service", "Servis se ne može pokrenuti iz pozadine", e)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, AgentService::class.java))
            val am = ctx.getSystemService(AlarmManager::class.java)
            am.cancel(watchdogIntent(ctx))
        }

        private fun watchdogIntent(ctx: Context) =
            PendingIntent.getBroadcast(ctx, 7, Intent(ctx, AlarmReceiver::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        fun scheduleWatchdog(ctx: Context) {
            val am = ctx.getSystemService(AlarmManager::class.java)
            am.setInexactRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                watchdogIntent(ctx),
            )
        }

        /** Nakon ponovnog pokretanja: kiosk se vraća (servisni izlaz ne preživljava restart). */
        fun restoreKiosk(ctx: Context) {
            val p = Prefs(ctx)
            if (p.kioskEnabled) runCatching { Kiosk.set(ctx, true, p.kioskPackage); Kiosk.launchHome(ctx) }
        }
    }
}

class BootReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AgentLog.i("boot", "Primljeno: ${intent.action}")
        val p = Prefs(context)
        if (p.status == "RETIRED" || p.status == "FORGOTTEN") return
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) AgentService.restoreKiosk(context)
        hr.erpwms.mdm.agent.provisioning.Provisioning.grantPermissions(context)
        AgentService.start(context)
    }
}

/** Rezerva: ako servis ne radi, pokreni ga; ako ga sustav ne dopušta pokrenuti, odradi jedno javljanje. */
class AlarmReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (AgentService.running) return
        val p = Prefs(context)
        if (p.server.isNullOrBlank() || p.status == "RETIRED" || p.status == "FORGOTTEN") return
        try {
            context.startForegroundService(Intent(context, AgentService::class.java))
        } catch (e: Exception) {
            AgentLog.w("alarm", "Servis nije dopušten — jednokratno javljanje", e)
            val pending = goAsync()
            Thread {
                try { Agent(context).runOnce() } finally { pending.finish() }
            }.start()
        }
    }
}
