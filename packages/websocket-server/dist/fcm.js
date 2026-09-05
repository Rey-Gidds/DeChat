"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendFCMPushNotification = sendFCMPushNotification;
const app_1 = require("firebase-admin/app");
const messaging_1 = require("firebase-admin/messaging");
const db_1 = require("./db");
const mongodb_1 = require("mongodb");
let initialized = false;
function initFirebaseAdmin() {
    if (initialized)
        return;
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
            (0, app_1.initializeApp)({
                credential: (0, app_1.cert)(serviceAccount),
            });
            initialized = true;
            console.log("[FCM] Firebase Admin SDK initialized via FIREBASE_SERVICE_ACCOUNT_JSON env var.");
        }
        else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
            (0, app_1.initializeApp)({
                credential: (0, app_1.cert)({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
                }),
            });
            initialized = true;
            console.log("[FCM] Firebase Admin SDK initialized via individual env vars.");
        }
        else {
            console.warn("[FCM] Firebase credentials not found. FCM push sending disabled.");
        }
    }
    catch (err) {
        console.error("[FCM] Failed to initialize Firebase Admin SDK:", err);
    }
}
async function sendFCMPushNotification(userId, payload) {
    initFirebaseAdmin();
    if (!initialized)
        return;
    try {
        const db = await (0, db_1.getDb)();
        const tokensDoc = await db
            .collection("fcm_tokens")
            .find({ userId: new mongodb_1.ObjectId(userId) })
            .toArray();
        if (!tokensDoc || tokensDoc.length === 0) {
            return;
        }
        const tokens = tokensDoc.map((d) => d.token).filter(Boolean);
        if (tokens.length === 0)
            return;
        const message = {
            tokens,
            data: {
                roomId: String(payload.roomId),
                roomName: String(payload.roomName),
                unreadCount: String(payload.unreadCount),
                version: String(payload.version),
            },
            android: {
                ttl: 3600 * 24 * 7 * 1000,
                priority: "high",
            },
            apns: {
                headers: {
                    "apns-priority": "10",
                    "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600 * 24 * 7),
                },
            },
            webpush: {
                headers: {
                    Urgency: "high",
                    TTL: "604800",
                },
                // webpush.notification is required to wake a completely closed browser.
                // Data-only messages are silently dropped by Chrome/Edge/Firefox when the
                // browser process is not running. Adding a notification payload here
                // signals the OS push daemon to start the browser and fire the SW push event.
                notification: {
                    title: payload.roomName,
                    body: `${payload.unreadCount} unread message${payload.unreadCount !== 1 ? "s" : ""}`,
                    icon: "https://dechat-alpha.vercel.app/icons/dechat_logo_192.png",
                    badge: "https://dechat-alpha.vercel.app/icons/dechat_logo_192.png",
                    tag: `room-${payload.roomId}`,
                    renotify: true,
                    data: {
                        roomId: payload.roomId,
                        version: String(payload.version),
                    },
                },
                fcmOptions: {
                    // Must be an absolute URL — relative paths are rejected by FCM
                    link: `https://dechat-alpha.vercel.app/rooms/${payload.roomId}`,
                },
            },
        };
        const response = await (0, messaging_1.getMessaging)().sendEachForMulticast(message);
        console.log(`[FCM] Sent push to user ${userId} (${response.successCount} succeeded, ${response.failureCount} failed)`);
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const errCode = resp.error?.code;
                    if (errCode === "messaging/invalid-registration-token" ||
                        errCode === "messaging/registration-token-not-registered") {
                        failedTokens.push(tokens[idx]);
                    }
                }
            });
            if (failedTokens.length > 0) {
                await db.collection("fcm_tokens").deleteMany({ token: { $in: failedTokens } });
            }
        }
    }
    catch (err) {
        console.error(`[FCM] Error sending FCM push notification to user ${userId}:`, err);
    }
}
