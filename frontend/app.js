const socket = io();

let player;
let isSyncing = false;
let syncFailsafe;
let debounceTimer;

// RBAC State (WP-109)
const ROLE_LEVEL = { member: 1, curator: 2, admin: 3, owner: 4 };
let myRole = 'member';
let isChatRestricted = false;
let isServerCallMuted = false;
let captionsEnabled = false;
let currentRoomInfo = { roomId: '', username: '', isPublic: false };

function blockEcho() {
    isSyncing = true;
    clearTimeout(syncFailsafe);
    syncFailsafe = setTimeout(() => { isSyncing = false; }, 1000);
}

// Require Admin (3) or Owner (4) to play, pause, seek, or skip
function canControlPlayback() {
    if (ROLE_LEVEL[myRole] < ROLE_LEVEL.admin) {
        alert("🛡️ Only Admins and the Room Owner can control video playback.");
        return false;
    }
    return true;
}

// Apply UI permissions based on current user's role
function applyRolePermissions() {
    const { roomId, username, isPublic } = currentRoomInfo;
    const roleIcons = { owner: '👑 OWNER', admin: '🛡️ ADMIN', curator: '🎵 CURATOR', member: '👤 MEMBER' };

    document.getElementById('status').innerText =
        `Room: ${roomId} (${isPublic ? 'Public' : 'Private'}) | User: ${username} [${roleIcons[myRole]}]`;

    // Curators (2), Admins (3), and Owners (4) can search and add to queue
    const searchInput = document.getElementById('search-input');
    if (ROLE_LEVEL[myRole] >= ROLE_LEVEL.curator) {
        searchInput.disabled = false;
        searchInput.placeholder = "Search YouTube to add to queue...";
    } else {
        searchInput.disabled = true;
        searchInput.value = '';
        document.getElementById('search-results').innerHTML = '';
        searchInput.placeholder = "🔒 Requires Curator, Admin, or Owner rank to add videos";
    }

    // Visually dim seek bar for non-admins
    document.getElementById('seek-bar').disabled = (ROLE_LEVEL[myRole] < ROLE_LEVEL.admin);
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
            'modestbranding': 1,
            'iv_load_policy': 3,
            'fs': 0,
            'cc_load_policy': 0
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
};

function onPlayerReady() {
    setInterval(updateProgressBar, 500);
}

