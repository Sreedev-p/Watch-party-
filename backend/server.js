require('dotenv').config(); // Load the hidden API key
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// Added 'videoId' to the global state
let roomState = { 
    state: 'paused', 
    time: 0, 
    lastUpdate: Date.now(),
    videoId: '8hP9D6kZseM' 
};

// --- NEW: Dictionary to hold multiple rooms ---
const rooms = {};

io.on('connection', (socket) => {
    console.log(`Connection opened: ${socket.id}`);

    // 1. Handle joining a specific room
    // --- NEW: Memory Leak Prevention & Disconnect Logic ---
    socket.on('disconnect', () => {
        if (!socket.roomId) return; // Ignore users who never joined a room

        // 1. Tell the room they left
        socket.to(socket.roomId).emit('chat_message', { 
            sender: 'System', 
            text: `${socket.username} left the watch party.` 
        });

        // 2. Check how many people are left in this specific room
        const roomOccupants = io.sockets.adapter.rooms.get(socket.roomId);
        
        // 3. If the room is completely empty, delete it from our server memory
        if (!roomOccupants || roomOccupants.size === 0) {
            console.log(`Room ${socket.roomId} is empty. Deleting from memory.`);
            delete rooms[socket.roomId]; 
        }
    });
    socket.on('join_room', ({ roomId, username }) => {
        socket.join(roomId); // Socket.io groups this user into the room
        
        // Save the data to this specific user's socket connection
        socket.roomId = roomId;
        socket.username = username;

        // If this is the first person in the room, initialize the default state
        if (!rooms[roomId]) {
            rooms[roomId] = { state: 'paused', time: 0, lastUpdate: Date.now(), videoId: '8hP9D6kZseM' };
        }

        // Announce the arrival to everyone ELSE in that room
        socket.to(roomId).emit('chat_message', { 
            sender: 'System', 
            text: `${username} joined the watch party.` 
        });
    });

    // 2. Sync requests now pull from the user's specific room
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

    // 3. Broadcasts now use `socket.to(socket.roomId)` instead of `socket.broadcast`
    socket.on('play_video', (time) => {
        if (!socket.roomId) return;
        rooms[socket.roomId] = { ...rooms[socket.roomId], state: 'playing', time: time, lastUpdate: Date.now() };
        socket.to(socket.roomId).emit('sync_play', time);
    });

    socket.on('pause_video', (time) => {
        if (!socket.roomId) return;
        rooms[socket.roomId] = { ...rooms[socket.roomId], state: 'paused', time: time, lastUpdate: Date.now() };
        socket.to(socket.roomId).emit('sync_pause', time);
    });

    socket.on('change_video', (newVideoId) => {
        if (!socket.roomId) return;
        rooms[socket.roomId] = { state: 'playing', time: 0, lastUpdate: Date.now(), videoId: newVideoId };
        
        // io.to() sends to EVERYONE in the room, including the sender
        io.to(socket.roomId).emit('load_new_video', newVideoId);
    });

    // 4. Chat now uses the custom username
    socket.on('chat_message', (text) => {
        if (!socket.roomId) return;
        io.to(socket.roomId).emit('chat_message', { sender: socket.username, text: text });
    });

    // Handle search (unchanged, just added here for completeness)
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
});

server.listen(3000, () => console.log(`Server running on port 3000`));