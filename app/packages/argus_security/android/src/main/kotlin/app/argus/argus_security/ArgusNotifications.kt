package app.argus.argus_security

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Phone notifications (ADR-0025). When the app is closed or in the background, Android shows
 * FCM notifications itself on the "argus_notices" channel. When the app is open, FCM hands the
 * message to [ArgusMessagingService] instead, which shows the same notification.
 */
object ArgusNotifications {
    const val CHANNEL_ID = "argus_notices"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Class changes and attendance", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Room changes, cancelled classes, announcements and \"attendance is open\"."
            },
        )
    }

    fun show(context: Context, title: String?, body: String?) {
        ensureChannel(context)
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val tap = launch?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_argus)
            .setColor(0xFFE8683A.toInt())
            .setContentTitle(title ?: "Argus")
            .setContentText(body ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText(body ?: ""))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .apply { if (tap != null) setContentIntent(tap) }
            .build()
        try {
            NotificationManagerCompat.from(context).notify(System.currentTimeMillis().toInt(), n)
        } catch (_: SecurityException) {
            // Notifications not allowed (Android 13+ permission refused): the notice is still in the app.
        }
    }
}

class ArgusMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val n = message.notification ?: return
        ArgusNotifications.show(applicationContext, n.title, n.body)
    }

    override fun onNewToken(token: String) {
        // The app sends its current token to Argus every time it opens.
    }
}
