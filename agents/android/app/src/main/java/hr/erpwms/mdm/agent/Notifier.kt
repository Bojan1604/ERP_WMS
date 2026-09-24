package hr.erpwms.mdm.agent

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import hr.erpwms.mdm.agent.ui.MainActivity
import hr.erpwms.mdm.agent.ui.MessageActivity

object Notifier {
    const val SERVICE_ID = 1
    private var nextId = 100

    fun serviceNotification(ctx: Context, text: String): Notification {
        val pi = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(ctx, AgentApp.CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(ctx.getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .build()
    }

    fun updateService(ctx: Context, text: String) {
        ctx.getSystemService(NotificationManager::class.java).notify(SERVICE_ID, serviceNotification(ctx, text))
    }

    /** Poruka administratora: obavijest + dijalog preko cijelog zaslona. */
    fun showMessage(ctx: Context, text: String) {
        val id = nextId++
        val intent = Intent(ctx, MessageActivity::class.java)
            .putExtra(MessageActivity.EXTRA_TEXT, text)
            .putExtra(MessageActivity.EXTRA_NOTIFICATION_ID, id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
        val pi = PendingIntent.getActivity(ctx, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(ctx, AgentApp.CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle("Poruka administratora")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(id, n)
        runCatching { ctx.startActivity(intent) }
    }

    fun notify(ctx: Context, id: Int, title: String, text: String, target: Intent?) {
        val b = Notification.Builder(ctx, AgentApp.CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_agent)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
        if (target != null) b.setContentIntent(PendingIntent.getActivity(ctx, id, target, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        ctx.getSystemService(NotificationManager::class.java).notify(id, b.build())
    }

    fun cancel(ctx: Context, id: Int) = ctx.getSystemService(NotificationManager::class.java).cancel(id)
}
