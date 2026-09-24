package hr.erpwms.mdm.agent

import android.content.Context
import android.util.Log
import hr.erpwms.mdm.agent.core.AgentEvent
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Zapisnik agenta: datoteka s rotacijom (2 × 256 KB) + red događaja koji se
 * šalju poslužitelju pri javljanju (najviše 50).
 */
object AgentLog {
    private const val TAG = "ErpWmsAgent"
    private const val MAX_BYTES = 256 * 1024
    private var dir: File? = null
    private val events = ArrayDeque<AgentEvent>()
    private val lock = Any()

    fun init(ctx: Context) {
        dir = File(ctx.filesDir, "logs").apply { mkdirs() }
    }

    fun logFiles(): List<File> = listOfNotNull(dir?.let { File(it, "agent.log.1") }, dir?.let { File(it, "agent.log") }).filter { it.exists() }

    fun i(type: String, msg: String, report: Boolean = false) = write("info", type, msg, report)
    fun w(type: String, msg: String, e: Throwable? = null) = write("warn", type, msg + (e?.let { ": ${it.message}" } ?: ""), true)
    fun e(type: String, msg: String, e: Throwable? = null) = write("error", type, msg + (e?.let { ": ${it.javaClass.simpleName} ${it.message}" } ?: ""), true)

    fun iso(d: Date = Date()): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(d)

    private fun write(level: String, type: String, msg: String, report: Boolean) {
        when (level) {
            "error" -> Log.e(TAG, "[$type] $msg")
            "warn" -> Log.w(TAG, "[$type] $msg")
            else -> Log.i(TAG, "[$type] $msg")
        }
        val at = iso()
        synchronized(lock) {
            if (report) {
                events.addLast(AgentEvent(at, level, type, msg))
                while (events.size > 50) events.removeFirst()
            }
            val d = dir ?: return
            try {
                val f = File(d, "agent.log")
                if (f.length() > MAX_BYTES) {
                    val old = File(d, "agent.log.1")
                    old.delete()
                    f.renameTo(old)
                }
                File(d, "agent.log").appendText("$at ${level.uppercase()} [$type] $msg\n")
            } catch (_: Exception) {
            }
        }
    }

    /** Preuzima događaje za slanje; ako slanje ne uspije, vraćaju se s [requeue]. */
    fun drainEvents(): List<AgentEvent> = synchronized(lock) { events.toList().also { events.clear() } }

    fun requeue(list: List<AgentEvent>) = synchronized(lock) {
        val merged = list + events.toList()
        events.clear()
        merged.takeLast(50).forEach { events.addLast(it) }
    }

    fun tail(lines: Int = 200): List<String> = synchronized(lock) {
        val f = dir?.let { File(it, "agent.log") } ?: return emptyList()
        if (!f.exists()) emptyList() else f.readLines().takeLast(lines)
    }
}
