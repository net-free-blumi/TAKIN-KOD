package com.blumi.nahagim;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.util.HashSet;
import java.util.Set;

import org.json.JSONObject;

/** The driver's location. It stays on the phone and is never sent to the server. */
final class Locator {
    private static final long MAX_AGE_MS = 10 * 60 * 1000;
    private static final double ROAD_FACTOR = 1.3;

    private static Locator instance;

    private final Context context;
    private final Settings settings;
    private final LocationManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<String> users = new HashSet<>(); // main thread only
    private volatile Location last;

    // Every method is needed: before Android 11 the interface has no defaults
    private final LocationListener listener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            accept(location);
        }

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}

        @SuppressWarnings("deprecation")
        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}
    };

    static synchronized Locator get(Context context) {
        if (instance == null) instance = new Locator(context.getApplicationContext());
        return instance;
    }

    private Locator(Context context) {
        this.context = context;
        settings = new Settings(context);
        manager = context.getSystemService(LocationManager.class);
    }

    static boolean allowed(Context context) {
        return context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    boolean active() {
        return settings.location() && allowed(context);
    }

    void use(String user, boolean on) {
        main.post(() -> {
            if (on) users.add(user);
            else users.remove(user);
            update();
        });
    }

    void update() {
        main.post(() -> {
            if (manager == null) return;
            manager.removeUpdates(listener);
            if (!active()) {
                last = null;
                return;
            }
            if (users.isEmpty()) return;
            for (String provider : new String[] {LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER}) {
                try {
                    if (!manager.getAllProviders().contains(provider)) continue;
                    accept(manager.getLastKnownLocation(provider));
                    manager.requestLocationUpdates(provider, 30000, 100, listener, Looper.getMainLooper());
                } catch (SecurityException | IllegalArgumentException e) {
                    Log.w("Locator", "provider unavailable: " + provider); // approximate permission has no GPS
                }
            }
        });
    }

    private void accept(Location location) {
        if (location == null || ageMs(location) > MAX_AGE_MS) return;
        Location previous = last;
        boolean better = previous == null
                || ageMs(previous) > 60000
                || !previous.hasAccuracy()
                || location.hasAccuracy() && location.getAccuracy() <= previous.getAccuracy() + 50;
        if (better) last = location;
    }

    private static long ageMs(Location location) {
        return SystemClock.elapsedRealtime() - location.getElapsedRealtimeNanos() / 1000000;
    }

    private Location current() {
        Location location = last;
        if (location == null || !active()) return null;
        // Standing still gives no updates, so ask the system again before giving up
        if (ageMs(location) > MAX_AGE_MS) {
            update();
            return null;
        }
        return location;
    }

    /** The current location, or null when unknown or too old. */
    Location here() {
        return current();
    }

    /** Estimated road distance, or -1 when the location or pickup is unknown. */
    double km(double lat, double lng) {
        Location here = current();
        if (here == null || Double.isNaN(lat) || Double.isNaN(lng)) return -1;
        float[] meters = new float[1];
        Location.distanceBetween(here.getLatitude(), here.getLongitude(), lat, lng, meters);
        return meters[0] / 1000.0 * ROAD_FACTOR;
    }

    /** An unknown distance never hides a ride. */
    boolean withinRange(JSONObject ride) {
        int max = settings.maxKm();
        JSONObject pickup = ride.optJSONObject("pickup");
        if (max <= 0 || pickup == null) return true;
        double km = km(pickup.optDouble("lat"), pickup.optDouble("lng"));
        return km < 0 || km <= max;
    }
}
