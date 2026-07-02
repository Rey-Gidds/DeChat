# Key Recovery Mechanism — Architecture & Implementation Plan

> **Status**: Draft for review  
> **Project**: DeChat — Privacy-First E2EE Messaging  
> **Date**: 2026-06-03  
> **Context**: Users lose their RSA private key when clearing browser data or switching devices. This doc covers a seamless recovery flow that lets users restore their identity from an encrypted recovery kit file.

---

## Table of Contents

- [1. Current State Analysis](#1-current-state-analysis)
- [2. Architecture Decisions](#2-architecture-decisions)
- [3. Component Tree](#3-component-tree)
- [4. KeyHealthProvider — Global Context](#4-keyhealthprovider--global-context)
- [5. RecoveryDialog — Shared Modal](#5-recovorydialog--shared-modal)
- [6. KeyStatusBanner — Persistent AppShell Banner](#6-keystatusbanner--persistent-appshell-banner)
- [7. RecoveryDownload — Shared Download Component](#7-recoverydownload--shared-download-component)
- [8. User Flow Walkthroughs](#8-user-flow-walkthroughs)
- [9. Integration Points](#9-integration-points)
- [10. File Change Summary](#10-file-change-summary)
- [11. Edge Cases & Error Handling](#11-edge-cases--error-handling)
- [12. UI / Theme Considerations](#12-ui--theme-considerations)

---

## 1. Current State Analysis

### What exists today

| Area | Implementation | Gaps |
|------|---------------|------|
| **Private key generation** | RSA-OAEP 2048-bit via Web Crypto API, stored in IndexedDB (`dechat-crypto-store`) | Works fine |
| **Public key upload** | Sent as custom field during Better Auth `signUp.email()`, stored on `user` doc | Works fine |
| **Recovery kit download** | PBKDF2-derived AES-256-GCM encrypts private key JWK → JSON file download (`downloadRecoveryKit`) | Only shown once on sign-up, no way to re-download |
| **Recovery on sign-in** | Inline `showRestorePrompt` UI in `sign-in/page.tsx` — file upload + passphrase → decrypt → save to IndexedDB | Tightly coupled to sign-in page, can't be triggered from elsewhere |
| **Key missing detection** | Only checked on sign-in after successful auth | No global detection; room page throws a raw error string |
| **"Skip (Read-Only)"** | Skips recovery, user navigates to app without keys | Only detected in `room-discovery.tsx` via missing `publicKey` field — not private key presence |
| **IndexedDB stores** | `private-keys` (RSA private), `room-keys` (AES room keys) | No quick existence check helper — `getPrivateKey` loads the full `CryptoKey` object |

### Crypto format (must remain identical for backward compatibility)

```typescript
interface RecoveryKitFile {
  userId: string;                           // MongoDB _id string
  salt: string;                             // base64 of 16 random bytes
  iv: string;                               // base64 of 12 random bytes
  ciphertext: string;                       // base64 of AES-256-GCM output
}
// PBKDF2: SHA-256, 100,000 iterations, random 16-byte salt
// Encryption: AES-256-GCM, random 12-byte IV
// Plaintext: JWK-serialized RSA private key with key_ops=["decrypt","unwrapKey"]
```

---

## 2. Architecture Decisions

### Decision 1: Global context for key health

A single `KeyHealthProvider` React context wraps the entire authenticated app. On mount and on session change, it checks IndexedDB for the user's private key. All components that need to check or restore the key pull from this context.

### Decision 2: Shared recovery dialog

A single `RecoveryDialog` modal is mounted at the `AppShell` level, controlled by the context. Any page can open it via `openRecovery()` from the context. This eliminates duplicate recovery UI code and ensures consistent UX.

### Decision 3: Fixed banner at top of AppShell

When `hasPrivateKey === false` and the user is authenticated, a fixed dismissible banner appears below the header: **"Encryption keys missing — Restore your identity"** with a CTA to open the RecoveryDialog. Dismissing it sets a session-storage flag so it doesn't reappear on every navigation within the same session, but it re-shows on page reload.

### Decision 4: Backward-compatible recovery kit format

No changes to the PBKDF2/AES-256-GCM parameters or the JSON schema. Old recovery kits continue to work unchanged.

### Decision 5: Recovery download as a standalone component

The download flow (passphrase input → encrypt → trigger download) is extracted into `<RecoveryDownload>` and used in two places:
- **Sign-up page** (step 3) — existing flow
- **Profile page** (new "Download Recovery Kit" section) — allows re-downloading with a new passphrase

---

## 3. Component Tree

```
<RootLayout>
  <AppShell>
    <KeyHealthProvider>              ← wraps entire app
      <KeyStatusBanner />            ← fixed banner when keys missing
      <RecoveryDialog />             ← global modal, controlled by context
      {children}
    </KeyHealthProvider>
  </AppShell>
</RootLayout>

Page-level usage:
  sign-in/page.tsx       → imports RecoveryDownload (for restore flow inline)
  sign-up/page.tsx       → imports RecoveryDownload (step 3)
  profile/page.tsx       → imports RecoveryDownload (re-download section)
                         → uses useKeyHealth().openRecovery() for restore CTA
  rooms/[roomId]/page.tsx → catches "Private key not found" error
                           → uses useKeyHealth().openRecovery()
```

---

## 4. KeyHealthProvider — Global Context

### Location

`packages/frontend/src/components/key-recovery/provider.tsx`

### Interface

```typescript
interface KeyHealthContextValue {
  /** Whether a private key exists in IndexedDB for the current user */
  hasPrivateKey: boolean;
  /** True while the initial IndexedDB check is in progress */
  keyCheckLoading: boolean;
  /** Open the global RecoveryDialog */
  openRecovery: () => void;
  /** Close the RecoveryDialog */
  closeRecovery: () => void;
  /** Whether the RecoveryDialog is currently open */
  isRecoveryOpen: boolean;
  /** Refetch key presence from IndexedDB (called after successful restore) */
  refreshKeyStatus: () => Promise<void>;
}
```

### Internal logic

```typescript
function KeyHealthProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [hasPrivateKey, setHasPrivateKey] = useState(false);
  const [keyCheckLoading, setKeyCheckLoading] = useState(true);
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);

  // Check IndexedDB on session change
  useEffect(() => {
    if (!session?.user?.id) {
      setHasPrivateKey(false);
      setKeyCheckLoading(false);
      return;
    }
    setKeyCheckLoading(true);
    hasPrivateKeyInDB(session.user.id).then((exists) => {
      setHasPrivateKey(exists);
      setKeyCheckLoading(false);
    });
  }, [session?.user?.id]);

  // ... open/close/refresh helpers

  return (
    <KeyHealthContext.Provider value={...}>
      {children}
    </KeyHealthContext.Provider>
  );
}
```

### New helper in `crypto.ts`

```typescript
/**
 * Quick existence check — returns true if a private key exists in IndexedDB
 * for the given userId. Does NOT load the full CryptoKey object.
 */
export async function hasPrivateKeyInDB(userId: string): Promise<boolean> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.count(userId);
    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => reject(request.error);
  });
}
```

---

## 5. RecoveryDialog — Shared Modal

### Location

`packages/frontend/src/components/key-recovery/recovery-dialog.tsx`

### Props

```typescript
interface RecoveryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Optional — if called from room page, show a contextual message */
  context?: "room" | "sign-in" | "banner" | "profile";
}
```

### UI Structure

```
┌─────────────────────────────────────┐
│  ┌───────────────────────────────┐  │
│  │          Modal Overlay        │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │   Identity Restore      │  │  │
│  │  │   ───────────────────── │  │  │
│  │  │                         │  │  │
│  │  │ [contextual message]    │  │  │
│  │  │                         │  │  │
│  │  │  ┌──────────────────┐   │  │  │
│  │  │  │Upload recovery   │   │  │  │
│  │  │  │kit JSON file     │   │  │  │
│  │  │  │   (drag & drop)  │   │  │  │
│  │  │  └──────────────────┘   │  │  │
│  │  │                         │  │  │
│  │  │  [Passphrase input]     │  │  │
│  │  │                         │  │  │
│  │  │  [Cancel]   [Restore]   │  │  │
│  │  └─────────────────────────┘  │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

### Contextual messages

| `context` | Header text | Body text |
|-----------|-------------|-----------|
| `"sign-in"` | "Welcome Back" | "Your local encryption key was not found. Restore your identity to access your rooms." |
| `"room"` | "Room Access Required" | "You need your private key to decrypt messages in this room." |
| `"banner"` | "Keys Missing" | "Your identity keys are missing. Restore now to send and decrypt messages." |
| `"profile"` | "Identity Restore" | "Restore your private key from a recovery kit backup." |

### State machine within dialog

```
IDLE → FILE_SELECTED → RESTORING → SUCCESS → close + refreshKeyStatus
                                    → ERROR → IDLE (with error message)
```

### Decryption logic

Copied from existing `handleRestoreKey` in sign-in page:
1. Parse `recoveryFile.salt`, `recoveryFile.iv`, `recoveryFile.ciphertext` from base64
2. Derive AES-256-GCM key via PBKDF2 (SHA-256, 100k iterations)
3. Decrypt with AES-256-GCM
4. Parse JWK, ensure `key_ops` includes `["decrypt", "unwrapKey"]`
5. Import as CryptoKey
6. `savePrivateKey(recoveryFile.userId, privateKey)`
7. Call `refreshKeyStatus()` from context
8. Show success animation for 1.5s → close dialog

### Visual design (adhering to app theme)

- **Overlay**: `bg-black/80 backdrop-blur-sm`
- **Container**: `glass max-w-md w-full rounded-3xl` (matches sign-in/sign-up card)
- **File upload area**: Dashed border, `border-gray-800 hover:border-[#66fcf1]` with `Upload` icon
- **Passphrase input**: `bg-black/40 border-gray-800 rounded-xl` with `Lock` icon
- **Primary button**: `bg-[#66fcf1] text-[#0b0c10] font-bold rounded-xl hover:bg-[#45a29e]`
- **Secondary button**: `bg-transparent border border-gray-800 text-gray-400 rounded-xl`
- **Loading state**: Spinning border animation (same as sign-up step 2)
- **Success state**: `CheckCircle2` icon with `glow-text` class, pulsing animation
- **Error state**: `bg-red-500/10 border-red-500/20 text-red-400` alert bar

---

## 6. KeyStatusBanner — Persistent AppShell Banner

### Location

`packages/frontend/src/components/key-recovery/key-status-banner.tsx`

### Behavior

- Rendered inside `AppShell`, below the header
- Only visible when:
  - User is authenticated (`session?.user` exists)
  - `keyCheckLoading === false`
  - `hasPrivateKey === false`
  - **AND** `sessionStorage` flag `dechat_key_banner_dismissed` is not set
- Dismissing sets `sessionStorage.setItem("dechat_key_banner_dismissed", "true")` — persists for the browser tab session
- On page reload, `sessionStorage` clears and the banner shows again (hard to miss)

### UI

```
┌──────────────────────────────────────────────────────────────┐
│ ⚠  Encryption keys missing — your messages can't be         │
│   decrypted.  [Restore your identity →]              [✕]   │
└──────────────────────────────────────────────────────────────┘
```

- **Background**: `bg-amber-500/10 border border-amber-500/20`
- **Text**: `text-amber-200`
- **CTA button**: Opens `RecoveryDialog` via `openRecovery()` from context
- **Dismiss button**: `X` icon, sets sessionStorage flag
- **Mobile**: Full width, text wraps naturally, CTA stays inline

---

## 7. RecoveryDownload — Shared Download Component

### Location

`packages/frontend/src/components/key-recovery/recovery-download.tsx`

### Props

```typescript
interface RecoveryDownloadProps {
  userId: string;
  privateKey: CryptoKey;
  /** Called after successful download */
  onComplete?: () => void;
}
```

### UI (same as current sign-up step 3)

```
┌─────────────────────────────────────┐
│  Security Kit Backup                │
│                                     │
│  [Info box about recovery kit]      │
│                                     │
│  [Passphrase input]                 │
│  [Confirm passphrase input]         │
│                                     │
│  [Download Recovery Kit]            │
└─────────────────────────────────────┘
```

### Logic

1. User enters passphrase + confirm passphrase
2. Validates: `min 8 chars`, `passphrase === confirmPassphrase`
3. Calls existing `downloadRecoveryKit(userId, privateKey, passphrase)` from `crypto.ts`
4. Triggers browser download of `dechat-recovery-kit-${userId}.json`
5. Calls `onComplete()` if provided

### Usage points

**Sign-up page** (`sign-up/page.tsx`):

```tsx
// Replace inline step 3 with:
<RecoveryDownload
  userId={tempUserId}
  privateKey={tempPrivateKey}
  onComplete={() => setStep(4)}
/>
```

**Profile page** (`profile/page.tsx`):

```tsx
// In the profile sidebar, after the account info section:
<section>
  <h3>Recovery Kit</h3>
  <p>Download an encrypted backup of your private key.</p>
  {showDownload ? (
    <RecoveryDownload
      userId={profile.id}
      privateKey={privateKey} // loaded from IndexedDB on mount
      onComplete={() => setShowDownload(false)}
    />
  ) : (
    <button onClick={loadPrivateKeyAndShowDownload}>
      Download New Recovery Kit
    </button>
  )}
</section>
```

---

## 8. User Flow Walkthroughs

### Flow A: New user signs up → downloads recovery kit

```
1. Fill registration form                    (step 1)
2. Generate RSA keypair, register account    (step 2)
3. Show <RecoveryDownload>                   (step 3)
   ├── Enter passphrase + confirm
   └── Click "Download Recovery Kit"
       → browser saves .json file
4. "Setup Complete" screen                   (step 4)
   → Link to sign-in
```

### Flow B: Returning user signs in — key present

```
1. Enter email + password
2. Login succeeds
3. KeyHealthProvider checks IndexedDB → hasPrivateKey === true
4. Redirect to "/"
5. No banner, no dialog — seamless
```

### Flow C: Returning user signs in — key missing (same browser, cleared data)

```
1. Enter email + password
2. Login succeeds
3. KeyHealthProvider checks IndexedDB → hasPrivateKey === false
4. Sign-in page recognizes key missing
   → Inline restore prompt (same as today, but using <RecoveryDownload>)
5. User uploads recovery kit + enters passphrase → keys restored
6. Redirect to "/"
```

### Flow D: User navigates app — key missing (previous "Skip" or device switch)

```
1. User signed in, navigated away from sign-in page
2. KeyHealthProvider runs on mount → hasPrivateKey === false
3. KeyStatusBanner shows below header: "Keys missing — Restore your identity"
4. User clicks "Restore your identity"
5. RecoveryDialog opens
6. User uploads recovery kit + enters passphrase → restore succeeds
7. Banner disappears (refreshKeyStatus() updates context)
8. Dialog shows success → auto-closes
```

### Flow E: User enters a room — key missing

```
1. User navigates to /rooms/:roomId
2. Room page loads membership, gets encryptedRoomKey
3. Calls unlockRoomKeyFromMembership(roomId, userId, encryptedRoomKey)
4. getPrivateKey(userId) returns null (key missing)
5. Instead of throwing "Private key not found" error:
   → openRecovery() from context
   → RecoveryDialog opens with context="room" message
6. After successful restore → retry unlockRoomKeyFromMembership
7. Room loads normally
```

### Flow F: User wants to re-download recovery kit

```
1. User goes to Profile page
2. Sees "Recovery Kit" section
3. Clicks "Download New Recovery Kit"
4. Private key loaded from IndexedDB
5. <RecoveryDownload> renders
6. User enters passphrase + confirm → new .json file downloads
```

---

## 9. Integration Points

### 9.1 `packages/frontend/src/lib/crypto.ts` — New exports

```typescript
// NEW — quick check without loading CryptoKey object
export async function hasPrivateKeyInDB(userId: string): Promise<boolean>
```

### 9.2 `packages/frontend/src/components/layout/app-shell.tsx` — Changes

```tsx
import { KeyHealthProvider } from "@/components/key-recovery/provider";
import { KeyStatusBanner } from "@/components/key-recovery/key-status-banner";
import { RecoveryDialog } from "@/components/key-recovery/recovery-dialog";

export function AppShell({ children }) {
  return (
    <KeyHealthProvider>
      <div className="flex min-h-screen flex-col ...">
        <header>...</header>
        <KeyStatusBanner />  {/* below header, only when keys missing */}
        <main>...</main>
        <RecoveryDialog />   {/* global modal */}
        <nav>...</nav>
      </div>
    </KeyHealthProvider>
  );
}
```

### 9.3 `packages/frontend/src/app/sign-in/page.tsx` — Refactored

The existing inline restore UI is replaced with the shared `RecoveryDialog`:
- After login detects missing key → call `openRecovery()` from context
- OR: keep the inline restore prompt but use `handleRestoreKey` that calls `refreshKeyStatus()` after success
- Decision: **Keep inline restore** for the sign-in flow specifically. It feels more natural to stay on the sign-in page rather than pop a modal. But the error/success UI and decryption logic use the shared helpers.

### 9.4 `packages/frontend/src/app/sign-up/page.tsx` — Refactored

- Step 3 uses `<RecoveryDownload>` component instead of inline HTML
- No change to the download logic itself, just UI extraction

### 9.5 `packages/frontend/src/app/rooms/[roomId]/page.tsx` — Error handling improved

```typescript
// Instead of:
const roomKey = await unlockRoomKeyFromMembership(roomId, userId, encryptedRoomKey);

// Wrap in try-catch with recovery context:
try {
  roomKeyRef.current = cachedRoomKey ||
    await unlockRoomKeyFromMembership(roomId, userId, encryptedRoomKey);
} catch (err) {
  if (err.message?.includes("Private key not found")) {
    // Show error in status, open recovery dialog
    setStatus("Private key missing. Use the restore option.");
    // openRecovery() — but we can't call hooks here
    // Instead: set a state flag, and a useEffect reacts to it
    setShowRecoveryPrompt(true);
    return;
  }
  throw err;
}
```

### 9.6 `packages/frontend/src/app/profile/page.tsx` — New section

Add a "Recovery Kit" section in the profile sidebar:
- **If key exists**: "Recovery Kit is configured" badge + "Download New Recovery Kit" button
- **If key missing**: "Keys not restored" badge + "Restore Identity" CTA (opens RecoveryDialog)
- The "Download New Recovery Kit" flow loads the private key from IndexedDB, then shows `<RecoveryDownload>` inline

### 9.7 New files

| File | Purpose |
|------|---------|
| `src/components/key-recovery/provider.tsx` | `KeyHealthProvider` context + `useKeyHealth` hook |
| `src/components/key-recovery/recovery-dialog.tsx` | Shared restore modal |
| `src/components/key-recovery/key-status-banner.tsx` | Fixed banner in AppShell |
| `src/components/key-recovery/recovery-download.tsx` | Shared download UI |

---

## 10. File Change Summary

### New files (4)

| # | Path | Purpose |
|---|------|---------|
| 1 | `packages/frontend/src/components/key-recovery/provider.tsx` | `KeyHealthProvider` context + `useKeyHealth` hook |
| 2 | `packages/frontend/src/components/key-recovery/recovery-dialog.tsx` | Shared restore modal with file upload + decryption |
| 3 | `packages/frontend/src/components/key-recovery/key-status-banner.tsx` | Persistent banner in AppShell |
| 4 | `packages/frontend/src/components/key-recovery/recovery-download.tsx` | Shared download UI for sign-up + profile |

### Modified files (6)

| # | Path | Changes |
|---|------|---------|
| 5 | `packages/frontend/src/lib/crypto.ts` | Add `hasPrivateKeyInDB(userId)` helper |
| 6 | `packages/frontend/src/components/layout/app-shell.tsx` | Wrap in `KeyHealthProvider`, add `<KeyStatusBanner>`, add `<RecoveryDialog>` |
| 7 | `packages/frontend/src/app/sign-up/page.tsx` | Step 3 uses `<RecoveryDownload>` |
| 8 | `packages/frontend/src/app/sign-in/page.tsx` | Inline restore uses shared decryption helpers; on success calls `refreshKeyStatus()` |
| 9 | `packages/frontend/src/app/rooms/[roomId]/page.tsx` | Catch key-missing error → trigger recovery dialog |
| 10 | `packages/frontend/src/app/profile/page.tsx` | Add "Recovery Kit" section with download + restore |

---

## 11. Edge Cases & Error Handling

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | **User has no account** | `KeyHealthProvider` doesn't check (`session?.user` is null) — no banner, no context |
| 2 | **IndexedDB unavailable** (incognito, old browser) | `hasPrivateKeyInDB` rejects → `keyCheckLoading` stays true → no false negatives. Room page will show error on key attempt. |
| 3 | **Recovery kit file is malformed** | JSON parse fails → "Invalid recovery kit file structure" error in dialog |
| 4 | **Recovery kit belongs to different user** | Decryption succeeds but `recoveryFile.userId` doesn't match current user → key is saved anyway (userId is just a reference). Room keys from old account won't work. Show warning: "This kit belongs to a different account." |
| 5 | **Wrong passphrase** | AES-GCM decrypt throws → "Decryption failed. Please verify the passphrase." |
| 6 | **Multiple tabs open** | Each tab has its own `KeyHealthProvider`. Banner shows in all tabs until dismissed in each. Recovery in one tab doesn't auto-update others — acceptable, banner dismisses on reload. |
| 7 | **Private key exists but public key missing on server** | Handled by existing logic in `room-discovery.tsx` (generate keys banner). Not in scope. |
| 8 | **User logs out** | `session?.user` becomes null → `hasPrivateKey` resets to false → no banner (user not authenticated). |
| 9 | **Banner dismissed then user recovers key via profile** | `refreshKeyStatus()` updates context → `hasPrivateKey` becomes true → banner auto-hides even if dismissed earlier. |
| 10 | **Recovery kit file with newlines/whitespace** | `JSON.parse` handles this naturally. |
| 11 | **User drags wrong file type** | Accept `.json` only via `accept=".json"` on file input. |
| 12 | **Concurrent restore + room entry** | If user opens recovery dialog while room page is loading, the room page will retry after `refreshKeyStatus()` notifies the context. Room page should poll or listen to context changes. |

---

## 12. UI / Theme Considerations

### Design system tokens to use

| Token | Value | Usage |
|-------|-------|-------|
| `bg-black` | `#000` | Page background |
| `bg-neutral-950` | `#0a0a0a` | Card/section background |
| `border-neutral-800` | `#262626` | Default borders |
| `border-neutral-900` | `#171717` | Subtle borders |
| `text-white` | `#fff` | Primary text |
| `text-neutral-400` | `#a3a3a3` | Secondary text |
| `text-neutral-500` | `#737373` | Muted text |
| `#66fcf1` | Teal accent | Primary CTAs, focus states |
| `#45a29e` | Darker teal | Hover states |
| `text-yellow-200` / `bg-yellow-500/10` | Amber | Warning banner |
| `text-red-400` / `bg-red-500/10` | Red | Error messages |
| `text-teal-400` / `bg-teal-500/10` | Green | Success states |

### Mobile compatibility

- **Banner**: Full width, text wraps, CTA stays inline, dismiss icon in top-right corner
- **Dialog**: Full-screen on mobile (`max-w-md w-full` with padding), scrollable if content overflows
- **File upload**: Tap target min 44px, labeled clearly
- **Input fields**: Standard 12px+ padding, readable on mobile
- **Bottom sheet**: Consider using a bottom-sheet variant of the dialog on mobile for better thumb reach

### Animation guidelines

- **Dialog open**: Fade in overlay + scale up container (`opacity-0 → opacity-100`, `scale-95 → scale-100`, 200ms)
- **Dialog close**: Reverse animation
- **Success state**: Pulsing glow on the check icon (`animate-pulse` + `glow-text`)
- **Loading spinner**: Same spinning border style as sign-up step 2
- **Banner**: Slide down from top on mount if shown

### Accessibility notes

- All form inputs have associated `<label>` elements
- Error messages use `aria-live="polite"` (or the container is role="alert")
- Dialog uses `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- Focus is trapped within the dialog when open
- Escape key closes the dialog
- File upload area is keyboard-accessible (hidden input triggered by button/label)
- Color contrast: `text-amber-200` on `bg-amber-500/10` meets WCAG AA for large text
- Passphrase input is `type="password"` with `autocomplete="off"`
