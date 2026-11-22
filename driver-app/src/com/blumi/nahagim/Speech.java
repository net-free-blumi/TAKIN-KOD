package com.blumi.nahagim;

import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayDeque;
import java.util.Locale;

import org.json.JSONObject;

/** Reads rides aloud with the phone's own Hebrew voice. Shared by the screen and the alert service. */
final class Speech {
    private static final int MAX_QUEUE = 3;
    private static final long STALE_MS = 90000;
    private static final long AFTER_CHIME_MS = 1500;

    private static Speech instance;

    private static final class Line {
        final String text;
        final boolean manual;
        final long createdAt = SystemClock.elapsedRealtime();

        Line(String text, boolean manual) {
            this.text = text;
            this.manual = manual;
        }
    }

    private final Context context;
    private final Settings settings;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private final AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    // Lowers music or navigation while speaking, then gives it back
    private final AudioFocusRequest focus =
            new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attributes)
                    .build();

    // Everything below is touched only on the main thread
    private final ArrayDeque<Line> queue = new ArrayDeque<>();
    private TextToSpeech engine;
    private boolean ready;
    private String speakingId;
    private long nextId;

    private volatile String voice = "checking";

    static synchronized Speech get(Context context) {
        if (instance == null) instance = new Speech(context.getApplicationContext());
        return instance;
    }

    private Speech(Context context) {
        this.context = context;
        settings = new Settings(context);
        audio = context.getSystemService(AudioManager.class);
    }

    String voice() {
        return voice;
    }

    /** Starts over, so a voice or engine the driver just installed is picked up. */
    void check() {
        main.post(() -> {
            if (speakingId != null) return;
            if (engine != null) engine.shutdown();
            engine = null;
            createEngine();
        });
    }

    private void createEngine() {
        ready = false;
        // The callback can arrive before the constructor returns
        engine = new TextToSpeech(context, status -> main.post(() -> onInit(status)));
    }

    private void onInit(int status) {
        if (engine == null) return;
        boolean hebrew = status == TextToSpeech.SUCCESS
                && (engine.setLanguage(new Locale("he", "IL")) >= TextToSpeech.LANG_AVAILABLE
                        || engine.setLanguage(new Locale("iw", "IL")) >= TextToSpeech.LANG_AVAILABLE);
        if (hebrew) {
            engine.setAudioAttributes(attributes);
            engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String id) {}

                @Override
                public void onDone(String id) {
                    main.post(() -> finished(id));
                }

                @SuppressWarnings("deprecation")
                @Override
                public void onError(String id) {
                    main.post(() -> finished(id));
                }
            });
        }
        ready = hebrew;
        voice = hebrew ? "ready" : "missing";
        MainActivity.voiceChanged();
        if (hebrew) next();
        else queue.clear();
    }

    void announce(JSONObject ride) {
        if (!settings.speech()) return;
        String text = SpeechText.announcement(
                ride.optString("text"), ride.optString("from"), ride.optString("to"),
                ride.optDouble("price", 0),
                ride.optBoolean("checked") && "short".equals(settings.speechMode()));
        Line line = new Line(text, false);
        main.postDelayed(() -> add(line), AFTER_CHIME_MS); // after the notification sound
    }

    void say(String text) {
        Line line = new Line(SpeechText.clean(text), true);
        main.post(() -> {
            halt();
            add(line);
        });
    }

    void stop() {
        main.post(this::halt);
    }

    private void halt() {
        queue.clear();
        speakingId = null;
        if (engine != null && ready) engine.stop();
        audio.abandonAudioFocusRequest(focus);
    }

    private void add(Line line) {
        if (line.text.isEmpty()) return;
        while (queue.size() >= MAX_QUEUE) queue.poll(); // the newest rides matter most
        queue.add(line);
        if (engine == null || "missing".equals(voice)) {
            if (engine != null) engine.shutdown();
            createEngine();
        } else if (ready) {
            next();
        }
    }

    private void next() {
        if (!ready || speakingId != null) return;
        Line line;
        while ((line = queue.poll()) != null) {
            if (line.manual) break;
            boolean fresh = SystemClock.elapsedRealtime() - line.createdAt < STALE_MS;
            if (fresh && settings.speech() && mayInterrupt()) break;
        }
        if (line == null) {
            audio.abandonAudioFocusRequest(focus);
            return;
        }

        String id = "ride-" + (++nextId);
        speakingId = id;
        String rate = settings.speechRate();
        engine.setSpeechRate("slow".equals(rate) ? 0.8f : "fast".equals(rate) ? 1.3f : 1f);
        audio.requestAudioFocus(focus);
        if (engine.speak(line.text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id) != TextToSpeech.SUCCESS) {
            finished(id);
            return;
        }
        // An engine that never reports back must not block the next rides
        main.postDelayed(() -> finished(id), 60000);
    }

    private void finished(String id) {
        if (!id.equals(speakingId)) return;
        speakingId = null;
        next();
    }

    /** Never talks over a call, silent mode or Do Not Disturb. */
    private boolean mayInterrupt() {
        if (audio.getMode() != AudioManager.MODE_NORMAL) return false;
        if (audio.getRingerMode() == AudioManager.RINGER_MODE_SILENT) return false;
        int filter = context.getSystemService(NotificationManager.class).getCurrentInterruptionFilter();
        return filter == NotificationManager.INTERRUPTION_FILTER_ALL
                || filter == NotificationManager.INTERRUPTION_FILTER_UNKNOWN;
    }
}
