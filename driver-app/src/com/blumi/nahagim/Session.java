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
