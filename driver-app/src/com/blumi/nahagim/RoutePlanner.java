package com.blumi.nahagim;

import android.location.Location;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Real driving distance and time, only when the driver taps the button.
 * Uses OpenStreetMap's free services straight from the phone. The bot server never sees the location.
 */
final class RoutePlanner {
    private static final String AGENT = "nahagim-driver-app/1.3";
    private static final double MAX_SHIFT_KM = 15;

    private RoutePlanner() {}

    static JSONObject plan(Locator locator, double lat, double lng, String query) throws JSONException {
        Location here = locator.here();
        if (here == null) return error(409, "המיקום שלך עוד לא ידוע. נסה שוב בעוד רגע.");
        if (Double.isNaN(lat) || Double.isNaN(lng)) return error(400, "אין נקודת איסוף בנסיעה הזו");

        double toLat = lat;
        double toLng = lng;
        boolean exact = false;
        if (query != null && !query.trim().isEmpty() && query.length() <= 120) {
            try {
                JSONArray found = new JSONArray(get("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1"
                        + "&countrycodes=il&accept-language=he&q=" + URLEncoder.encode(query.trim(), "UTF-8")));
                if (found.length() > 0) {
                    JSONObject place = found.getJSONObject(0);
                    double a = Double.parseDouble(place.getString("lat"));
                    double b = Double.parseDouble(place.getString("lon"));
                    // A name found in another city is worse than the neighbourhood centre
                    if (straightKm(a, b, lat, lng) <= MAX_SHIFT_KM) {
                        toLat = a;
                        toLng = b;
                        exact = true;
                    }
                }
            } catch (IOException | JSONException | NumberFormatException e) {
                // the neighbourhood centre is still a good answer
            }
        }

        try {
            JSONObject answer = new JSONObject(get(String.format(Locale.US,
                    "https://router.project-osrm.org/route/v1/driving/%.6f,%.6f;%.6f,%.6f?overview=false",
                    here.getLongitude(), here.getLatitude(), toLng, toLat)));
            JSONObject route = answer.getJSONArray("routes").getJSONObject(0);
            double km = route.getDouble("distance") / 1000.0;
            // The free router assumes empty roads
            int minutes = (int) Math.max(1, Math.round(route.getDouble("duration") * 1.2 / 60.0));
            return new JSONObject().put("status", 200).put("body", new JSONObject()
                    .put("km", Math.round(km * 10) / 10.0)
                    .put("minutes", minutes)
                    .put("exact", exact));
        } catch (IOException | JSONException e) {
            return error(502, "שירות המפות לא ענה. נסה שוב, או פתח ב-Waze.");
        }
    }

    private static double straightKm(double lat1, double lng1, double lat2, double lng2) {
        float[] meters = new float[1];
        Location.distanceBetween(lat1, lng1, lat2, lng2, meters);
        return meters[0] / 1000.0;
    }

    private static JSONObject error(int status, String message) throws JSONException {
        return new JSONObject().put("status", status).put("body", new JSONObject().put("error", message));
    }

    private static String get(String address) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", AGENT);
            c.setRequestProperty("Accept", "application/json");
            if (c.getResponseCode() != 200) throw new IOException("status " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int total = 0;
                for (int n; (n = in.read(buffer)) != -1; ) {
                    total += n;
                    if (total > 512 * 1024) throw new IOException("too large");
                    out.write(buffer, 0, n);
                }
                return out.toString("UTF-8");
            }
        } finally {
            c.disconnect();
        }
    }
}
