const socket = io();

let player;
let isSyncing = false;
let syncFailsafe;
let debounceTimer;

function blockEcho() {
    isSyncing = true;
    clearTimeout(syncFailsafe);
    syncFailsafe = setTimeout(() => { isSyncing = false; }, 1000);
}

// ==========================================
// 1. YOUTUBE IFRAME API INITIALIZATION
// ==========================================
window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('player', {
        height: '360',
        width: '640',
        videoId: '8hP9D6kZseM',
        playerVars: {
            'controls': 0,
            'disablekb': 1,
            'rel': 0,
            'modestbranding': 1
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
};

function onPlayerReady() {
    console.log("YouTube player loaded in background.");
    setInterval(updateProgressBar, 500);
}

function onPlayerStateChange(event) {
    if (event.data === 1 || event.data === 2) updatePlayPauseUI(event.data);

    // Trigger next video in queue when current ends (WP-105)
    if (event.data === 0) {
        socket.emit('video_ended');
        return;
    }

    if (event.data === 3 || event.data === -1) return;
    if (isSyncing) {
        isSyncing = false;
        clearTimeout(syncFailsafe);
        return;
    }
}

// ==========================================
// 2. CUSTOM PLAYER CONTROLS
// ==========================================
function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function updatePlayPauseUI(state) {
    const btn = document.getElementById('btn-play-pause');
    btn.innerText = (state === 1) ? '⏸' : '▶';
}

function updateProgressBar() {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    const current = player.getCurrentTime() || 0;
    const duration = player.getDuration() || 0;
    if (duration > 0) {
        document.getElementById('seek-bar').value = (current / duration) * 100;
        document.getElementById('time-display').innerText = `${formatTime(current)} / ${formatTime(duration)}`;
    }
}

document.getElementById('btn-play-pause').addEventListener('click', () => {
    const state = player.getPlayerState();
    const currentTime = player.getCurrentTime();
    if (state === 1) {
        player.pauseVideo();
        socket.emit('pause_video', currentTime);
    } else {
        player.playVideo();
        socket.emit('play_video', currentTime);
    }
});

document.getElementById('seek-bar').addEventListener('input', (e) => {
    const duration = player.getDuration();
    const seekToTime = (e.target.value / 100) * duration;
    player.seekTo(seekToTime, true);
    socket.emit('play_video', seekToTime);
});

document.getElementById('btn-mute').addEventListener('click', () => {
    if (player.isMuted()) {
        player.unMute();
        document.getElementById('btn-mute').innerText = '🔊';
        document.getElementById('volume-slider').value = player.getVolume();
    } else {
        player.mute();
        document.getElementById('btn-mute').innerText = '🔇';
        document.getElementById('volume-slider').value = 0;
    }
});

document.getElementById('volume-slider').addEventListener('input', (e) => {
    const vol = e.target.value;
    player.setVolume(vol);
    if (vol > 0 && player.isMuted()) {
        player.unMute();
        document.getElementById('btn-mute').innerText = '🔊';
    } else if (vol == 0) {
        document.getElementById('btn-mute').innerText = '🔇';
    }
});

// ==========================================
// 3. ROOM, LOBBY & KNOCK LOGIC (WP-104 & WP-106)
// ==========================================
const loginAlert = document.getElementById('login-alert');

function showLoginAlert(msg, isError = true) {
    loginAlert.style.display = 'block';
    loginAlert.style.background = isError ? '#5a1d1d' : '#1d4d5a';
    loginAlert.style.color = '#fff';
    loginAlert.textContent = msg;
}

function getCredentials() {
    const username = document.getElementById('username-input').value.trim();
    const roomId = document.getElementById('room-input').value.trim();
    if (!username || !roomId) {
        showLoginAlert("Please enter both your name and a room code.");
        return null;
    }
    return { username, roomId };
}

// Button 1: Create Room
document.getElementById('btn-create-room').addEventListener('click', () => {
    const creds = getCredentials();
    if (!creds) return;
    const isPublic = document.getElementById('public-checkbox').checked;
    socket.emit('create_room', { ...creds, isPublic });
});

// Button 2: Join Existing Room
document.getElementById('btn-join-room').addEventListener('click', () => {
    const creds = getCredentials();
    if (!creds) return;
    socket.emit('join_room', creds);
});

// Server Errors & Waiting States
socket.on('room_error', (msg) => showLoginAlert(msg, true));
socket.on('waiting_for_host', (msg) => showLoginAlert(msg, false));

// Successfully Admitted to Room
socket.on('room_joined', ({ roomId, username, isPublic, isHost }) => {
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('status').innerText = 
        `Room: ${roomId} (${isPublic ? 'Public' : 'Private'}) | User: ${username} ${isHost ? '👑 (Host)' : ''}`;

    if (player && typeof player.unMute === 'function') {
        player.unMute();
        document.getElementById('btn-mute').innerText = '🔊';
        document.getElementById('volume-slider').value = 100;
        socket.emit('request_sync');
    }
});

// Host receives a Knock Request from someone trying to join Private Room
socket.on('knock_request', ({ requesterId, username }) => {
    const container = document.getElementById('knock-container');
    const banner = document.createElement('div');
    banner.style.cssText = 'background: #2a2a2a; border-left: 4px solid #e50914; padding: 10px 15px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center;';

    const text = document.createElement('span');
    text.textContent = `🔒 "${username}" wants to join this private room.`;

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display: flex; gap: 8px;';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn-primary';
    acceptBtn.style.padding = '5px 12px';
    acceptBtn.style.fontSize = '13px';
    acceptBtn.textContent = 'Accept';

    const denyBtn = document.createElement('button');
    denyBtn.className = 'control-btn';
    denyBtn.textContent = 'Deny';

    acceptBtn.onclick = () => {
        socket.emit('resolve_knock', { requesterId, approved: true });
        banner.remove();
    };

    denyBtn.onclick = () => {
        socket.emit('resolve_knock', { requesterId, approved: false });
        banner.remove();
    };

    btnGroup.appendChild(acceptBtn);
    btnGroup.appendChild(denyBtn);
    banner.appendChild(text);
    banner.appendChild(btnGroup);
    container.appendChild(banner);
});

// Render Active Public Rooms
socket.on('room_list', (publicRooms) => {
    const listContainer = document.getElementById('public-rooms-list');
    listContainer.innerHTML = '';

    if (publicRooms.length === 0) {
        listContainer.innerHTML = '<div style="font-size: 12px; color: #666;">No public rooms active.</div>';
        return;
    }

    publicRooms.forEach(room => {
        const item = document.createElement('div');
        item.className = 'public-room-item';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = `Room: ${room.roomId}`;

        const countSpan = document.createElement('span');
        countSpan.className = 'badge-count';
        countSpan.textContent = `${room.count} online`;

        item.appendChild(nameSpan);
        item.appendChild(countSpan);

        item.addEventListener('click', () => {
            const username = document.getElementById('username-input').value.trim();
            if (!username) {
                showLoginAlert("Enter your name first, then click the public room!");
                document.getElementById('username-input').focus();
                return;
            }
            socket.emit('join_room', { roomId: room.roomId, username });
        });

        listContainer.appendChild(item);
    });
});

// ==========================================
// 4. SOCKET SYNC LISTENERS
// ==========================================
socket.on('initial_state', (data) => {
    blockEcho();
    const currentVideoUrl = player.getVideoUrl();
    if (!currentVideoUrl.includes(data.videoId)) {
        player.loadVideoById(data.videoId, data.time);
    } else {
        player.seekTo(data.time);
    }

    if (data.state === 'playing') player.playVideo();
    else player.pauseVideo();
});

socket.on('sync_play', (time) => {
    blockEcho();
    if (Math.abs(player.getCurrentTime() - time) > 1.5) {
        player.seekTo(time, true);
    }
    player.playVideo();
});

socket.on('sync_pause', (time) => {
    blockEcho();
    player.seekTo(time, true);
    player.pauseVideo();
});

socket.on('load_new_video', (videoId) => {
    blockEcho();
    player.loadVideoById(videoId, 0);
    player.playVideo();
});

// ==========================================
// 5. DEBOUNCED SEARCH & QUEUE (WP-102 & WP-105)
// ==========================================
document.getElementById('search-input').addEventListener('input', (e) => {
    const query = e.target.value;
    clearTimeout(debounceTimer);

    if (query.trim().length > 0) {
        debounceTimer = setTimeout(() => {
            socket.emit('search_youtube', query);
        }, 500);
    } else {
        document.getElementById('search-results').innerHTML = '';
    }
});

socket.on('search_results', (items) => {
    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '';

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'result-item';

        const img = document.createElement('img');
        img.src = item.snippet.thumbnails.default.url;
        img.className = 'result-thumb';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'result-title';
        titleDiv.textContent = item.snippet.title;

        const btn = document.createElement('button');
        btn.className = 'control-btn';
        btn.textContent = '+ Queue';

        div.appendChild(img);
        div.appendChild(titleDiv);
        div.appendChild(btn);

        div.addEventListener('click', () => {
            socket.emit('add_to_queue', {
                videoId: item.id.videoId,
                title: item.snippet.title
            });
            resultsContainer.innerHTML = '';
            document.getElementById('search-input').value = '';
        });

        resultsContainer.appendChild(div);
    });
});

socket.on('update_queue', (queue) => {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    if (queue.length === 0) {
        list.textContent = 'Queue is empty.';
    } else {
        queue.forEach((v, index) => {
            const item = document.createElement('div');
            item.textContent = `${index + 1}. ${v.title}`;
            list.appendChild(item);
        });
    }
});

// ==========================================
// 6. LIVE CHAT (WP-103)
// ==========================================
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');

function sendMessage() {
    const text = chatInput.value.trim();
    if (text.length > 0) {
        socket.emit('chat_message', text);
        chatInput.value = '';
    }
}

document.getElementById('btn-send-chat').addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

socket.on('chat_message', (data) => {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg';

    const senderSpan = document.createElement('span');
    senderSpan.className = 'chat-sender';
    senderSpan.textContent = `${data.sender}: `;

    const textSpan = document.createElement('span');
    textSpan.textContent = data.text;

    msgDiv.appendChild(senderSpan);
    msgDiv.appendChild(textSpan);

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});