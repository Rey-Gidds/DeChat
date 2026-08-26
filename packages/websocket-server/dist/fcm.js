"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendFCMPushNotification = sendFCMPushNotification;
const app_1 = require("firebase-admin/app");
const messaging_1 = require("firebase-admin/messaging");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const db_1 = require("./db");
const mongodb_1 = require("mongodb");
let initialized = false;
function initFirebaseAdmin() {
    if (initialized)
        return;
    try {
        const jsonPath = path_1.default.resolve(__dirname, "../../frontend/dechat-3cd8a-firebase-adminsdk-fbsvc-438578a1f7.json");
        if (fs_1.default.existsSync(jsonPath)) {
            const serviceAccount = JSON.parse(fs_1.default.readFileSync(jsonPath, "utf8"));
            (0, app_1.initializeApp)({
                credential: (0, app_1.cert)(serviceAccount),
            });
            initialized = true;
            console.log("[FCM] Firebase Admin SDK initialized via service account file.");
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
            console.log("[FCM] Firebase Admin SDK initialized via env vars.");
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
