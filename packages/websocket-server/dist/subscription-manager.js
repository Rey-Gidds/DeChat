"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscriptionManager = exports.SubscriptionManager = void 0;
const db_1 = require("./db");
const SUBSCRIPTION_CONCURRENCY = 50;
const MAX_ROOMS = 500;
async function batchJoin(socket, roomIds) {
    if (roomIds.length === 0)
        return 0;
    const capped = roomIds.slice(0, MAX_ROOMS);
    let count = 0;
    for (let i = 0; i < capped.length; i += SUBSCRIPTION_CONCURRENCY) {
        const batch = capped.slice(i, i + SUBSCRIPTION_CONCURRENCY);
        await Promise.all(batch.map(async (roomId) => {
            if (socket.data.subscribedRooms.has(roomId))
                return;
            await socket.join(`room:${roomId}`);
            socket.data.subscribedRooms.add(roomId);
            count++;
        }));
    }
    return count;
}
class SubscriptionManager {
    async initializeSubscriptions(socket) {
        const roomIds = await (0, db_1.getApprovedMemberships)(socket.data.userId);
        console.log(`[subscription-manager] User ${socket.data.userId} has ${roomIds.length} approved memberships`);
        const joined = await batchJoin(socket, roomIds);
        console.log(`[subscription-manager] User ${socket.data.userId} joined ${joined} rooms (${roomIds.length} total)`);
        return joined;
    }
    async subscribeRoom(socket, roomId) {
        if (socket.data.subscribedRooms.has(roomId))
            return false;
        await socket.join(`room:${roomId}`);
        socket.data.subscribedRooms.add(roomId);
        return true;
    }
    async unsubscribeRoom(socket, roomId) {
        if (!socket.data.subscribedRooms.has(roomId))
            return;
        await socket.leave(`room:${roomId}`);
        socket.data.subscribedRooms.delete(roomId);
        if (socket.data.viewingRoomId === roomId) {
            socket.data.viewingRoomId = undefined;
        }
    }
    /**
     * Unsubscribes ALL sockets belonging to a user from a specific room.
     * Used when a user is kicked/blocked — all their tabs lose access.
     */
    async unsubscribeUserFromRoom(sockets, roomId) {
        await Promise.all(sockets.map((s) => {
            if (s.data?.subscribedRooms?.has(roomId)) {
                s.leave?.(`room:${roomId}`);
                s.data.subscribedRooms.delete(roomId);
                if (s.data.viewingRoomId === roomId) {
                    s.data.viewingRoomId = undefined;
                }
            }
        }));
    }
    /**
     * Unsubscribes ALL subscribers from a room. Used on room deletion.
     */
    async unsubscribeAllFromRoom(sockets, roomId) {
        await Promise.all(sockets.map((s) => {
            if (s.data?.subscribedRooms?.has(roomId)) {
                s.leave?.(`room:${roomId}`);
                s.data.subscribedRooms.delete(roomId);
                if (s.data.viewingRoomId === roomId) {
                    s.data.viewingRoomId = undefined;
                }
            }
        }));
    }
    async handleDisconnect(socket) {
        socket.data.subscribedRooms.clear();
    }
    getSubscribedRooms(socket) {
        return socket.data.subscribedRooms;
    }
}
exports.SubscriptionManager = SubscriptionManager;
exports.subscriptionManager = new SubscriptionManager();
