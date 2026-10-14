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

// Serve the modular frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

// In-Memory Room Dictionary
const rooms = {};

// Helper to compile a list of active public rooms for the lobby
function getPublicRooms() {
    const publicList = [];
    for (const [id, roomData] of Object.entries(rooms)) {
        if (roomData.isPublic) {
            const occupants = io.sockets.adapter.rooms.get(id);
            const count = occupants ? occupants.size : 0;
            if (count > 0) {
                publicList.push({ roomId: id, count: count });
            }
        }
    }
    return publicList;
}

// Helper to admit an approved user into a room
function admitUserToRoom(targetSocket, roomId, username) {
    targetSocket.join(roomId);
    targetSocket.roomId = roomId;
    targetSocket.username = username;

    const room = rooms[roomId];
    targetSocket.emit('room_joined', {
        roomId,
        username,
        isPublic: room.isPublic,
        isHost: room.hostId === targetSocket.id
    });

    // Send the existing queue to the new joiner
    targetSocket.emit('update_queue', room.queue);

    targetSocket.to(roomId).emit('chat_message', {
        sender: 'System',
        text: `${username} joined the watch party.`
    });

    io.emit('room_list', getPublicRooms());
}

io.on('connection', (socket) => {
    console.log(`Connection opened: ${socket.id}`);

    // Send active public rooms on initial load
    socket.emit('room_list', getPublicRooms());

    // 1. CREATE A NEW ROOM
    socket.on('create_room', ({ roomId, username, isPublic }) => {
        if (rooms[roomId]) {
            return socket.emit('room_error', `Room "${roomId}" already exists! Click "Join Room" instead.`);
        }

        rooms[roomId] = {
            hostId: socket.id,
            isPublic: Boolean(isPublic),
            state: 'paused',
            time: 0,
            lastUpdate: Date.now(),
            videoId: '8hP9D6kZseM',
            queue: [],
            lastQueuePop: 0
        };

        admitUserToRoom(socket, roomId, username);
    });

    // 2. JOIN AN EXISTING ROOM
    socket.on('join_room', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            return socket.emit('room_error', `Room "${roomId}" does not exist! Click "Create Room" first.`);
        }

        if (room.isPublic) {
            admitUserToRoom(socket, roomId, username);
        } else {
            // Private Room: Save name temporarily and ask the Host for permission
            socket.tempUsername = username;
            socket.emit('waiting_for_host', `Waiting for the room creator to approve your request...`);
            io.to(room.hostId).emit('knock_request', {
                requesterId: socket.id,
                username: username,
                roomId: roomId
            });
        }
    });

    // 3. HOST APPROVES OR DENIES KNOCK REQUEST
    socket.on('resolve_knock', ({ requesterId, approved }) => {
        const room = rooms[socket.roomId];
        if (!room || room.hostId !== socket.id) return;

        const requesterSocket = io.sockets.sockets.get(requesterId);
        if (!requesterSocket) return;

        if (approved) {
            admitUserToRoom(requesterSocket, socket.roomId, requesterSocket.tempUsername);
        } else {
            requesterSocket.emit('room_error', 'The room host declined your request to join.');
        }
    });

    // 4. VIDEO SYNCING
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
        if (!socket.roomId || !rooms[socket.roomId]) return;
        rooms[socket.roomId] = { ...rooms[socket.roomId], state: 'playing', time: time, lastUpdate: Date.now() };
        socket.to(socket.roomId).emit('sync_play', time);
    });

    socket.on('pause_video', (time) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        rooms[socket.roomId] = { ...rooms[socket.roomId], state: 'paused', time: time, lastUpdate: Date.now() };
        socket.to(socket.roomId).emit('sync_pause', time);
    });

    // 5. YOUTUBE SEARCH & QUEUE
    socket.on('search_youtube', async (query) => {
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
        if (!socket.roomId || !rooms[socket.roomId]) return;
        rooms[socket.roomId].queue.push(videoData);
        io.to(socket.roomId).emit('update_queue', rooms[socket.roomId].queue);
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

    // 6. LIVE CHAT
    socket.on('chat_message', (text) => {
        if (!socket.roomId) return;
        io.to(socket.roomId).emit('chat_message', { sender: socket.username, text: text });
    });

    // 6.5 WEBRTC VIDEO CALL SIGNALING (WP-107)
    socket.on('join_video_call', (peerId) => {
        if (!socket.roomId) return;
        socket.peerId = peerId;
        // Tell everyone else in the room to connect their webcam stream to this Peer ID
        socket.to(socket.roomId).emit('user_joined_video', {
            peerId: peerId,
            username: socket.username
        });
    });

    socket.on('leave_video_call', () => {
        if (!socket.roomId || !socket.peerId) return;
        socket.to(socket.roomId).emit('user_left_video', socket.peerId);
        socket.peerId = null;
    });
    // 7. DISCONNECT & CLEANUP
    socket.on('disconnect', () => {
        if (!socket.roomId) return;

        if (socket.peerId) {
            socket.to(socket.roomId).emit('user_left_video', socket.peerId);
        }
        
        socket.to(socket.roomId).emit('chat_message', {
            sender: 'System',
            text: `${socket.username} left the watch party.`
        });

        const roomOccupants = io.sockets.adapter.rooms.get(socket.roomId);

        if (!roomOccupants || roomOccupants.size === 0) {
            console.log(`Room ${socket.roomId} is empty. Deleting from memory.`);
            delete rooms[socket.roomId];
        } else if (rooms[socket.roomId] && rooms[socket.roomId].hostId === socket.id) {
            // Transfer Host to the next remaining user
            const nextHostId = roomOccupants.values().next().value;
            rooms[socket.roomId].hostId = nextHostId;
            io.to(nextHostId).emit('chat_message', {
                sender: 'System',
                text: 'You are now the room Host.'
            });
        }

        io.emit('room_list', getPublicRooms());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Production server running on port ${PORT}`));