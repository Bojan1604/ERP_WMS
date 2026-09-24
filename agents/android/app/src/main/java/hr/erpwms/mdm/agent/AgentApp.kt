package hr.erpwms.mdm.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class AgentApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AgentLog.init(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, getString(R.string.channel_service), NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH),
        )
        AgentLog.i("app", "Agent pokrenut, verzija ${BuildConfig.VERSION_NAME}")
    }

    companion object {
        const val CHANNEL_SERVICE = "agent_service"
        const val CHANNEL_MESSAGES = "agent_messages"
    }
}
