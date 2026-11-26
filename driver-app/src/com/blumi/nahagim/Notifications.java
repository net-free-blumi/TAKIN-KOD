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
    private static final String RIDES_SPOKEN = "rides_spoken";
    private static final String RIDES_QUIET = "rides_quiet";
    private static final String RIDES_SILENT = "rides_silent";
    static final String ACTION_SOUND = "com.blumi.nahagim.SOUND";
    private static final android.os.Handler MAIN = new android.os.Handler(android.os.Looper.getMainLooper());
    private static final String OLD_STATUS = "status";
    private static final String STATUS = "status_quiet";
    private static final String CHATS = "chats";
    private static final int CHAT_ID = 20;
    static final String EXTRA_RIDE = "ride";
    static final String EXTRA_CHAT = "chat";
    static final String EXTRA_RIDE_CHAT = "rideChat";
    static final String EXTRA_PUBLISH = "publish";

    private Notifications() {}

    static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);

        NotificationChannel rides = new NotificationChannel(RIDES, "נסיעות חדשות", NotificationManager.IMPORTANCE_HIGH);
        rides.enableVibration(true);
        rides.setVibrationPattern(new long[] {0, 350, 150, 350});
        rides.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(rides);

        NotificationChannel spoken = new NotificationChannel(
                RIDES_SPOKEN, "נסיעות עם הקראה", NotificationManager.IMPORTANCE_HIGH);
        spoken.setSound(null, null); // the beep and the voice are the sound
        spoken.enableVibration(true);
        spoken.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(spoken);

        NotificationChannel chats = new NotificationChannel(CHATS, "הודעות בצ'אטים", NotificationManager.IMPORTANCE_DEFAULT);
        chats.setSound(null, null); // silent, as the driver asked
        chats.enableVibration(false);
        chats.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(chats);

        // "🔇 השתק": the ride still pops up, without sound or vibration
        NotificationChannel silent = new NotificationChannel(RIDES_SILENT, "נסיעות בלי קול", NotificationManager.IMPORTANCE_HIGH);
        silent.setSound(null, null);
        silent.enableVibration(false);
        silent.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(silent);

        // Same ride after its pop-up time: stays in the list without popping up again
        NotificationChannel quiet = new NotificationChannel(RIDES_QUIET, "נסיעות ברשימה", NotificationManager.IMPORTANCE_DEFAULT);
        quiet.setSound(null, null);
        quiet.enableVibration(false);
        quiet.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(quiet);

        // The "connected" line must never pop up or make a sound. Some phones raised the old channel,
        // and a channel's importance can't be lowered after it exists, so it moves to a new one
        manager.deleteNotificationChannel(OLD_STATUS);
        NotificationChannel status = new NotificationChannel(STATUS, "חיבור להתראות (שקט)", NotificationManager.IMPORTANCE_MIN);
        status.setShowBadge(false);
        status.setSound(null, null);
        status.enableVibration(false);
        status.enableLights(false);
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
        Notification.Builder builder = base(context, STATUS,
                online ? "מחובר, ממתין לנסיעות" : "מתחבר לשרת...",
                "כך ההתראות מגיעות גם כשהאפליקציה סגורה")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE);
        // No pop-up, sound or vibration: the new MIN channel ("status_quiet") has none
        return builder.build();
    }

    static void updateStatus(Context context, boolean online) {
        context.getSystemService(NotificationManager.class).notify(SERVICE_ID, status(context, online));
    }

    static void ride(Context context, String id, String title, String text) {
        ride(context, id, title, text, false);
    }

    static void ride(Context context, String id, String title, String text, boolean spoken) {
        boolean muted = new Settings(context).soundMuted();
        post(context, id, title, text, muted ? RIDES_SILENT : spoken ? RIDES_SPOKEN : RIDES);
        int seconds = new Settings(context).popupSeconds();
        if (seconds <= 0 || id.isEmpty()) return;
        Context app = context.getApplicationContext();
        // Android has no pop-up length, so the ride is posted again quietly. Already dismissed = nothing
        MAIN.postDelayed(() -> {
            if (showing(app, id)) post(app, id, title, text, RIDES_QUIET);
        }, seconds * 1000L);
    }

    /** After "🔇" / "🔊": the same ride again in the list, quietly, with the other button */
    static void repostQuiet(Context context, String id, String title, String text) {
        if (!id.isEmpty() && showing(context, id)) post(context, id, title, text, RIDES_QUIET);
    }

    private static boolean showing(Context context, String id) {
        for (android.service.notification.StatusBarNotification shown
                : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
            if (shown.getId() == 10 && id.equals(shown.getTag())) return true;
        }
        return false;
    }

    private static void post(Context context, String id, String title, String text, String channel) {
        Notification.Builder builder = base(context, channel, title, text);
        if (!id.isEmpty()) {
            PendingIntent open = openApp(context, id);
            // Opens the ride for a deliberate tap on "ת". Never sends by itself
            builder.setContentIntent(open).addAction(new Notification.Action.Builder(
                    Icon.createWithResource(context, R.drawable.ic_notify), "✋ לבקשת הנסיעה", open).build());
            // Mute or bring back the ride sound without opening the app or stopping the search
            boolean muted = new Settings(context).soundMuted();
            Intent sound = new Intent(context, SoundReceiver.class)
                    .setAction(ACTION_SOUND + "." + id)
                    .putExtra("mute", !muted)
                    .putExtra("id", id)
                    .putExtra("title", title)
                    .putExtra("text", text);
            PendingIntent toggle = PendingIntent.getBroadcast(context, 1, sound,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            builder.addAction(new Notification.Action.Builder(
                    Icon.createWithResource(context, R.drawable.ic_notify), muted ? "🔊 החזר קול" : "🔇 השתק", toggle).build());
        }
        Notification notification = builder
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setTimeoutAfter(new Settings(context).alertMinutes() * 60 * 1000L)
                .build();
        context.getSystemService(NotificationManager.class).notify(id, 10, notification);
    }

    static void chat(Context context, String chatId, String title, String text, int unread) {
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .setAction("com.blumi.nahagim.CHAT." + chatId)
                .putExtra(EXTRA_CHAT, chatId);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = base(context, CHATS, title, text)
                .setContentIntent(tap)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setNumber(unread)
                .setAutoCancel(true)
                .setTimeoutAfter(60 * 60 * 1000L)
                .build();
        context.getSystemService(NotificationManager.class).notify("chat:" + chatId, CHAT_ID, notification);
    }

    /** The dispatcher wrote "ק" or similar: one tap to the chat with them. */
    static void approved(Context context, String rideId, String route, String dispatcher) {
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .setAction("com.blumi.nahagim.APPROVED." + rideId)
                .putExtra(EXTRA_RIDE_CHAT, rideId);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String text = (route.isEmpty() ? "הנסיעה שביקשת" : route) + (dispatcher.isEmpty() ? "" : " · " + dispatcher);
        Notification notification = base(context, RIDES, "✅ הסדרן אישר לך את הנסיעה", text)
                .setContentIntent(tap)
                .addAction(new Notification.Action.Builder(
                        Icon.createWithResource(context, R.drawable.ic_notify), "💬 לצ'אט עם הסדרן", tap).build())
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setTimeoutAfter(60 * 60 * 1000L)
                .build();
        context.getSystemService(NotificationManager.class).notify("ok:" + rideId, 30, notification);
    }

    /** Someone asked for the ride the driver published, or the publishing stopped. Opens the publish tab. */
    static void publish(Context context, String tag, String title, String text) {
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .setAction("com.blumi.nahagim.PUBLISH." + tag)
                .putExtra(EXTRA_PUBLISH, "1");
        PendingIntent tap = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = base(context, RIDES, title, text)
                .setContentIntent(tap)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setTimeoutAfter(3 * 60 * 60 * 1000L)
                .build();
        context.getSystemService(NotificationManager.class).notify("pub:" + tag, 40, notification);
    }

    static void cancelChats(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification shown : manager.getActiveNotifications()) {
            if (shown.getId() == CHAT_ID) manager.cancel(shown.getTag(), CHAT_ID);
        }
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
