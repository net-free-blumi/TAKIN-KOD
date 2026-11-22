package com.blumi.nahagim;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.WindowInsets;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.lang.ref.WeakReference;

import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String PAGE = "file:///android_asset/index.html";
    private static volatile WeakReference<MainActivity> visible = new WeakReference<>(null);

    private WebView web;
    private Bridge bridge;
    private volatile String rideToOpen = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Notifications.createChannels(this);
        // Not again when Android recreates the screen
        if (savedInstanceState == null) readRide(getIntent());

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(false); // android_asset still loads
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !PAGE.equals(request.getUrl().toString());
            }
        });
        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "Native");

        // Android 15 draws edge to edge, so keep clear of system bars and the keyboard
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.addView(web);
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            root.setFitsSystemWindows(true);
        }
        setContentView(root);
        web.loadUrl(PAGE);

        if (new Session(this).loggedIn()) askNotificationPermission();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = new WeakReference<>(this);
        PushService.sync(this);
        Speech.get(this).check();
        run("window.onNativeResume && window.onNativeResume()");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        readRide(intent);
    }

    private void readRide(Intent intent) {
        if (intent == null || (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String id = intent.getStringExtra(Notifications.EXTRA_RIDE);
        if (id == null || id.isEmpty()) return;
        rideToOpen = id;
        Speech.get(this).stop();
    }

    String takeRide() {
        String id = rideToOpen;
        rideToOpen = "";
        return id;
    }

    static void voiceChanged() {
        MainActivity activity = visible.get();
        if (activity != null) activity.run("window.onNativeVoice && window.onNativeVoice()");
    }

    @Override
    protected void onPause() {
        visible.clear();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        bridge.close();
        web.destroy();
        web = null;
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("!!(window.onNativeBack && window.onNativeBack())", handled -> {
            if (!"true".equals(handled)) moveTaskToBack(true);
        });
    }

    static void refreshIfOpen() {
        MainActivity activity = visible.get();
        if (activity != null) activity.run("window.onNativeRide && window.onNativeRide()");
    }

    private void run(String script) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(script, null);
        });
    }

    void reply(int id, String json) {
        run("window.onNativeReply(" + id + "," + JSONObject.quote(json) + ")");
    }

    void onLoggedIn() {
        runOnUiThread(() -> {
            PushService.sync(this);
            askNotificationPermission();
        });
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    boolean notificationsAllowed() {
        return getSystemService(NotificationManager.class).areNotificationsEnabled();
    }

    boolean batteryUnrestricted() {
        return getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
    }

    void openNotificationSettings() {
        start(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
    }

    @SuppressLint("BatteryLife")
    void requestBatteryExemption() {
        start(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getPackageName())));
    }

    void openVoiceSettings() {
        try {
            startActivity(new Intent("com.android.settings.TTS_SETTINGS"));
        } catch (ActivityNotFoundException e) {
            start(new Intent(android.provider.Settings.ACTION_SETTINGS));
        }
    }

    void openExternal(String url) {
        Uri uri = Uri.parse(url);
        start(new Intent("tel".equals(uri.getScheme()) ? Intent.ACTION_DIAL : Intent.ACTION_VIEW, uri));
    }

    private void start(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "אין בטלפון אפליקציה לפעולה הזו", Toast.LENGTH_LONG).show();
        }
    }
}
