package com.blumi.nahagim;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/** "🔇 השתק" / "🔊 החזר קול" on a ride notification. Only from our own notification (not exported). */
public final class SoundReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null || !action.startsWith(Notifications.ACTION_SOUND)) return;
        boolean mute = intent.getBooleanExtra("mute", true);
        new Settings(context).setSoundMuted(mute);
        if (mute) Speech.get(context).stop();
        Toast.makeText(context, mute ? "הקול של הנסיעות כבוי. החיפוש ממשיך" : "הקול של הנסיעות חזר", Toast.LENGTH_SHORT).show();
        Notifications.repostQuiet(context,
                String.valueOf(intent.getStringExtra("id")),
                String.valueOf(intent.getStringExtra("title")),
                String.valueOf(intent.getStringExtra("text")));
        MainActivity.refreshIfOpen();
    }
}
