package hr.erpwms.mdm.agent.install

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import hr.erpwms.mdm.agent.AgentLog
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/**
 * Tiha instalacija/uklanjanje kroz PackageInstaller. Kao Device Owner sustav
 * ne traži potvrdu korisnika; inače se otvara sistemski dijalog potvrde.
 * Rezultat stiže kao broadcast u [InstallResultReceiver].
 */
object Installer {
    private val waiters = ConcurrentHashMap<Int, CompletableFuture<Pair<Int, String?>>>()
    private val uninstallKeys = AtomicInteger(1_000_000)
    const val EXTRA_KEY = "hr.erpwms.mdm.agent.KEY"

    fun install(ctx: Context, apk: File, packageName: String, timeoutMin: Long = 10) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val sessionId = pi.createSession(params)
        val future = CompletableFuture<Pair<Int, String?>>()
        waiters[sessionId] = future
        try {
            pi.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 64 * 1024) }
                    session.fsync(out)
                }
                session.commit(sender(ctx, sessionId))
            }
            await(future, timeoutMin, "Instalacija $packageName")
        } catch (e: Exception) {
            runCatching { pi.abandonSession(sessionId) }
            throw e
        } finally {
            waiters.remove(sessionId)
        }
    }

    fun uninstall(ctx: Context, packageName: String, timeoutMin: Long = 5) {
        val key = uninstallKeys.incrementAndGet()
        val future = CompletableFuture<Pair<Int, String?>>()
        waiters[key] = future
        try {
            ctx.packageManager.packageInstaller.uninstall(packageName, sender(ctx, key))
            await(future, timeoutMin, "Uklanjanje $packageName")
        } finally {
            waiters.remove(key)
        }
    }

    private fun await(f: CompletableFuture<Pair<Int, String?>>, timeoutMin: Long, what: String) {
        val (status, msg) = try {
            f.get(timeoutMin, TimeUnit.MINUTES)
        } catch (e: TimeoutException) {
            throw IllegalStateException("$what: nema odgovora sustava (istek vremena)")
        }
        if (status != PackageInstaller.STATUS_SUCCESS) throw IllegalStateException("$what nije uspjelo: ${statusName(status)}${msg?.let { " — $it" } ?: ""}")
    }

    private fun sender(ctx: Context, key: Int): android.content.IntentSender {
        val intent = Intent(ctx, InstallResultReceiver::class.java)
            .setAction("hr.erpwms.mdm.agent.PACKAGE_RESULT.$key")
            .putExtra(EXTRA_KEY, key)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(ctx, key, intent, flags).intentSender
    }

    internal fun complete(key: Int, status: Int, message: String?) {
        waiters[key]?.complete(status to message)
    }

    fun statusName(s: Int) = when (s) {
        PackageInstaller.STATUS_SUCCESS -> "SUCCESS"
        PackageInstaller.STATUS_FAILURE -> "FAILURE"
        PackageInstaller.STATUS_FAILURE_ABORTED -> "ABORTED"
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "BLOCKED"
        PackageInstaller.STATUS_FAILURE_CONFLICT -> "CONFLICT"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "INCOMPATIBLE"
        PackageInstaller.STATUS_FAILURE_INVALID -> "INVALID"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "STORAGE"
        PackageInstaller.STATUS_PENDING_USER_ACTION -> "PENDING_USER_ACTION"
        else -> "STATUS_$s"
    }
}

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val key = intent.getIntExtra(Installer.EXTRA_KEY, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Agent nije Device Owner — korisnik mora potvrditi
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            if (confirm != null) {
                AgentLog.i("install", "Potrebna potvrda korisnika")
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                runCatching { context.startActivity(confirm) }.onFailure { Installer.complete(key, status, "Korisnik mora potvrditi, a dijalog se ne može otvoriti") }
                return
            }
        }
        Installer.complete(key, status, msg)
    }
}
