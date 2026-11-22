package com.blumi.nahagim;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** The chat channel's crypto, matching driver-app-secure.js. Plain Java, so it can be tested on a PC. */
final class SecureChannel {
    private static final SecureRandom RANDOM = new SecureRandom();

    private SecureChannel() {}

    static KeyPair newPair() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
        return generator.generateKeyPair();
    }

    static String publicKey(KeyPair pair) {
        return encode(pair.getPublic().getEncoded());
    }

    static byte[] agree(PrivateKey mine, String serverPublic) throws GeneralSecurityException {
        PublicKey server = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(decode(serverPublic)));
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(mine);
        agreement.doPhase(server, true);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update("nahagim-chat-v1".getBytes(StandardCharsets.UTF_8));
        return digest.digest(agreement.generateSecret());
    }

    /** Sent from the driver's own WhatsApp. A key swapped on the way gives a code the server rejects. */
    static String confirmCode(byte[] key) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return hex(mac.doFinal("confirm".getBytes(StandardCharsets.UTF_8))).substring(0, 16).toUpperCase(Locale.ROOT);
    }

    static String newRequestId() {
        byte[] bytes = new byte[18];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    static String responseContext(String requestId) throws GeneralSecurityException {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(requestId.getBytes(StandardCharsets.UTF_8));
        return "res|" + hex(hash);
    }

    static String seal(byte[] key, String text, String context) throws GeneralSecurityException {
        byte[] iv = new byte[12];
        RANDOM.nextBytes(iv);
        Cipher cipher = cipher(Cipher.ENCRYPT_MODE, key, iv, context);
        byte[] sealed = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        byte[] box = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, box, 0, iv.length);
        System.arraycopy(sealed, 0, box, iv.length, sealed.length);
        return encode(box);
    }

    static String open(byte[] key, String box, String context) throws GeneralSecurityException {
        byte[] raw = decode(box);
        if (raw.length < 29) throw new GeneralSecurityException("short box");
        byte[] iv = new byte[12];
        System.arraycopy(raw, 0, iv, 0, iv.length);
        Cipher cipher = cipher(Cipher.DECRYPT_MODE, key, iv, context);
        return new String(cipher.doFinal(raw, iv.length, raw.length - iv.length), StandardCharsets.UTF_8);
    }

    private static Cipher cipher(int mode, byte[] key, byte[] iv, String context) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
        return cipher;
    }

    static String encode(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    static byte[] decode(String text) throws GeneralSecurityException {
        try {
            return Base64.getDecoder().decode(text);
        } catch (IllegalArgumentException e) {
            throw new GeneralSecurityException("bad base64", e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        }
        return out.toString();
    }
}
