package com.blumi.nahagim;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.webkit.JavascriptInterface;

import java.io.IOException;
import java.net.URLEncoder;
import java.security.GeneralSecurityException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONException;
import org.json.JSONObject;

/** Exposed only to the bundled page; MainActivity blocks navigation to anything else. */
final class Bridge {
    private final MainActivity activity;
    private final Session session;
    private final Settings settings;
    private final ExecutorService network = Executors.newFixedThreadPool(5);
    private final ExecutorService chatNetwork = Executors.newFixedThreadPool(4);
    private final ChatLink chats;
    private static final String PREFS = "saved|last|size|compact|theme|showKm|showEta|askBusy|logRange";

    Bridge(MainActivity activity) {
        this.activity = activity;
        this.session = new Session(activity);
        this.settings = new Settings(activity);
        this.chats = new ChatLink(session);
    }

    @JavascriptInterface
    public void request(int id, String method, String path, String json) {
        if (network.isShutdown()) return;
        // Chats only through secure(), never as plain text
        if (path != null && path.startsWith("/api/app/chat")) return;
        network.execute(() -> {
            JSONObject result = new JSONObject();
            try {
                try {
                    String token = session.token();
                    Api.Response response = Api.call(method, path, json, token, 25000);
                    int status = response.status;

                    if (status == 200 && "/api/app/auth/verify".equals(path)) {
                        session.login(String.valueOf(response.body.remove("token")));
                        activity.onLoggedIn();
                    } else if ((status == 401 && token.equals(session.token()))
                            || (status == 200 && "/api/app/logout".equals(path))) {
                        session.clear();
                        Speech.get(activity).stop();
                        PushService.sync(activity);
                    }
                    result.put("status", status).put("body", response.body);
                } catch (IOException e) {
                    result.put("status", 0);
                }
            } catch (JSONException e) {
                return;
            }
            activity.reply(id, result.toString());
        });
    }

    /** Chat operations. "start" begins pairing, the rest are encrypted. */
    @JavascriptInterface
    public void secure(int id, String operation, String argsJson) {
        if (operation == null || chatNetwork.isShutdown()) return;
        chatNetwork.execute(() -> {
            JSONObject result = new JSONObject();
            try {
                try {
                    result = "start".equals(operation) ? chats.start() : chats.call(operation, argsJson);
                } catch (IOException e) {
                    result.put("status", 0);
                } catch (GeneralSecurityException e) {
                    result.put("status", 502).put("body",
                            new JSONObject().put("error", "החיבור המוצפן נכשל. חבר מחדש את הצ'אטים."));
                }
            } catch (JSONException e) {
                return;
            }
            activity.reply(id, result.toString());
        });
    }

    @JavascriptInterface
    public void forgetChats() {
        session.setChatKey(session.token(), "");
    }

