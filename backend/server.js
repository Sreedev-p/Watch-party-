const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });


// Global state memory
let roomState = { state: 'paused', time: 0, lastUpdate: Date.now() };

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Wait for the client to explicitly ask for the state
    socket.on('request_sync', () => {
        let currentVideoTime = roomState.time;
        if (roomState.state === 'playing') {
            // Calculate exact drift from the moment they clicked "Join"
            const elapsedSeconds = (Date.now() - roomState.lastUpdate) / 1000;
            currentVideoTime += elapsedSeconds;
        }
        
        socket.emit('initial_state', { state: roomState.state, time: currentVideoTime });
    });

    socket.on('play_video', (time) => {
        roomState = { state: 'playing', time: time, lastUpdate: Date.now() };
        socket.broadcast.emit('sync_play', time);
    });

    socket.on('pause_video', (time) => {
        roomState = { state: 'paused', time: time, lastUpdate: Date.now() };
        socket.broadcast.emit('sync_pause', time);
    });
});

server.listen(3000, () => console.log(`Server running on port 3000`));