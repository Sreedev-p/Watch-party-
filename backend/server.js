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

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- NEW: Live Chat ---
    socket.on('chat_message', (text) => {
        // Grab the first 5 characters of the socket ID to use as a temporary username
        const tempName = `User-${socket.id.substring(0, 5)}`;
        
        // io.emit sends it to EVERYONE, including the person who sent it
        io.emit('chat_message', { sender: tempName, text: text });
    });
    
    socket.on('request_sync', () => {
        let currentVideoTime = roomState.time;
        if (roomState.state === 'playing') {
            const elapsedSeconds = (Date.now() - roomState.lastUpdate) / 1000;
            currentVideoTime += elapsedSeconds;
        }
        // Now sending videoId to new users
        socket.emit('initial_state', { 
            state: roomState.state, 
            time: currentVideoTime,
            videoId: roomState.videoId
        });
    });

    // --- NEW: Secure API Proxy ---
    socket.on('search_youtube', async (query) => {
        try {
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(query)}&type=video&key=${process.env.YOUTUBE_API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.items) {
                // Send results ONLY to the user who searched
                socket.emit('search_results', data.items);
            }
        } catch (error) {
            console.error("YouTube API Error:", error);
        }
    });

    // --- NEW: Change Video ---
    socket.on('change_video', (newVideoId) => {
        roomState = { state: 'playing', time: 0, lastUpdate: Date.now(), videoId: newVideoId };
        // Broadcast the new video to EVERYONE in the room
        io.emit('load_new_video', newVideoId);
    });

    socket.on('play_video', (time) => {
        roomState = { state: 'playing', time: time, lastUpdate: Date.now(), videoId: roomState.videoId };
        socket.broadcast.emit('sync_play', time);
    });

    socket.on('pause_video', (time) => {
        roomState = { state: 'paused', time: time, lastUpdate: Date.now(), videoId: roomState.videoId };
        socket.broadcast.emit('sync_pause', time);
    });
});

server.listen(3000, () => console.log(`Server running on port 3000`));