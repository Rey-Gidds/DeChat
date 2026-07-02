# Dechat Revamp Task List

- [x] **Phase 1: Project Restructuring & Monorepo Configuration**
  - [x] Initialize NPM workspaces (monorepo structure)
  - [x] Create `packages/frontend` (Next.js, TS, Tailwind)
  - [x] Create `packages/websocket-server` (dedicated Socket.io server)
  - [x] Setup base configuration files (TypeScript, ESLint, Prettier)

- [x] **Phase 2: Authentication & User Accounts (Better Auth)**
  - [x] Configure Better Auth in the API layer with Google OAuth & Email verification/password reset
  - [x] Integrate user registration/login flow
  - [x] Build client-side cryptographic key pair generator on signup
  - [x] Save public keys to database and private keys securely in client-side IndexedDB

- [x] **Phase 3: MongoDB Schema Setup & Room Metadata APIs**
  - [x] Define Mongoose/MongoDB schemas for users, rooms, memberships, and messages
  - [x] Build HTTP endpoints for room creation and listing (discovery) with cursor-based pagination
  - [x] Create database indexes for optimal search and retrieval performance

- [x] **Phase 4: Room Memberships & E2EE Key Exchange**
  - [x] Build APIs for room joining request, approval, and membership tracking
  - [x] Implement Admin client-side key wrapping logic using joining user's public key
  - [x] Store wrapped keys per member in the room membership collection

- [x] **Phase 5: WebSocket Server Setup & Authentication Handshake**
  - [x] Configure standalone Express & Socket.io server with TypeScript
  - [x] Build authorization handshake validation inside WebSocket connection middleware
  - [x] Setup socket room subscription logic

- [x] **Phase 6: Realtime E2EE Messages & Persistence**
  - [x] Build client-to-server messaging using Socket.io
  - [x] Implement client-side encryption/decryption (AES-256-GCM)
  - [x] Implement database persistence for encrypted message ciphertext, IV, and tag
  - [x] Implement ephemeral typing indicators broadcasted through sockets

- [x] **Phase 7: History Loading, Reconnect Recovery, and Pagination**
  - [x] Build cursor-based chat history retrieval via Next.js REST API
  - [x] Implement client-side decryption on loaded message history
  - [x] Implement socket reconnection sync-up protocol (fetching missed messages since last seen index)

- [ ] **Phase 8: Scaling Foundation (Redis Integration)**
  - [ ] Add Redis adapter to Socket.io server
  - [ ] Store active websocket session maps and typing states in Redis
