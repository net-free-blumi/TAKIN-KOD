package com.blumi.nahagim;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import java.util.ArrayDeque;
import java.util.Locale;

import org.json.JSONObject;

/**
 * A short beep and then the ride, with the phone's own Hebrew voice.
 * The rule: screen on = every ride is read, also when the app is closed. Screen off = never.
 */
final class Speech {
    private static final String TAG = "Speech";
    private static final int MAX_QUEUE = 40;
    private static final long STALE_MS = 10 * 60 * 1000;
    private static final int BEEP_MS = 180;
    private static final long AFTER_BEEP_MS = 380;
    private static final long CALL_RETRY_MS = 3000;

    private static Speech instance;

    private static final class Line {
        final String text;
        final boolean manual;
        final long createdAt = SystemClock.elapsedRealtime();
        boolean retried;

        Line(String text, boolean manual) {
            this.text = text;
            this.manual = manual;
        }
    }

    private final Context context;
    private final Settings settings;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private final PowerManager power;
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
    private final Runnable retryNext = this::next;
    private TextToSpeech engine;
    private ToneGenerator tone;
    private int toneVolume = -1;
    private boolean ready;
    private Line speaking;
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
        power = context.getSystemService(PowerManager.class);
        // A protected system broadcast, so no exported flag is needed
        context.registerReceiver(new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                main.post(() -> halt());
            }
        }, new IntentFilter(Intent.ACTION_SCREEN_OFF));
    }

    String voice() {
        return voice;
    }

    boolean muted() {
        return audio.getStreamVolume(AudioManager.STREAM_MUSIC) == 0;
    }

    /** When true, the ride notification is silent because the beep and the voice replace its sound. */
    boolean willRead() {
        return settings.speech() && !"missing".equals(voice) && power.isInteractive() && !quietNow() && !muted();
    }

    /** Starts over, so a voice or engine the driver just installed is picked up. */
    void check() {
        main.post(() -> {
            if (speaking != null || (ready && !queue.isEmpty())) return;
            createEngine();
        });
    }

    private void createEngine() {
        ready = false;
        if (engine != null) engine.shutdown();
        // The callback can arrive before the constructor returns
        TextToSpeech[] created = new TextToSpeech[1];
        created[0] = new TextToSpeech(context, status -> main.post(() -> onInit(created[0], status)));
        engine = created[0];
    }

    private void onInit(TextToSpeech created, int status) {
        if (created == null || created != engine) return; // replaced meanwhile
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
        if (!settings.speech() || !power.isInteractive()) return;
        boolean checked = ride.optBoolean("checked");
        String mode = settings.speechMode();
        double price = checked && settings.speakPrice() ? ride.optDouble("price", 0) : 0;
        // Only where from and where to, as the server summarised it
        String spoken = ride.optString("detail".equals(mode) ? "spokenDetail" : "spoken");
        String text = !"full".equals(mode) && !spoken.isEmpty()
                ? SpeechText.summary(spoken, price)
                : SpeechText.announcement(ride.optString("text"),
                        checked ? ride.optString("from") : "", checked ? ride.optString("to") : "",
                        price, !"full".equals(mode));
        Line line = new Line(text, false);
        main.post(() -> add(line));
    }

    void say(String text) {
        Line line = new Line(SpeechText.announcement(text, "", "", 0, false), true);
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
        speaking = null;
        speakingId = null;
        main.removeCallbacks(retryNext);
        if (engine != null && ready) engine.stop();
        audio.abandonAudioFocusRequest(focus);
    }

    private void add(Line line) {
        if (line.text.isEmpty()) return;
        while (queue.size() >= MAX_QUEUE) queue.poll();
        queue.add(line);
        if (engine == null || "missing".equals(voice)) createEngine();
        else if (ready) next();
    }

    private void next() {
        main.removeCallbacks(retryNext);
        if (!ready || speaking != null) return;

        Line line;
        while ((line = queue.peek()) != null) {
            if (line.manual) break;
            boolean stale = SystemClock.elapsedRealtime() - line.createdAt > STALE_MS;
            if (!stale && settings.speech() && power.isInteractive() && !quietNow()) break;
            queue.poll();
        }
        if (line == null) {
            audio.abandonAudioFocusRequest(focus);
            return;
        }
        // Never over a call, but the ride is kept for when it ends
        if (!line.manual && audio.getMode() != AudioManager.MODE_NORMAL) {
            audio.abandonAudioFocusRequest(focus);
            main.postDelayed(retryNext, CALL_RETRY_MS);
            return;
        }

        queue.poll();
        Line current = line;
        speaking = current;
        audio.requestAudioFocus(focus);
        beep();
        main.postDelayed(() -> speak(current), AFTER_BEEP_MS);
    }

    private void beep() {
        try {
            int volume = Math.max(5, 80 * settings.speechVolume() / 100);
            if (tone == null || toneVolume != volume) {
                if (tone != null) tone.release();
                tone = new ToneGenerator(AudioManager.STREAM_MUSIC, volume);
                toneVolume = volume;
            }
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, BEEP_MS);
        } catch (RuntimeException e) {
            // No tone available: the ride is still read
            Log.w(TAG, "beep failed", e);
            tone = null;
        }
    }

    private void speak(Line line) {
        if (speaking != line) return; // stopped during the beep
        if (!line.manual && !power.isInteractive()) {
            halt();
            return;
        }
        String id = "ride-" + (++nextId);
        speakingId = id;
        String rate = settings.speechRate();
        engine.setSpeechRate("slow".equals(rate) ? 0.8f : "fast".equals(rate) ? 1.3f : 1f);
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, settings.speechVolume() / 100f);
        if (engine.speak(line.text, TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) {
            speaking = null;
            speakingId = null;
            // The phone can kill the voice engine in the background
            if (!line.retried) {
                line.retried = true;
                queue.addFirst(line);
                createEngine();
            } else {
                next();
            }
            return;
        }
        // An engine that never reports back must not block the next rides
        main.postDelayed(() -> finished(id), 30000);
    }

    private void finished(String id) {
        if (!id.equals(speakingId)) return;
        speakingId = null;
        speaking = null;
        next();
    }

    /** Only when the driver asked for it: silent mode or Do Not Disturb. */
    private boolean quietNow() {
        if (!settings.respectQuiet()) return false;
        if (audio.getRingerMode() == AudioManager.RINGER_MODE_SILENT) return true;
        int filter = context.getSystemService(NotificationManager.class).getCurrentInterruptionFilter();
        return filter != NotificationManager.INTERRUPTION_FILTER_ALL
                && filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN;
    }
}