function onPlayerStateChange(event) {
    if (event.data === 1 || event.data === 2) updatePlayPauseUI(event.data);

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
// 2. CUSTOM PLAYER CONTROLS & KEYBOARD SHORTCUTS (WP-108 & WP-109)
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

function togglePlayPause() {
    if (!player || !canControlPlayback()) return;
    const state = player.getPlayerState();
    const currentTime = player.getCurrentTime();
    if (state === 1) {
        player.pauseVideo();
        socket.emit('pause_video', currentTime);
    } else {
        player.playVideo();
        socket.emit('play_video', currentTime);
    }
}

function seekRelative(deltaSeconds) {
    if (!player || !canControlPlayback()) return;
    const duration = player.getDuration() || 0;
    const current = player.getCurrentTime() || 0;
    const targetTime = Math.max(0, Math.min(duration, current + deltaSeconds));
    player.seekTo(targetTime, true);
    socket.emit('play_video', targetTime);
}

function toggleMute() {
    if (!player) return;
    if (player.isMuted()) {
        player.unMute();
        document.getElementById('btn-mute').innerText = '🔊';
        document.getElementById('volume-slider').value = player.getVolume();
    } else {
        player.mute();
        document.getElementById('btn-mute').innerText = '🔇';
        document.getElementById('volume-slider').value = 0;
    }
}

function changeVolume(delta) {
    if (!player) return;
    const currentVol = player.isMuted() ? 0 : player.getVolume();
    const newVol = Math.max(0, Math.min(100, currentVol + delta));
    player.setVolume(newVol);
    document.getElementById('volume-slider').value = newVol;

    if (newVol > 0 && player.isMuted()) {
        player.unMute();
        document.getElementById('btn-mute').innerText = '🔊';
    } else if (newVol === 0) {
        player.mute();
        document.getElementById('btn-mute').innerText = '🔇';
    }
}

function toggleCaptions() {
    if (!player) return;
    captionsEnabled = !captionsEnabled;
    const ccBtn = document.getElementById('btn-captions');

    if (captionsEnabled) {
        player.loadModule('captions');
        player.setOption('captions', 'track', { 'languageCode': 'en' });
        ccBtn.classList.add('cc-active');
    } else {
        player.unloadModule('captions');
        ccBtn.classList.remove('cc-active');
    }
}

document.getElementById('btn-play-pause').addEventListener('click', togglePlayPause);
document.getElementById('player-shield').addEventListener('click', togglePlayPause);
document.getElementById('btn-mute').addEventListener('click', toggleMute);
document.getElementById('btn-captions').addEventListener('click', toggleCaptions);

document.getElementById('btn-skip').addEventListener('click', () => {
    if (!canControlPlayback()) return;
    socket.emit('skip_video');
});

document.getElementById('seek-bar').addEventListener('input', (e) => {
    if (!canControlPlayback()) return;
    const duration = player.getDuration();
    const seekToTime = (e.target.value / 100) * duration;
    player.seekTo(seekToTime, true);
    socket.emit('play_video', seekToTime);
});

document.getElementById('volume-slider').addEventListener('input', (e) => {
    const vol = Number(e.target.value);
    player.setVolume(vol);
    if (vol > 0 && player.isMuted()) {
        player.unMute();
        document.getElementById('btn-mute').innerText = '🔊';
    } else if (vol === 0) {
        document.getElementById('btn-mute').innerText = '🔇';
    }
});

window.addEventListener('keydown', (e) => {
    const loginVisible = document.getElementById('login-overlay').style.display !== 'none';
    const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (loginVisible || isTyping) return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'ArrowRight':
            e.preventDefault();
            seekRelative(5);
            break;
        case 'ArrowLeft':
            e.preventDefault();
            seekRelative(-5);
            break;
        case 'ArrowUp':
            e.preventDefault();
            changeVolume(10);
            break;
        case 'ArrowDown':
            e.preventDefault();
            changeVolume(-10);
            break;
        case 'KeyM':
            e.preventDefault();
            toggleMute();
            break;
        case 'KeyC':
            e.preventDefault();
            toggleCaptions();
            break;
    }
});

// ==========================================
// 3. ROOM, LOBBY, KNOCK & RBAC ROSTER (WP-104, WP-106, WP-109)
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

document.getElementById('btn-create-room').addEventListener('click', () => {
    const creds = getCredentials();
    if (!creds) return;
    const isPublic = document.getElementById('public-checkbox').checked;
    socket.emit('create_room', { ...creds, isPublic });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
    const creds = getCredentials();
    if (!creds) return;
    socket.emit('join_room', creds);
});

socket.on('room_error', (msg) => showLoginAlert(msg, true));
socket.on('waiting_for_host', (msg) => showLoginAlert(msg, false));

socket.on('room_joined', (data) => {
    currentRoomInfo = { roomId: data.roomId, username: data.username, isPublic: data.isPublic };
    myRole = data.role;

    document.getElementById('login-overlay').style.display = 'none';
    applyRolePermissions();

    if (player && typeof player.unMute === 'function') {
        player.unMute();
        document.getElementById('btn-mute').innerText = '🔊';
        document.getElementById('volume-slider').value = 100;
        socket.emit('request_sync');
    }
});

socket.on('role_updated', (newRole) => {
    myRole = newRole;
    applyRolePermissions();
});

socket.on('kicked_from_room', (reason) => {
    alert(reason);
    window.location.reload();
});

