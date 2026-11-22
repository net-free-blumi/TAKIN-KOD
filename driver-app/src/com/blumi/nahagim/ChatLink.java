package com.blumi.nahagim;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyPair;

import org.json.JSONException;
import org.json.JSONObject;

/** Chat requests over the encrypted channel. The page never sees the key. */
final class ChatLink {
    private final Session session;

    ChatLink(Session session) {
        this.session = session;
    }

    /** Returns the message the driver has to send from their own WhatsApp. */
    JSONObject start() throws IOException, JSONException, GeneralSecurityException {
        String token = session.token();
        KeyPair pair = SecureChannel.newPair();
        String body = new JSONObject().put("key", SecureChannel.publicKey(pair)).toString();
        Api.Response response = Api.call("POST", "/api/app/chat/start", body, token, 20000);
        if (response.status != 200) return result(response.status, response.body);

        byte[] key = SecureChannel.agree(pair.getPrivate(), response.body.getString("server"));
        session.setChatKey(token, SecureChannel.encode(key));
        return result(200, new JSONObject()
                .put("botPhone", response.body.optString("botPhone"))
                .put("text", "אישור צאטים " + SecureChannel.confirmCode(key)));
    }

    JSONObject call(String operation, String argsJson) throws IOException, JSONException, GeneralSecurityException {
        String saved = session.chatKey();
        if (saved.isEmpty()) return result(410, new JSONObject().put("error", "צריך לחבר את הצ'אטים"));

        byte[] key = SecureChannel.decode(saved);
        String id = SecureChannel.newRequestId();
        String request = new JSONObject()
                .put("op", operation)
                .put("args", new JSONObject(argsJson))
                .put("rid", id)
                .put("ts", System.currentTimeMillis())
                .toString();
        String body = new JSONObject().put("box", SecureChannel.seal(key, request, "req")).toString();
        Api.Response response = Api.call("POST", "/api/app/chat", body, session.token(), 30000);

        if (response.status != 200) {
            if (response.status == 410 && saved.equals(session.chatKey())) session.setChatKey(session.token(), "");
            return result(response.status, response.body);
        }
        // Bound to this request, so an old or forged answer fails here
        JSONObject answer = new JSONObject(
                SecureChannel.open(key, response.body.getString("box"), SecureChannel.responseContext(id)));
        if ("off".equals(operation) && answer.optInt("status") == 200) session.setChatKey(session.token(), "");
        return answer;
    }

    private static JSONObject result(int status, JSONObject body) throws JSONException {
        return new JSONObject().put("status", status).put("body", body);
    }
}
