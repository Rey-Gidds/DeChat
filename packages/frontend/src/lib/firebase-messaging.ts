import { initializeApp, getApps, getApp } from "firebase/app";
import { getMessaging, getToken, onMessage, Messaging } from "firebase/messaging";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function getFirebaseApp() {
  if (!getApps().length) {
    return initializeApp(firebaseConfig);
  }
  return getApp();
}

export function getMessagingInstance(): Messaging | null {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const app = getFirebaseApp();
    return getMessaging(app);
  } catch (err) {
    console.warn("[FCM] Messaging initialization failed:", err);
    return null;
  }
}

export async function requestFCMToken(): Promise<string | null> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return null;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.log("[FCM] Notification permission denied.");
      return null;
    }

    const messaging = getMessagingInstance();
    if (!messaging) return null;

    const swRegistration = await navigator.serviceWorker.ready;
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY;

    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swRegistration,
    });

    return token || null;
  } catch (err) {
    console.error("[FCM] Error obtaining FCM token:", err);
    return null;
  }
}

export function setupForegroundMessageListener(onMsg: (payload: any) => void): (() => void) | null {
  const messaging = getMessagingInstance();
  if (!messaging) return null;
  return onMessage(messaging, (payload) => {
    console.log("[FCM] Foreground message received:", payload);
    onMsg(payload);
  });
}
