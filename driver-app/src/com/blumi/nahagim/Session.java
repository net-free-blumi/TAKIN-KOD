package com.blumi.nahagim;

import android.content.Context;
import android.content.SharedPreferences;

/** Login token and notification cursor. App-private storage, excluded from backups. */
final class Session {
    private final SharedPreferences prefs;

    Session(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("session", Context.MODE_PRIVATE);
    }

    String token() {
        return prefs.getString("token", "");
    }

    boolean loggedIn() {
        return !token().isEmpty();
    }

    void login(String token) {
        prefs.edit().remove("chatKey").putString("token", token).putLong("cursor", 0).putBoolean("alerts", true).commit();
    }

    void clear() {
        prefs.edit().clear().commit();
    }

    String chatKey() {
        return prefs.getString("chatKey", "");
    }

    void setChatKey(String forToken, String key) {
        if (!forToken.equals(token())) return; // logged out meanwhile
        prefs.edit().putString("chatKey", key).commit();
    }

    /** The server's count of incoming chat messages. Only a number, never content. */
    long chatSeq() {
        return prefs.getLong("chatSeq", 0);
    }

    void setChatSeq(long seq) {
        prefs.edit().putLong("chatSeq", seq).apply();
    }

    long chatNotifiedAt() {
        return prefs.getLong("chatNotifiedAt", 0);
    }

    void setChatNotifiedAt(long at) {
        prefs.edit().putLong("chatNotifiedAt", at).apply();
    }

    /** False while the driver is busy: the background connection sleeps to save battery. */
    boolean searching() {
        return prefs.getBoolean("searching", true);
    }

    void setSearching(boolean on) {
        prefs.edit().putBoolean("searching", on).commit();
    }

    /** The server's count of dispatcher approvals. */
    long apprSeq() {
        return prefs.getLong("apprSeq", 0);
    }

    void setApprSeq(long seq) {
        prefs.edit().putLong("apprSeq", seq).apply();
    }

    long cursor() {
        return prefs.getLong("cursor", 0);
    }

    void setCursor(long cursor) {
        prefs.edit().putLong("cursor", cursor).apply();
    }

    boolean alertsEnabled() {
        return prefs.getBoolean("alerts", true);
    }

    void setAlertsEnabled(boolean enabled) {
        // Skip rides that arrived while alerts were off
        prefs.edit().putBoolean("alerts", enabled).putLong("cursor", 0).commit();
    }
}
