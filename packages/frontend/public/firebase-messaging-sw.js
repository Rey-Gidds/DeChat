// firebase-messaging-sw.js
// Firebase Cloud Messaging Service Worker
// Handles:
//   1. Background FCM push messages (when app is closed / backgrounded)
//   2. Background Sync (one-shot poll on network recovery when app is closed)

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

// ── Firebase init (dynamic query params with fallbacks for cold SW wake-up) ──
const urlParams = new URLSearchParams(self.location.search);
const firebaseConfig = {
  apiKey: urlParams.get("apiKey") || process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: urlParams.get("authDomain") || process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: urlParams.get("projectId") || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: urlParams.get("storageBucket") || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: urlParams.get("messagingSenderId") || process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: urlParams.get("appId") || process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let messaging = null;
try {
  if (firebaseConfig.projectId) {
    firebase.initializeApp(firebaseConfig);
    messaging = firebase.messaging();
  }
} catch (err) {
  console.warn("[SW] Firebase init warning:", err);
}

// ── IDB helper (same DB as the app) ──────────────────────────────────────────
const DB_NAME = "dechat-crypto-store";
const DB_VERSION = 8;
const UNREAD_STORE = "unread-counts";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getStoredEntry(db, roomId) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(UNREAD_STORE, "readonly");
      const req = tx.objectStore(UNREAD_STORE).get(roomId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function putEntry(db, entry) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(UNREAD_STORE, "readwrite");
      const req = tx.objectStore(UNREAD_STORE).put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function getAllEntries(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(UNREAD_STORE, "readonly");
      const req = tx.objectStore(UNREAD_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

// ── Show a notification with version guard ────────────────────────────────────
async function showVersionedNotification(roomId, roomName, unreadCount, version) {
  try {
    const db = await openDB();
    const stored = await getStoredEntry(db, roomId);
    const storedVersion = stored ? (stored.version ?? -1) : -1;

    if (version <= storedVersion) {
      console.log(`[SW] Version ${version} <= stored ${storedVersion} for room ${roomId}. Skipping.`);
      return;
    }

    const title = roomName || "DeChat";
    const body = `${unreadCount} unread message${unreadCount > 1 ? "s" : ""}`;

    await self.registration.showNotification(title, {
      body,
      icon: "/icons/dechat_logo_192.png",
      badge: "/icons/dechat_logo_192.png",
      tag: `room-${roomId}`,     // Collapses notifications per room
      renotify: true,            // Re-alerts even if same tag exists
      data: {
        url: `/rooms/${roomId}`,
        roomId,
        version,
        unreadCount,
      },
    });

    // Update IDB with the newly displayed version
    await putEntry(db, {
      roomId,
      count: Math.min(unreadCount, 101),
      version,
      latestMessageTimeStamp: Date.now(),
    });
  } catch (err) {
    console.error("[SW] showVersionedNotification error:", err);
  }
}

// ── 1. FCM Background Message Handler ────────────────────────────────────────
// Fires when app is closed OR in background (tab not focused) and an FCM push arrives
if (messaging) {
  messaging.onBackgroundMessage((payload) => {
    console.log("[SW] Background FCM message:", payload);
    const data = payload.data || {};
    const roomId = data.roomId;
    const roomName = data.roomName || "DeChat Room";
    const unreadCount = parseInt(data.unreadCount || "1", 10);
    const version = parseInt(data.version || "1", 10);

    if (roomId) {
      return showVersionedNotification(roomId, roomName, unreadCount, version);
    }
  });
}

// Raw push event fallback (handles data-only messages that bypass onBackgroundMessage)
self.addEventListener("push", (event) => {
  if (!event.data) return;
  try {
    const rawData = event.data.json();
    console.log("[SW] Raw push payload:", rawData);
    const d = rawData.data || rawData.notification || rawData;
    const roomId = d.roomId;
    const roomName = d.roomName || d.title || "DeChat Room";
    const unreadCount = parseInt(d.unreadCount || "1", 10);
    const version = parseInt(d.version || "1", 10);

    if (roomId) {
      event.waitUntil(showVersionedNotification(roomId, roomName, unreadCount, version));
    }
  } catch (e) {
    console.warn("[SW] Push event parse warning:", e);
  }
});

// ── 2. Background Sync — One-shot poll on network recovery ───────────────────
// Registered by the app as: registration.sync.register("dechat-unread-sync")
// Fires when network is restored, EVEN if the browser tab / app is not open.
self.addEventListener("sync", (event) => {
  if (event.tag !== "dechat-unread-sync") return;
  console.log("[SW] Background sync fired: dechat-unread-sync");
  event.waitUntil(syncUnreadAndNotify());
});

async function syncUnreadAndNotify() {
  try {
    // Fetch unread counts from server (session cookie included automatically)
    const res = await fetch("/api/unread-counts", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn("[SW] syncUnreadAndNotify: /api/unread-counts returned", res.status);
      return;
    }

    const data = await res.json();
    const counts = data.counts || [];
    if (!counts.length) return;

    const db = await openDB();
    const storedEntries = await getAllEntries(db);
    const storedMap = new Map(storedEntries.map((e) => [e.roomId, e]));

    for (const item of counts) {
      const { roomId, unreadCount, version, roomName } = item;
      if (!roomId || unreadCount <= 0) continue;

      const stored = storedMap.get(roomId);
      const storedVersion = stored ? (stored.version ?? -1) : -1;

      if (version > storedVersion) {
        // Show notification for missed messages
        await showVersionedNotification(
          roomId,
          roomName || "DeChat Room",
          unreadCount,
          version
        );
      }
    }
  } catch (err) {
    console.error("[SW] syncUnreadAndNotify error:", err);
    throw err;
  }
}

// ── 3. Notification click handler ─────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  // FCM webpush.notification.data carries roomId; fall back to an explicit url field
  const roomId = data.roomId;
  const targetUrl = data.url
    || (roomId ? `https://dechat-alpha.vercel.app/rooms/${roomId}` : "https://dechat-alpha.vercel.app/");

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an already-open tab pointing to this room
        for (const client of clientList) {
          if (client.url.includes(roomId || targetUrl) && "focus" in client) {
            return client.focus();
          }
        }
        // Focus any open DeChat tab and navigate it to the room
        for (const client of clientList) {
          if ("focus" in client) {
            return client.focus().then(() => client.navigate(targetUrl));
          }
        }
        // No open tab — open a new window
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
