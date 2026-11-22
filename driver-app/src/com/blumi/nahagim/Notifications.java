package com.blumi.nahagim;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;

final class Notifications {
    static final int SERVICE_ID = 1;
    private static final int LOGIN_ID = 2;
    private static final String RIDES = "rides";
    private static final String STATUS = "status";
    static final String EXTRA_RIDE = "ride";

    private Notifications() {}

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);

        NotificationChannel rides = new NotificationChannel(RIDES, "נסיעות חדשות", NotificationManager.IMPORTANCE_HIGH);
        rides.enableVibration(true);
        rides.setVibrationPattern(new long[] {0, 350, 150, 350});
        rides.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(rides);

        NotificationChannel status = new NotificationChannel(STATUS, "חיבור להתראות", NotificationManager.IMPORTANCE_LOW);
        status.setShowBadge(false);
        manager.createNotificationChannel(status);
    }

    private static PendingIntent openApp(Context context, String rideId) {
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (!rideId.isEmpty()) {
            // The action keeps each ride's PendingIntent apart
            open.setAction("com.blumi.nahagim.RIDE." + rideId).putExtra(EXTRA_RIDE, rideId);
        }
        return PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static Notification.Builder base(Context context, String channel, String title, String text) {
        return new Notification.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setColor(0xFF18222F)
                .setContentIntent(openApp(context, ""));
    }

    static Notification status(Context context, boolean online) {
        return base(context, STATUS,
                online ? "מחובר, ממתין לנסיעות" : "מתחבר לשרת...",
                "כך ההתראות מגיעות גם כשהאפליקציה סגורה")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    static void updateStatus(Context context, boolean online) {
        context.getSystemService(NotificationManager.class).notify(SERVICE_ID, status(context, online));
    }

    static void ride(Context context, String id, String title, String text) {
        Notification.Builder builder = base(context, RIDES, title, text);
        if (!id.isEmpty()) {
            PendingIntent open = openApp(context, id);
            // Opens the ride for a deliberate tap on "ת". Never sends by itself
            builder.setContentIntent(open).addAction(new Notification.Action.Builder(
                    Icon.createWithResource(context, R.drawable.ic_notify), "✋ לבקשת הנסיעה", open).build());
        }
        Notification notification = builder
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setTimeoutAfter(25 * 60 * 1000L)
                .build();
        context.getSystemService(NotificationManager.class).notify(id, 10, notification);
    }

    static void dismiss(Context context, String id) {
        context.getSystemService(NotificationManager.class).cancel(id, 10);
    }

    static void loginExpired(Context context) {
        context.getSystemService(NotificationManager.class).notify(LOGIN_ID,
                base(context, RIDES, "צריך להתחבר מחדש", "עד שתתחבר לא יגיעו התראות על נסיעות")
                        .setAutoCancel(true)
                        .build());
    }
}