// Render Live Member Roster & Admin/Owner Moderation Toolbar
socket.on('update_roster', (users) => {
    document.getElementById('roster-count').textContent = users.length;
    const rosterList = document.getElementById('roster-list');
    rosterList.innerHTML = '';

    // Sort roster by rank (Owner -> Admin -> Curator -> Member)
    users.sort((a, b) => ROLE_LEVEL[b.role] - ROLE_LEVEL[a.role]);

    const myLevel = ROLE_LEVEL[myRole];

    users.forEach(u => {
        const item = document.createElement('div');
        item.className = 'roster-item';

        const header = document.createElement('div');
        header.className = 'roster-header';

        const nameSpan = document.createElement('span');
        const statusTags = [];
        if (u.inCall) statusTags.push(u.callMuted ? '🎙️❌' : '📷');
        if (u.chatRestricted) statusTags.push('🔇');
        nameSpan.textContent = `${u.username} ${u.id === socket.id ? '(You)' : ''} ${statusTags.join(' ')}`;

        const badge = document.createElement('span');
        badge.className = `role-badge role-${u.role}`;
        badge.textContent = u.role;

        header.appendChild(nameSpan);
        header.appendChild(badge);
        item.appendChild(header);

        // Show moderation controls if we are Admin/Owner AND we strictly outrank this user
        const targetLevel = ROLE_LEVEL[u.role];
        if (u.id !== socket.id && myLevel >= ROLE_LEVEL.admin && myLevel > targetLevel) {
            const toolbar = document.createElement('div');
            toolbar.className = 'mod-toolbar';

            // 1. Role Promotion/Demotion Dropdown
            const roleSelect = document.createElement('select');
            roleSelect.className = 'mod-select';
            const allowedRoles = (myRole === 'owner') ? ['member', 'curator', 'admin'] : ['member', 'curator'];

            allowedRoles.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r;
                opt.textContent = `Rank: ${r.toUpperCase()}`;
                if (u.role === r) opt.selected = true;
                roleSelect.appendChild(opt);
            });

            roleSelect.onchange = (e) => {
                socket.emit('moderate_user', { targetId: u.id, action: 'set_role', newRole: e.target.value });
            };
            toolbar.appendChild(roleSelect);

            // 2. Restrict/Unrestrict Chat Button
            const chatBtn = document.createElement('button');
            chatBtn.className = 'mod-btn';
            chatBtn.textContent = u.chatRestricted ? 'Unmute Chat' : 'Mute Chat';
            chatBtn.onclick = () => socket.emit('moderate_user', { targetId: u.id, action: 'toggle_chat' });
            toolbar.appendChild(chatBtn);

            // 3. Call Moderation (Mute Mic & Remove from Call)
            if (u.inCall) {
                const muteCallBtn = document.createElement('button');
                muteCallBtn.className = 'mod-btn';
                muteCallBtn.textContent = u.callMuted ? 'Unmute Mic' : 'Mute Mic';
                muteCallBtn.onclick = () => socket.emit('moderate_user', { targetId: u.id, action: 'toggle_call_mute' });
                toolbar.appendChild(muteCallBtn);

                const endCallBtn = document.createElement('button');
                endCallBtn.className = 'mod-btn danger';
                endCallBtn.textContent = 'End Call';
                endCallBtn.onclick = () => socket.emit('moderate_user', { targetId: u.id, action: 'remove_from_call' });
                toolbar.appendChild(endCallBtn);
            }

            // 4. Kick from Room Button
            const kickBtn = document.createElement('button');
            kickBtn.className = 'mod-btn danger';
            kickBtn.textContent = 'Kick';
            kickBtn.onclick = () => socket.emit('moderate_user', { targetId: u.id, action: 'kick_from_room' });
            toolbar.appendChild(kickBtn);

            item.appendChild(toolbar);
        }

        rosterList.appendChild(item);
    });
});

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
    if (ROLE_LEVEL[myRole] < ROLE_LEVEL.curator) return;
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
// 6. LIVE CHAT & CHAT RESTRICTION (WP-103 & WP-109)
// ==========================================
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');

socket.on('chat_restriction_updated', (restricted) => {
    isChatRestricted = restricted;
    chatInput.disabled = restricted;
    document.getElementById('btn-send-chat').disabled = restricted;
    chatInput.placeholder = restricted ? "🔇 You are restricted from chatting." : "Type a message...";
});

