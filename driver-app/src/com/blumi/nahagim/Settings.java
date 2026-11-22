package com.blumi.nahagim;

import android.content.Context;
import android.content.SharedPreferences;

/** The driver's preferences on this phone. Kept apart from Session, so logout does not erase them. */
final class Settings {
    private final SharedPreferences prefs;

    Settings(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("settings", Context.MODE_PRIVATE);
    }

    String page(String key) {
        return prefs.getString("page." + key, "");
    }

    void setPage(String key, String value) {
        prefs.edit().putString("page." + key, value).apply();
    }

    boolean speech() {
        return prefs.getBoolean("speech", false);
    }

    void setSpeech(boolean on) {
        prefs.edit().putBoolean("speech", on).commit();
    }

    String speechMode() {
        return prefs.getString("speechMode", "full");
    }

    void setSpeechMode(String mode) {
        prefs.edit().putString("speechMode", mode).commit();
    }

    boolean respectQuiet() {
        return prefs.getBoolean("respectQuiet", false);
    }

    void setRespectQuiet(boolean on) {
        prefs.edit().putBoolean("respectQuiet", on).commit();
    }

    boolean location() {
        return prefs.getBoolean("location", false);
    }

    void setLocation(boolean on) {
        prefs.edit().putBoolean("location", on).commit();
    }

    int maxKm() {
        return prefs.getInt("maxKm", 0);
    }

    void setMaxKm(int km) {
        prefs.edit().putInt("maxKm", km).commit();
    }

    String speechRate() {
        return prefs.getString("speechRate", "normal");
    }

    void setSpeechRate(String rate) {
        prefs.edit().putString("speechRate", rate).commit();
    }
}
