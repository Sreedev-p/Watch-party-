require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, '../frontend')));

// 4-Tier RBAC Privilege Hierarchy
const ROLES = {
    MEMBER: 'member',   // Level 1: Watch, chat, join call
    CURATOR: 'curator', // Level 2: + Add videos to queue
    ADMIN: 'admin',     // Level 3: + Play/Pause/Seek/Skip, moderate lower ranks
    OWNER: 'owner'      // Level 4: Absolute control over everyone
};

const ROLE_LEVEL = {
    'member': 1,
    'curator': 2,
    'admin': 3,
    'owner': 4
};

// In-Memory Room Dictionary
const rooms = {};

function getPublicRooms() {
    const publicList = [];
    for (const [id, roomData] of Object.entries(rooms)) {
        if (roomData.isPublic) {
            const count = Object.keys(roomData.users).length;
            if (count > 0) {
                publicList.push({ roomId: id, count: count });
            }
        }
    }
    return publicList;
}

// Broadcast the full member list and their roles/restrictions to everyone in the room
function broadcastRoster(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('update_roster', Object.values(room.users));
}

function admitUserToRoom(targetSocket, roomId, username, assignedRole = ROLES.MEMBER) {
    const room = rooms[roomId];
    if (!room) return;

    targetSocket.join(roomId);
    targetSocket.roomId = roomId;
    targetSocket.username = username;

    // Register user in the room's RBAC state
    room.users[targetSocket.id] = {
        id: targetSocket.id,
        username: username,
        role: assignedRole,
        chatRestricted: false,
        callMuted: false,
        inCall: false
    };

    targetSocket.emit('room_joined', {
        roomId,
        username,
        isPublic: room.isPublic,
        role: assignedRole
    });

    targetSocket.emit('update_queue', room.queue);
    broadcastRoster(roomId);

    targetSocket.to(roomId).emit('chat_message', {
        sender: 'System',
        text: `${username} joined the room as ${assignedRole.toUpperCase()}.`
    });

    io.emit('room_list', getPublicRooms());
}

