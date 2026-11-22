package com.blumi.nahagim;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.net.HttpURLConnection;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Push without Firebase: keeps one request open and the server answers when a ride arrives.
 * Needs a foreground service, plus a battery-optimization exemption on Samsung.
 */
public final class PushService extends Service {
    private static final String TAG = "PushService";
    private static final int WAIT_SECONDS = 55;
    private static final int READ_TIMEOUT_MS = (WAIT_SECONDS + 15) * 1000;
    private static final int MAX_RETRY_MS = 60000;

    private final Object retrySignal = new Object();
    private volatile boolean running;
    private volatile HttpURLConnection current;
    private volatile boolean connected;
    private Thread worker;
    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager.NetworkCallback networkCallback;

    /** Starts or stops the service according to login state and the driver's setting. */
    static void sync(Context context) {
        Session session = new Session(context);
        Intent intent = new Intent(context, PushService.class);
        if (!session.loggedIn() || !session.alertsEnabled()) {
            context.stopService(intent);
            return;
        }
        try {
            context.startForegroundService(intent);
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot start from background; will start when the app opens", e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Notifications.createChannels(this);
        showForeground();

        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nahagim:alerts");
        wakeLock.setReferenceCounted(false);

        networkCallback = new ConnectivityManager.NetworkCallback() {
            private Network last;

            @Override
            public void onAvailable(Network network) {
                if (last != null && !last.equals(network)) abortRequest(); // Wi-Fi <-> mobile
                last = network;
                synchronized (retrySignal) {
                    retrySignal.notifyAll();
                }
            }
        };
        getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback);

        running = true;
        worker = new Thread(this::loop, "ride-alerts");
        worker.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        showForeground(); // required after every startForegroundService call
        Session session = new Session(this);
        if (!session.loggedIn() || !session.alertsEnabled()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private void showForeground() {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(Notifications.SERVICE_ID, Notifications.status(this, connected),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(Notifications.SERVICE_ID, Notifications.status(this, connected));
        }
    }

    private void loop() {
        Session session = new Session(this);
        int retryMs = 2000;
        boolean online = false;

        while (running) {
            String token = session.token();
            if (token.isEmpty()) break;
            long cursor = session.cursor();
            try {
                // Renewed on every request, so it cannot leak if the loop dies
                wakeLock.acquire(READ_TIMEOUT_MS + MAX_RETRY_MS);
                current = Api.open("GET", "/api/app/events?wait=" + WAIT_SECONDS + "&after=" + cursor, token,
                        READ_TIMEOUT_MS);
                Api.Response response = Api.exchange(current, null);
                if (!running) break;
                if (!token.equals(session.token())) continue;

                if (response.status == 401) {
                    session.clear();
                    Notifications.loginExpired(this);
                    stopSelf();
                    break;
                }
                if (response.status != 200) throw new IllegalStateException("status " + response.status);

                if (!online) {
                    online = true;
                    connected = true;
                    Notifications.updateStatus(this, true);
                }
                retryMs = 2000;
                showRides(response.body.optJSONArray("rides"));
                session.setCursor(response.body.getLong("cursor"));
            } catch (Exception e) {
                if (!running) break;
                Log.w(TAG, "connection failed: " + e);
                if (online) {
                    online = false;
                    connected = false;
                    Notifications.updateStatus(this, false);
                }
                synchronized (retrySignal) {
                    try {
                        retrySignal.wait(retryMs);
                    } catch (InterruptedException stop) {
                        break;
                    }
                }
                retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
            } finally {
                current = null;
            }
        }
    }

    private void showRides(JSONArray rides) {
        if (rides == null) return;
        for (int i = 0; i < rides.length(); i++) {
            JSONObject ride = rides.optJSONObject(i);
            if (ride == null) continue;
            String title = "נסיעה חדשה";
            // An older server can mistake a departure time for the price
            double price = ride.optBoolean("checked") ? ride.optDouble("price", 0) : 0;
            if (price > 0) title += " · ₪" + Math.round(price);
            Notifications.ride(this, ride.optString("id"), title, ride.optString("text"));
            Speech.get(this).announce(ride);
        }
        if (rides.length() > 0) MainActivity.refreshIfOpen();
    }

    private void abortRequest() {
        HttpURLConnection connection = current;
        if (connection != null) new Thread(connection::disconnect).start();
    }

    @Override
    public void onDestroy() {
        running = false;
        abortRequest();
        worker.interrupt();
        getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
        if (wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
