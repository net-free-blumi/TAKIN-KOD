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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
    private final ExecutorService chatWorker = Executors.newSingleThreadExecutor();
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
        // Busy = asleep: no background connection, no location, no battery
        if (!session.loggedIn() || !session.alertsEnabled() || !session.searching()) {
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
        startWorker();
        Speech.get(this).check(); // so the first ride is not waiting for the voice engine
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        showForeground(); // required after every startForegroundService call
        Session session = new Session(this);
        if (!session.loggedIn() || !session.alertsEnabled() || !session.searching()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!worker.isAlive()) startWorker();
        Locator.get(this).use("service", true);
        return START_STICKY;
    }

    private void startWorker() {
        worker = new Thread(this::loop, "ride-alerts");
        worker.start();
    }

    private void showForeground() {
        int id = Notifications.SERVICE_ID;
        boolean location = Build.VERSION.SDK_INT >= 29 && Locator.get(this).active();
        int special = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        if (location) {
            try {
                startForeground(id, Notifications.status(this, connected),
                        special | ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
                return;
            } catch (RuntimeException e) {
                // Not allowed from the background (after boot). Alerts matter more than distance
                Log.w(TAG, "no location in background until the app opens", e);
            }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            // Naming the type matters: the default would include location
            startForeground(id, Notifications.status(this, connected), special);
        } else {
            startForeground(id, Notifications.status(this, connected));
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
                String chat = session.chatKey().isEmpty() ? "" : "&chat=" + session.chatSeq();
                current = Api.open("GET", "/api/app/events?wait=" + WAIT_SECONDS + "&after=" + cursor + chat, token,
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
                newChatMessages(session, response.body.optJSONObject("chat"));
                if (!response.body.optBoolean("searching", true)) {
                    // Busy, or the nightly stop: sleep until the driver searches again in the app
                    session.setSearching(false);
                    stopSelf();
                    break;
                }
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
        Speech speech = Speech.get(this);
        for (int i = 0; i < rides.length(); i++) {
            JSONObject ride = rides.optJSONObject(i);
            if (ride == null || !Locator.get(this).withinRange(ride)) continue;
            String title = "נסיעה חדשה";
            // An older server can mistake a departure time for the price
            double price = ride.optBoolean("checked") ? ride.optDouble("price", 0) : 0;
            if (price > 0) title += " · ₪" + Math.round(price);
            Notifications.ride(this, ride.optString("id"), title, ride.optString("text"), speech.willRead());
            speech.announce(ride);
        }
        if (rides.length() > 0) MainActivity.refreshIfOpen();
    }

    /** The server sends only a counter. The messages come over the encrypted channel. */
    private void newChatMessages(Session session, JSONObject signal) {
        if (signal == null || session.chatKey().isEmpty()) return;
        long seq = signal.optLong("seq");
        long saved = session.chatSeq();
        if (seq <= saved) return;
        session.setChatSeq(seq);
        // The first count is a starting point, not news. And only while searching
        if (saved == 0 || !signal.optBoolean("notify") || !new Settings(this).chatAlerts()) return;
        if (MainActivity.isVisible() || chatWorker.isShutdown()) return;
        chatWorker.execute(() -> {
            try {
                JSONObject answer = new ChatLink(session).call("sync", "{}");
                if (answer.optInt("status") != 200) return;
                JSONArray chats = answer.getJSONObject("body").optJSONArray("chats");
                Settings settings = new Settings(this);
                long since = session.chatNotifiedAt();
                long newest = since;
                for (int i = 0; chats != null && i < chats.length(); i++) {
                    JSONObject chat = chats.getJSONObject(i);
                    long at = chat.optLong("at");
                    JSONObject last = chat.optJSONObject("last");
                    if (chat.optInt("unread") <= 0 || at <= since || last == null || last.optBoolean("me")) continue;
                    newest = Math.max(newest, at);
                    if (settings.chatMuted(chat.optString("id"))) continue;
                    String name = chat.optString("name");
                    if (name.isEmpty()) name = chat.optString("phone").replaceFirst("^972", "0");
                    Notifications.chat(this, chat.optString("id"), name.isEmpty() ? "הודעה חדשה" : name,
                            last.optString("text"), chat.optInt("unread"));
                    newest = Math.max(newest, at);
                }
                session.setChatNotifiedAt(newest);
            } catch (Exception e) {
                Log.w(TAG, "chat notification failed: " + e.getClass().getSimpleName());
            }
        });
    }

    private void abortRequest() {
        HttpURLConnection connection = current;
        if (connection != null) new Thread(connection::disconnect).start();
    }

    @Override
    public void onDestroy() {
        running = false;
        chatWorker.shutdownNow();
        Locator.get(this).use("service", false);
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