io.on('connection', (socket) => {
    console.log(`Connection opened: ${socket.id}`);

    socket.emit('room_list', getPublicRooms());

    // 1. CREATE A NEW ROOM (Creator becomes OWNER)
    socket.on('create_room', ({ roomId, username, isPublic }) => {
        if (rooms[roomId]) {
            return socket.emit('room_error', `Room "${roomId}" already exists! Click "Join Room" instead.`);
        }

        rooms[roomId] = {
            ownerId: socket.id,
            isPublic: Boolean(isPublic),
            state: 'paused',
            time: 0,
            lastUpdate: Date.now(),
            videoId: '8hP9D6kZseM',
            queue: [],
            lastQueuePop: 0,
            users: {} // Maps socket.id -> User RBAC Object
        };

        admitUserToRoom(socket, roomId, username, ROLES.OWNER);
    });

    // 2. JOIN AN EXISTING ROOM (Default rank: MEMBER)
    socket.on('join_room', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            return socket.emit('room_error', `Room "${roomId}" does not exist! Click "Create Room" first.`);
        }

        if (room.isPublic) {
            admitUserToRoom(socket, roomId, username, ROLES.MEMBER);
        } else {
            socket.tempUsername = username;
            socket.emit('waiting_for_host', `Waiting for the room Owner to approve your request...`);
            io.to(room.ownerId).emit('knock_request', {
                requesterId: socket.id,
                username: username,
                roomId: roomId
            });
        }
    });

    // 3. OWNER APPROVES OR DENIES PRIVATE KNOCK REQUEST
    socket.on('resolve_knock', ({ requesterId, approved }) => {
        const room = rooms[socket.roomId];
        if (!room || room.ownerId !== socket.id) return;

        const requesterSocket = io.sockets.sockets.get(requesterId);
        if (!requesterSocket) return;

        if (approved) {
            admitUserToRoom(requesterSocket, socket.roomId, requesterSocket.tempUsername, ROLES.MEMBER);
        } else {
            requesterSocket.emit('room_error', 'The room Owner declined your request to join.');
        }
    });

    // 4. HIERARCHICAL RBAC MODERATION ACTIONS (WP-109)
    socket.on('moderate_user', ({ targetId, action, newRole }) => {
        const room = rooms[socket.roomId];
        if (!room) return;

        const actor = room.users[socket.id];
        const target = room.users[targetId];
        if (!actor || !target || socket.id === targetId) return;

        const actorLevel = ROLE_LEVEL[actor.role];
        const targetLevel = ROLE_LEVEL[target.role];

        // Rule: Must be at least Admin (3), and must strictly outrank the target user!
        if (actorLevel < ROLE_LEVEL.ADMIN || actorLevel <= targetLevel) return;

        const targetSocket = io.sockets.sockets.get(targetId);

        switch (action) {
            case 'set_role':
                // Only Owner (4) can promote someone to Admin (3). Admins (3) can only set Member (1) or Curator (2).
                if (!ROLE_LEVEL[newRole] || newRole === ROLES.OWNER) return;
                if (actorLevel === ROLE_LEVEL.ADMIN && ROLE_LEVEL[newRole] >= ROLE_LEVEL.ADMIN) return;

                target.role = newRole;
                if (targetSocket) targetSocket.emit('role_updated', newRole);
                io.to(socket.roomId).emit('chat_message', {
                    sender: 'System',
                    text: `🎖️ ${actor.username} changed ${target.username}'s role to ${newRole.toUpperCase()}.`
                });
                break;

            case 'toggle_chat':
                target.chatRestricted = !target.chatRestricted;
                if (targetSocket) targetSocket.emit('chat_restriction_updated', target.chatRestricted);
                io.to(socket.roomId).emit('chat_message', {
                    sender: 'System',
                    text: target.chatRestricted
                        ? `🔇 ${actor.username} restricted ${target.username} from chatting.`
                        : `🔊 ${actor.username} restored ${target.username}'s chat privileges.`
                });
                break;

            case 'toggle_call_mute':
                target.callMuted = !target.callMuted;
                if (targetSocket) targetSocket.emit('force_mute_status', target.callMuted);
                io.to(socket.roomId).emit('chat_message', {
                    sender: 'System',
                    text: target.callMuted
                        ? `🎙️❌ ${actor.username} server-muted ${target.username} in the call.`
                        : `🎙️✅ ${actor.username} unmuted ${target.username} in the call.`
                });
                break;

            case 'remove_from_call':
                target.inCall = false;
                if (targetSocket) {
                    if (targetSocket.peerId) {
                        io.to(socket.roomId).emit('user_left_video', targetSocket.peerId);
                        targetSocket.peerId = null;
                    }
                    targetSocket.emit('force_leave_call');
                }
                io.to(socket.roomId).emit('chat_message', {
                    sender: 'System',
                    text: `📷❌ ${actor.username} removed ${target.username} from the video call.`
                });
                break;

            case 'kick_from_room':
                if (targetSocket) {
                    if (targetSocket.peerId) {
                        io.to(socket.roomId).emit('user_left_video', targetSocket.peerId);
                        targetSocket.peerId = null;
                    }
                    targetSocket.leave(socket.roomId);
                    targetSocket.roomId = null;
                    targetSocket.emit('kicked_from_room', `You were removed from the room by ${actor.username}.`);
                }
                delete room.users[targetId];
                io.to(socket.roomId).emit('chat_message', {
                    sender: 'System',
                    text: `👢 ${actor.username} kicked ${target.username} from the room.`
                });
                io.emit('room_list', getPublicRooms());
                break;
        }

        broadcastRoster(socket.roomId);
    });

    // 5. VIDEO SYNCING (Requires ADMIN [3] or OWNER [4])
    socket.on('request_sync', () => {
        const room = rooms[socket.roomId];
        if (!room) return;

        let currentVideoTime = room.time;
        if (room.state === 'playing') {
            const elapsedSeconds = (Date.now() - room.lastUpdate) / 1000;
            currentVideoTime += elapsedSeconds;
        }
        socket.emit('initial_state', { state: room.state, time: currentVideoTime, videoId: room.videoId });
    });

    socket.on('play_video', (time) => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        rooms[socket.roomId] = { ...room, state: 'playing', time: time, lastUpdate: Date.now() };
        socket.to(socket.roomId).emit('sync_play', time);
    });

    socket.on('pause_video', (time) => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        rooms[socket.roomId] = { ...room, state: 'paused', time: time, lastUpdate: Date.now() };
        socket.to(socket.roomId).emit('sync_pause', time);
    });

    socket.on('skip_video', () => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        if (room.queue.length > 0) {
            const nextVideo = room.queue.shift();
            room.videoId = nextVideo.videoId;
            room.time = 0;
            room.state = 'playing';
            room.lastUpdate = Date.now();
            room.lastQueuePop = Date.now();

            io.to(socket.roomId).emit('load_new_video', nextVideo.videoId);
            io.to(socket.roomId).emit('update_queue', room.queue);
            io.to(socket.roomId).emit('chat_message', {
                sender: 'System',
                text: `⏭ ${user.username} skipped to: ${nextVideo.title}`
            });
        }
    });

    // 6. YOUTUBE SEARCH & QUEUE (Requires CURATOR [2], ADMIN [3], or OWNER [4])
    socket.on('search_youtube', async (query) => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.CURATOR) return;

        try {
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(query)}&type=video&key=${process.env.YOUTUBE_API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            if (data.items) socket.emit('search_results', data.items);
        } catch (error) {
            console.error("YouTube API Error:", error);
        }
    });

    socket.on('add_to_queue', (videoData) => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.CURATOR) return;

        room.queue.push(videoData);
        io.to(socket.roomId).emit('update_queue', room.queue);
        io.to(socket.roomId).emit('chat_message', {
            sender: 'System',
            text: `🎵 ${user.username} added "${videoData.title}" to the queue.`
        });
    });

    socket.on('video_ended', () => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        const room = rooms[socket.roomId];

        if (Date.now() - room.lastQueuePop < 5000) return;

        if (room.queue.length > 0) {
            const nextVideo = room.queue.shift();
            room.videoId = nextVideo.videoId;
            room.time = 0;
            room.state = 'playing';
            room.lastUpdate = Date.now();
            room.lastQueuePop = Date.now();

            io.to(socket.roomId).emit('load_new_video', nextVideo.videoId);
            io.to(socket.roomId).emit('update_queue', room.queue);
        }
    });

    // 7. LIVE CHAT (Checks if user is chatRestricted)
    socket.on('chat_message', (text) => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !user || user.chatRestricted) return;

        io.to(socket.roomId).emit('chat_message', { sender: user.username, text: text });
    });

    // 8. WEBRTC VIDEO CALL SIGNALING
    socket.on('join_video_call', (peerId) => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !user) return;

        socket.peerId = peerId;
        user.inCall = true;
        broadcastRoster(socket.roomId);

        // Enforce server-mute immediately if they were already muted by an Admin
        if (user.callMuted) {
            socket.emit('force_mute_status', true);
        }

        socket.to(socket.roomId).emit('user_joined_video', {
            peerId: peerId,
            username: user.username
        });
    });

    socket.on('leave_video_call', () => {
        const room = rooms[socket.roomId];
        const user = room?.users[socket.id];
        if (!room || !socket.peerId) return;

        if (user) user.inCall = false;
        socket.to(socket.roomId).emit('user_left_video', socket.peerId);
        socket.peerId = null;
        broadcastRoster(socket.roomId);
    });

    // 9. DISCONNECT & PRIORITY OWNER SUCCESSION (Owner -> Admin -> Curator -> Member)
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const departingUser = room.users[socket.id];

        if (socket.peerId) {
            socket.to(roomId).emit('user_left_video', socket.peerId);
        }

        delete room.users[socket.id];

        socket.to(roomId).emit('chat_message', {
            sender: 'System',
            text: `${socket.username} left the watch party.`
        });

        const remainingUsers = Object.values(room.users);

        if (remainingUsers.length === 0) {
            console.log(`Room ${roomId} is empty. Deleting from memory.`);
            delete rooms[roomId];
        } else {
            // If the Owner left, pick the highest ranking member (Admin > Curator > Member)
            if (room.ownerId === socket.id) {
                remainingUsers.sort((a, b) => ROLE_LEVEL[b.role] - ROLE_LEVEL[a.role]);
                const newOwner = remainingUsers[0];
                newOwner.role = ROLES.OWNER;
                room.ownerId = newOwner.id;

                io.to(newOwner.id).emit('role_updated', ROLES.OWNER);
                io.to(roomId).emit('chat_message', {
                    sender: 'System',
                    text: `👑 ${newOwner.username} succeeded as the new Room Owner!`
                });
            }
            broadcastRoster(roomId);
        }

        io.emit('room_list', getPublicRooms());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Production server running on port ${PORT}`));