function sendMessage() {
    if (isChatRestricted) return;
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

// ==========================================
// 7. WEBRTC VIDEO CALLS & ADMIN ENFORCEMENT (WP-107 & WP-109)
// ==========================================
let myPeer = null;
let myVideoStream = null;
const activePeers = {};

const btnJoinCall = document.getElementById('btn-join-call');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');
const btnLeaveCall = document.getElementById('btn-leave-call');
const videoGrid = document.getElementById('video-grid');

function stopLocalCall() {
    if (myVideoStream) {
        myVideoStream.getTracks().forEach(track => track.stop());
        myVideoStream = null;
    }
    if (myPeer) {
        myPeer.destroy();
        myPeer = null;
    }
    Object.values(activePeers).forEach(call => call.close());
    videoGrid.innerHTML = '';

    btnJoinCall.style.display = 'inline-block';
    btnToggleMic.style.display = 'none';
    btnToggleCam.style.display = 'none';
    btnLeaveCall.style.display = 'none';
}

btnJoinCall.addEventListener('click', async () => {
    try {
        myVideoStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        addVideoTile('local', myVideoStream, 'You', true);

        btnJoinCall.style.display = 'none';
        btnToggleMic.style.display = 'inline-block';
        btnToggleCam.style.display = 'inline-block';
        btnLeaveCall.style.display = 'inline-block';

        myPeer = new Peer();

        myPeer.on('open', (peerId) => {
            socket.emit('join_video_call', peerId);
        });

        myPeer.on('call', (call) => {
            call.answer(myVideoStream);
            const callerName = call.metadata?.username || 'Peer';
            
            call.on('stream', (userVideoStream) => {
                addVideoTile(call.peer, userVideoStream, callerName, false);
            });
            call.on('close', () => removeVideoTile(call.peer));
            activePeers[call.peer] = call;
        });

    } catch (err) {
        alert("Could not access camera/microphone. Please check browser permissions.");
        console.error(err);
    }
});

socket.on('user_joined_video', ({ peerId, username }) => {
    if (!myVideoStream || !myPeer) return;

    const myName = currentRoomInfo.username || 'Peer';
    const call = myPeer.call(peerId, myVideoStream, {
        metadata: { username: myName }
    });

    call.on('stream', (userVideoStream) => {
        addVideoTile(peerId, userVideoStream, username, false);
    });
    call.on('close', () => removeVideoTile(peerId));
    activePeers[peerId] = call;
});

socket.on('user_left_video', (peerId) => {
    if (activePeers[peerId]) {
        activePeers[peerId].close();
        delete activePeers[peerId];
    }
    removeVideoTile(peerId);
});

// Admin/Owner Forced Call Mute
socket.on('force_mute_status', (mutedByAdmin) => {
    isServerCallMuted = mutedByAdmin;
    if (!myVideoStream) return;
    const audioTrack = myVideoStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !mutedByAdmin;
        btnToggleMic.disabled = mutedByAdmin;
        btnToggleMic.textContent = mutedByAdmin ? '🎙️❌ Server Muted' : '🎤 Mute Mic';
    }
});

// Admin/Owner Forced Call Removal
socket.on('force_leave_call', () => {
    stopLocalCall();
    alert("📷❌ An Admin removed you from the video call.");
});

function addVideoTile(id, stream, labelText, isMuted) {
    if (document.getElementById(`tile-${id}`)) return;

    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${id}`;

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = isMuted;
    video.addEventListener('loadedmetadata', () => video.play());

    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = labelText;

    tile.appendChild(video);
    tile.appendChild(label);
    videoGrid.appendChild(tile);
}

function removeVideoTile(id) {
    const tile = document.getElementById(`tile-${id}`);
    if (tile) tile.remove();
}

btnToggleMic.addEventListener('click', () => {
    if (!myVideoStream || isServerCallMuted) return;
    const audioTrack = myVideoStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        btnToggleMic.textContent = audioTrack.enabled ? '🎤 Mute Mic' : '🔇 Unmute Mic';
    }
});

btnToggleCam.addEventListener('click', () => {
    if (!myVideoStream) return;
    const videoTrack = myVideoStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        btnToggleCam.textContent = videoTrack.enabled ? '📷 Hide Cam' : '🚫 Show Cam';
    }
});

btnLeaveCall.addEventListener('click', () => {
    stopLocalCall();
    socket.emit('leave_video_call');
});