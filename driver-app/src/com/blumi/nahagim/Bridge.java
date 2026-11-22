package com.blumi.nahagim;

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
    private final ExecutorService network = Executors.newFixedThreadPool(3);

    Bridge(MainActivity activity) {
        this.activity = activity;
        this.session = new Session(activity);
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
                .put("version", BuildInfo.VERSION)
                .toString();
    }

    @JavascriptInterface
    public void setAlerts(boolean enabled) {
        session.setAlertsEnabled(enabled);
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
        Notifications.ride(activity, "test", "בדיקת התראה", "כך תיראה התראה על נסיעה חדשה");
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
