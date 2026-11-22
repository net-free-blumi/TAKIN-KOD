package com.blumi.nahagim;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.webkit.JavascriptInterface;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONException;
import org.json.JSONObject;

/** Exposed only to the bundled page; MainActivity blocks navigation to anything else. */
final class Bridge {
    private final MainActivity activity;
    private final Session session;
    private final Settings settings;
    private final ExecutorService network = Executors.newFixedThreadPool(3);

    Bridge(MainActivity activity) {
        this.activity = activity;
        this.session = new Session(activity);
        this.settings = new Settings(activity);
    }

    @JavascriptInterface
    public void request(int id, String method, String path, String json) {
        if (network.isShutdown()) return;
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
                .put("version", BuildInfo.VERSION)
                .toString();
    }

    @JavascriptInterface
    public String getPref(String key) {
        return key != null && key.matches("saved|last|size") ? settings.page(key) : "";
    }

    @JavascriptInterface
    public void setPref(String key, String json) {
        if (key != null && json != null && key.matches("saved|last|size") && json.length() < 10000) {
            settings.setPage(key, json);
        }
    }

    @JavascriptInterface
    public void setSpeech(boolean on) {
        settings.setSpeech(on);
        if (on) Speech.get(activity).check();
        else Speech.get(activity).stop();
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
    }
}
