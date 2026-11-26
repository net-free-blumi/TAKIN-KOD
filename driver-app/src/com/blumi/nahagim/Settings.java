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

    /** "🔇 השתק" from a ride notification: no voice and no ride sound, rides still pop up. The search keeps running */
    boolean soundMuted() {
        return prefs.getBoolean("soundMuted", false);
    }

    void setSoundMuted(boolean on) {
        prefs.edit().putBoolean("soundMuted", on).commit();
    }

    String speechMode() {
        // Address, neighbourhood and destination by default: the drivers asked not to hear whole messages
        return prefs.getString("speechMode", "detail");
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

    /** The price is read only when the driver asks for it. */
    boolean speakPrice() {
        return prefs.getBoolean("speakPrice", false);
    }

    void setSpeakPrice(boolean on) {
        prefs.edit().putBoolean("speakPrice", on).commit();
    }

    /** Percent of the media volume, 10 to 100. */
    int speechVolume() {
        return prefs.getInt("speechVolume", 100);
    }

    void setSpeechVolume(int percent) {
        prefs.edit().putInt("speechVolume", percent).commit();
    }

    /** How long a ride stays in the notification shade. */
    int alertMinutes() {
        return prefs.getInt("alertMinutes", 25);
    }

    void setAlertMinutes(int minutes) {
        prefs.edit().putInt("alertMinutes", minutes).commit();
    }

    /** Seconds the ride pops up on the screen. 0 = the phone decides. */
    int popupSeconds() {
        return prefs.getInt("popupSeconds", 0);
    }

    void setPopupSeconds(int seconds) {
        prefs.edit().putInt("popupSeconds", seconds).commit();
    }

    /** Chats the driver muted, as a JSON array of chat ids. */
    String mutedChats() {
        return prefs.getString("mutedChats", "[]");
    }

    void setMutedChats(String json) {
        prefs.edit().putString("mutedChats", json).commit();
    }

    boolean chatMuted(String id) {
        try {
            org.json.JSONArray list = new org.json.JSONArray(mutedChats());
            for (int i = 0; i < list.length(); i++) if (id.equals(list.optString(i))) return true;
        } catch (org.json.JSONException e) {
            return false;
        }
        return false;
    }

    /** Silent notifications for new WhatsApp chat messages, only while searching. */
    boolean chatAlerts() {
        return prefs.getBoolean("chatAlerts", true);
    }

    void setChatAlerts(boolean on) {
        prefs.edit().putBoolean("chatAlerts", on).commit();
    }
}
