package com.blumi.nahagim;

import java.util.regex.Pattern;

/** Turns group shorthand into words a Hebrew voice can read. Plain Java, so it can be tested on a PC. */
final class SpeechText {
    private static final int MAX_LENGTH = 300;
    private static final String START = "(?<![א-ת0-9])";
    private static final String END = "(?![א-ת0-9])";

    private static final Pattern LINK = Pattern.compile("(https?://|www\\.|wa\\.me/)\\S+");
    // Longest form first. Reading a phone number aloud is noise
    private static final Pattern PHONE =
            Pattern.compile("(?<![0-9])(\\+?972[ -]?|0)[2-9]([ -]?[0-9]){7,8}(?![0-9])");
    private static final Pattern SHEKELS = Pattern.compile("([0-9]+)\\s*(ש[\"'״”]?ח|₪|ש)" + END);
    private static final Pattern SHEKEL_FIRST = Pattern.compile("₪\\s*([0-9]+)");

    private static final String[][] WORDS = {
        {START + "([למבו]?)ב[\"״']?ב" + END, "$1בני ברק"},
        {START + "([למו]?)ת[\"״']?א" + END + "(?!\\s+מטען)", "$1תל אביב"},
        {START + "([למו]?)פ[\"״']ת" + END, "$1פתח תקווה"},
        {"(?<!בת[ -])" + START + "(ל?)י[\"״']?ם" + END + "(?!\\s+המלח)", "$1ירושלים"},
        {"(?<!בית )" + START + "([למבו]?)שמש" + END, "$1בית שמש"},
        {START + "([למבו]?)מו[\"״']?ע" + END, "$1מודיעין עילית"},
        {START + "([למבו]?)נתב[\"״']?ג" + END, "$1נמל התעופה"},
        {START + "([0-9]+)\\s*דק[׳']?" + END, "$1 דקות"},
    };

    private SpeechText() {}

    static String clean(String raw) {
        if (raw == null) return "";
        String text = LINK.matcher(raw).replaceAll(" ");
        text = PHONE.matcher(text).replaceAll(" ");
        text = SHEKEL_FIRST.matcher(text).replaceAll("$1 שקלים");
        text = SHEKELS.matcher(text).replaceAll("$1 שקלים");
        for (String[] word : WORDS) text = text.replaceAll(word[0], word[1]);
        text = text.replaceAll("[^א-תA-Za-z0-9\\s.,:?!'\"״׳/-]", " ") // emoji, stars, arrows
                .replaceAll("\\s*\\n\\s*", ", ")
                .replaceAll("[ \\t\\r]+", " ")
                .replaceAll(" +([.,])", "$1")
                .replaceAll("^[\\s,.]+|[\\s,]+$", "");
        return text.length() > MAX_LENGTH ? text.substring(0, MAX_LENGTH) : text;
    }

    /** The short form is used only when both ends are known, so a ride is never read with half a route. */
    static String announcement(String text, String from, String to, double price, boolean brief) {
        if (brief && !from.isEmpty() && !to.isEmpty() && !from.equals(to)) {
            String line = "נסיעה חדשה. " + clean(from) + ", אל " + clean(to);
            return price > 0 ? line + ". " + Math.round(price) + " שקלים" : line;
        }
        return "נסיעה חדשה. " + clean(text);
    }
}
