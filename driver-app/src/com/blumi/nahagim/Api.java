package com.blumi.nahagim;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/** The only place that talks to the server. The token never reaches the WebView. */
final class Api {
    static final class Response {
        final int status;
        final JSONObject body;

        Response(int status, JSONObject body) {
            this.status = status;
            this.body = body;
        }
    }

    private Api() {}

    static Response call(String method, String path, String json, String token, int readTimeoutMs) throws IOException {
        HttpURLConnection connection = open(method, path, token, readTimeoutMs);
        return exchange(connection, json);
    }

    static HttpURLConnection open(String method, String path, String token, int readTimeoutMs) throws IOException {
        if (!path.startsWith("/api/app/") || path.contains("..")) throw new IOException("path not allowed");
        HttpURLConnection c = (HttpURLConnection) new URL(BuildInfo.SERVER + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(readTimeoutMs);
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        c.setRequestProperty("Accept", "application/json");
        if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    static Response exchange(HttpURLConnection c, String json) throws IOException {
        try {
            if ("POST".equals(c.getRequestMethod())) {
                byte[] data = (json == null ? "{}" : json).getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(data);
                }
            }
            int status = c.getResponseCode();
            InputStream stream = status >= 400 ? c.getErrorStream() : c.getInputStream();
            try {
                return new Response(status, new JSONObject(read(stream)));
            } catch (JSONException e) {
                // A proxy error page is not JSON
                throw new IOException("unexpected response " + status, e);
            }
        } finally {
            c.disconnect();
        }
    }

    private static String read(InputStream stream) throws IOException {
        if (stream == null) return "{}";
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        }
    }
}
