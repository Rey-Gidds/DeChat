import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging, MulticastMessage, SendResponse } from "firebase-admin/messaging";
import path from "path";
import fs from "fs";
import { getDb } from "./db";
import { ObjectId } from "mongodb";

let initialized = false;

function initFirebaseAdmin() {
  if (initialized) return;

  try {
    const jsonPath = path.resolve(
      __dirname,
      "../../frontend/dechat-3cd8a-firebase-adminsdk-fbsvc-438578a1f7.json"
    );

    if (fs.existsSync(jsonPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      initializeApp({
        credential: cert(serviceAccount),
      });
      initialized = true;
      console.log("[FCM] Firebase Admin SDK initialized via service account file.");
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
      initialized = true;
      console.log("[FCM] Firebase Admin SDK initialized via env vars.");
    } else {
      console.warn("[FCM] Firebase credentials not found. FCM push sending disabled.");
    }
  } catch (err) {
    console.error("[FCM] Failed to initialize Firebase Admin SDK:", err);
  }
}

export async function sendFCMPushNotification(
  userId: string,
  payload: { roomId: string; roomName: string; unreadCount: number; version: number }
) {
  initFirebaseAdmin();
  if (!initialized) return;

  try {
    const db = await getDb();
    const tokensDoc = await db
      .collection("fcm_tokens")
      .find({ userId: new ObjectId(userId) })
      .toArray();

    if (!tokensDoc || tokensDoc.length === 0) {
      return;
    }

    const tokens = tokensDoc.map((d: any) => d.token).filter(Boolean);
    if (tokens.length === 0) return;

    const message: MulticastMessage = {
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
        fcmOptions: {
          link: `/rooms/${payload.roomId}`,
        },
      },
    };

    const response = await getMessaging().sendEachForMulticast(message);
    console.log(`[FCM] Sent push to user ${userId} (${response.successCount} succeeded, ${response.failureCount} failed)`);

    if (response.failureCount > 0) {
      const failedTokens: string[] = [];
      response.responses.forEach((resp: SendResponse, idx: number) => {
        if (!resp.success) {
          const errCode = resp.error?.code;
          if (
            errCode === "messaging/invalid-registration-token" ||
            errCode === "messaging/registration-token-not-registered"
          ) {
            failedTokens.push(tokens[idx]);
          }
        }
      });
      if (failedTokens.length > 0) {
        await db.collection("fcm_tokens").deleteMany({ token: { $in: failedTokens } });
      }
    }
  } catch (err) {
    console.error(`[FCM] Error sending FCM push notification to user ${userId}:`, err);
  }
}