    @JavascriptInterface
    public void confirmInWhatsApp(String number, String text) {
        if (number == null || !number.matches("[1-9][0-9]{8,14}")) return;
        if (text == null || !text.matches("אישור צאטים [0-9A-F]{16}")) return;
        try {
            String url = "https://wa.me/" + number + "?text=" + URLEncoder.encode(text, "UTF-8").replace("+", "%20");
            activity.runOnUiThread(() -> activity.openExternal(url));
        } catch (java.io.UnsupportedEncodingException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    @JavascriptInterface
    public void openPoint(double lat, double lng) {
        if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return;
        String url = String.format(Locale.US, "https://waze.com/ul?ll=%f,%f&navigate=yes", lat, lng);
        activity.runOnUiThread(() -> activity.openExternal(url));
    }

    @JavascriptInterface
    public void setLocation(boolean on) {
        settings.setLocation(on);
        if (on) activity.runOnUiThread(activity::requestLocation);
        else activity.runOnUiThread(activity::locationChanged);
    }

    @JavascriptInterface
    public void setMaxKm(int km) {
        if (km >= 0 && km <= 300) settings.setMaxKm(km);
    }

    @JavascriptInterface
    public double distance(double lat, double lng) {
        return Locator.get(activity).km(lat, lng);
    }

    @JavascriptInterface
    public void setRespectQuiet(boolean on) {
        settings.setRespectQuiet(on);
    }

    @JavascriptInterface
    public String state() throws JSONException {
        return new JSONObject()
                .put("loggedIn", session.loggedIn())
                .put("alerts", session.alertsEnabled())
                .put("notifications", activity.notificationsAllowed())
                .put("battery", activity.batteryUnrestricted())
                .put("speech", settings.speech())
                .put("speechMode", settings.speechMode())
                .put("speechRate", settings.speechRate())
                .put("voice", Speech.get(activity).voice())
                .put("muted", Speech.get(activity).muted())
                .put("respectQuiet", settings.respectQuiet())
                .put("chatKey", !session.chatKey().isEmpty())
                .put("location", settings.location())
                .put("locationAllowed", Locator.allowed(activity))
                .put("maxKm", settings.maxKm())
                .put("speechVolume", settings.speechVolume())
                .put("alertMinutes", settings.alertMinutes())
                .put("chatAlerts", settings.chatAlerts())
                .put("night", activity.isNight())
                .put("popupSeconds", settings.popupSeconds())
                .put("mutedChats", new org.json.JSONArray(settings.mutedChats()))
                .put("sleeping", !session.searching())
                .put("version", BuildInfo.VERSION)
                .toString();
    }

    @JavascriptInterface
    public String getPref(String key) {
        return key != null && key.matches(PREFS) ? settings.page(key) : "";
    }

    @JavascriptInterface
    public void setPref(String key, String json) {
        if (key != null && json != null && key.matches(PREFS) && json.length() < 10000) {
            settings.setPage(key, json);
        }
    }

    @JavascriptInterface
    public void setSpeech(boolean on) {
        settings.setSpeech(on);
        if (on) {
            Speech.get(activity).check();
            // Rides are read by the alert service, so it must run
            if (!session.alertsEnabled()) {
                session.setAlertsEnabled(true);
                PushService.sync(activity);
            }
        } else {
            Speech.get(activity).stop();
        }
    }

    @JavascriptInterface
    public void setSpeechMode(String mode) {
        if ("full".equals(mode) || "short".equals(mode)) settings.setSpeechMode(mode);
    }

    @JavascriptInterface
    public void setSpeechRate(String rate) {
        if (rate != null && rate.matches("slow|normal|fast")) settings.setSpeechRate(rate);
    }

    @JavascriptInterface
    public void setSpeechVolume(int percent) {
        if (percent >= 10 && percent <= 100) settings.setSpeechVolume(percent);
    }

    @JavascriptInterface
    public void setAlertMinutes(int minutes) {
        if (minutes >= 1 && minutes <= 120) settings.setAlertMinutes(minutes);
    }

    @JavascriptInterface
    public void setChatAlerts(boolean on) {
        settings.setChatAlerts(on);
    }

    @JavascriptInterface
    public void setPopupSeconds(int seconds) {
        if (seconds >= 0 && seconds <= 60) settings.setPopupSeconds(seconds);
    }

    @JavascriptInterface
    public void setMutedChats(String json) {
        if (json == null || json.length() > 20000) return;
        try {
            org.json.JSONArray list = new org.json.JSONArray(json);
            org.json.JSONArray clean = new org.json.JSONArray();
            for (int i = 0; i < list.length() && i < 200; i++) {
                String id = list.optString(i);
                if (id.matches("[0-9]{5,20}@(s\\.whatsapp\\.net|lid|bot)")) clean.put(id);
            }
            settings.setMutedChats(clean.toString());
        } catch (JSONException e) {
            // ignored: the old list stays
        }
    }

    /** The page reports the search state. Busy = the background connection sleeps. */
    @JavascriptInterface
    public void setSearching(boolean on) {
        if (on == session.searching()) return;
        session.setSearching(on);
        activity.runOnUiThread(() -> PushService.sync(activity));
    }

    @JavascriptInterface
    public void setDark(boolean dark) {
        activity.runOnUiThread(() -> activity.setDark(dark));
    }

    @JavascriptInterface
    public String takeChat() {
        return activity.takeChat();
    }

    /** Real driving distance, only on the driver's tap. */
    @JavascriptInterface
    public void route(int id, double lat, double lng, String query) {
        if (network.isShutdown()) return;
        network.execute(() -> {
            try {
                activity.reply(id, RoutePlanner.plan(Locator.get(activity), lat, lng, query).toString());
            } catch (JSONException e) {
                activity.reply(id, "{\"status\":0}");
            }
        });
    }

    @JavascriptInterface
    public void speak(String text) {
        if (text != null) Speech.get(activity).say(text);
    }

    @JavascriptInterface
    public void stopSpeaking() {
        Speech.get(activity).stop();
    }

    @JavascriptInterface
    public void fixVoice() {
        activity.runOnUiThread(activity::openVoiceSettings);
    }

    @JavascriptInterface
    public String takeRide() {
        return activity.takeRide();
    }

    @JavascriptInterface
    public void dismiss(String id) {
        if (id != null) Notifications.dismiss(activity, id);
    }

    @JavascriptInterface
    public void copy(String text) {
        if (text == null) return;
        activity.runOnUiThread(() -> activity.getSystemService(ClipboardManager.class)
                .setPrimaryClip(ClipData.newPlainText("נסיעה", text)));
    }

    @JavascriptInterface
    public void whatsapp(String number) {
        if (number != null && number.matches("[1-9][0-9]{8,14}")) {
            activity.runOnUiThread(() -> activity.openExternal("https://wa.me/" + number));
        }
    }

    @JavascriptInterface
    public void setAlerts(boolean enabled) {
        session.setAlertsEnabled(enabled);
        if (!enabled) Speech.get(activity).stop();
        PushService.sync(activity);
    }

    @JavascriptInterface
    public void fixNotifications() {
        activity.runOnUiThread(activity::openNotificationSettings);
    }

    @JavascriptInterface
    public void fixBattery() {
        activity.runOnUiThread(activity::requestBatteryExemption);
    }

    @JavascriptInterface
    public void testNotification() {
        Notifications.ride(activity, "", "בדיקת התראה", "כך תיראה התראה על נסיעה חדשה");
    }

    @JavascriptInterface
    public void dial(String number) {
        if (number != null && number.matches("\\+?\\d{9,15}")) {
            activity.runOnUiThread(() -> activity.openExternal("tel:" + number));
        }
    }

    @JavascriptInterface
    public void navigate(String url) {
        if (url != null && url.startsWith("https://waze.com/")) {
            activity.runOnUiThread(() -> activity.openExternal(url));
        }
    }

    void close() {
        network.shutdown();
        chatNetwork.shutdown();
    }
}
