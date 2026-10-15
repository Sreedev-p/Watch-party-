const socket = io();

// Global State
let myUser = { userId: null, username: '' };
let allServerParties = [];
let myFriends = [];
let sidebarFilter = 'my'; // 'my' | 'global'

// Active Party State
const ROLE_LEVEL = { member: 1, curator: 2, admin: 3, owner: 4 };
let currentParty = null;
let myRole = 'member';
let activeMediaSource = 'youtube'; // 'youtube' | 'url' | 'local'
let isChatRestricted = false;
let isServerCallMuted = false;
let captionsEnabled = false;

// Players & Sync
let player;
const html5Player = document.getElementById('html5-player');
let isSyncing = false;
let syncFailsafe;
let debounceTimer;

// WebRTC State
let myPeer = null;
let myVideoStream = null;
let localFilePeer = null;
const activePeers = {};

function blockEcho() {
    isSyncing = true;
    clearTimeout(syncFailsafe);
    syncFailsafe = setTimeout(() => { isSyncing = false; }, 1000);
}

function canControlPlayback() {
    if (ROLE_LEVEL[myRole] < ROLE_LEVEL.admin) {
        alert("🛡️ Only Admins and the Party Owner can control playback.");
        return false;
    }
    return true;
}

// ==========================================
// 1. AUTHENTICATION & VIEW ROUTING
// ==========================================
const savedToken = sessionStorage.getItem('wp_token');
if (savedToken) socket.emit('authenticate', savedToken);

async function handleAuth(mode) {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const alertBox = document.getElementById('auth-alert');
    if (!username || !password) {
        alertBox.style.display = 'block';
        alertBox.textContent = 'Please enter both username and password.';
        return;
    }

    try {
        const res = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, mode })
        });
        const data = await res.json();
        if (!res.ok) {
            alertBox.style.display = 'block';
            alertBox.textContent = data.error || 'Authentication failed';
            return;
        }
        sessionStorage.setItem('wp_token', data.token);
        socket.emit('authenticate', data.token);
    } catch (e) {
        alertBox.style.display = 'block';
        alertBox.textContent = 'Server connection error.';
    }
}

document.getElementById('btn-login').onclick = () => handleAuth('login');
document.getElementById('btn-register').onclick = () => handleAuth('register');
document.getElementById('btn-logout').onclick = () => {
    sessionStorage.removeItem('wp_token');
    window.location.reload();
};

socket.on('auth_success', ({ userId, username, parties, friends }) => {
    myUser = { userId, username };
    allServerParties = parties || [];
    myFriends = friends || [];

    document.getElementById('nav-username').textContent = username;
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('top-navbar').style.display = 'flex';
    showDashboardView();
});

socket.on('auth_error', (msg) => {
    sessionStorage.removeItem('wp_token');
    document.getElementById('auth-view').style.display = 'flex';
    const alertBox = document.getElementById('auth-alert');
    alertBox.style.display = 'block';
    alertBox.textContent = msg;
});

function showDashboardView() {
    document.getElementById('party-view').style.display = 'none';
    document.getElementById('dashboard-view').style.display = 'grid';
    renderDashboard();
}

// Navbar Tabs
document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;

        if (currentParty && tab !== 'profile') {
            socket.emit('leave_party');
            stopLocalCall();
            currentParty = null;
        }

        if (tab === 'home') {
            showDashboardView();
            document.getElementById('section-created-by-me').style.display = 'block';
            document.getElementById('section-all-parties').style.display = 'block';
            document.getElementById('section-friends').style.display = 'none';
        } else if (tab === 'my-parties') {
            showDashboardView();
            document.getElementById('section-created-by-me').style.display = 'block';
            document.getElementById('section-all-parties').style.display = 'none';
            document.getElementById('section-friends').style.display = 'none';
        } else if (tab === 'friends') {
            showDashboardView();
            document.getElementById('section-created-by-me').style.display = 'none';
            document.getElementById('section-all-parties').style.display = 'none';
            document.getElementById('section-friends').style.display = 'block';
            renderFriendsSection();
        } else if (tab === 'profile') {
            openProfileModal(myUser.userId);
        }
    };
});

document.getElementById('nav-logo').onclick = () => {
    document.querySelector('[data-tab="home"]').click();
};

// ==========================================
// 2. DASHBOARD RENDERING, SEARCH & PROFILES
// ==========================================
socket.on('dashboard_data', (parties) => {
    allServerParties = parties || [];
    renderDashboard();
});

socket.on('friends_updated', (friends) => {
    myFriends = friends || [];
    renderFriendsSection();
    renderPartyFriendInviter();
});

document.getElementById('toggle-my-parties').onclick = () => {
    sidebarFilter = 'my';
    document.getElementById('toggle-my-parties').classList.add('active');
    document.getElementById('toggle-global-parties').classList.remove('active');
    renderSidebarList();
};

document.getElementById('toggle-global-parties').onclick = () => {
    sidebarFilter = 'global';
    document.getElementById('toggle-global-parties').classList.add('active');
    document.getElementById('toggle-my-parties').classList.remove('active');
    renderSidebarList();
};

function createPartyCardElement(p, compact = false) {
    const card = document.createElement('div');
    card.className = 'party-card';

    const topRow = document.createElement('div');
    topRow.className = 'row-between';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'row-gap';

    const dot = document.createElement('span');
    dot.className = `status-dot ${p.isActive ? 'active' : 'idle'}`;
    dot.title = p.isActive ? `${p.activeCount} watching live` : 'Party idle (saved)';

    const nameStrong = document.createElement('strong');
    nameStrong.textContent = p.partyName;

    titleWrap.appendChild(dot);
    titleWrap.appendChild(nameStrong);

    const badge = document.createElement('span');
    badge.className = 'meta-subtext';
    badge.textContent = p.isPublic ? '🌐 Public' : '🔒 Private';

    topRow.appendChild(titleWrap);
    topRow.appendChild(badge);
    card.appendChild(topRow);

    const meta = document.createElement('div');
    meta.className = 'meta-subtext';
    meta.textContent = `ID: ${p.partyId} • ${p.activeCount} active ${p.myRole ? `• Rank: ${p.myRole.toUpperCase()}` : ''}`;
    card.appendChild(meta);

    if (!compact) {
        const bottomRow = document.createElement('div');
        bottomRow.className = 'row-between';
        bottomRow.style.marginTop = '4px';

        const playingSpan = document.createElement('span');
        playingSpan.className = 'meta-subtext';
        playingSpan.textContent = `🎬 ${p.videoTitle || 'Ready'}`;
        bottomRow.appendChild(playingSpan);

        if (Number(p.ownerUserId) === Number(myUser.userId)) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-danger-sm';
            delBtn.textContent = 'Delete';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                socket.emit('delete_party', { partyId: p.partyId });
            };
            bottomRow.appendChild(delBtn);
        }
        card.appendChild(bottomRow);
    }

    card.onclick = () => socket.emit('join_party', { partyId: p.partyId });
    return card;
}

function renderSidebarList() {
    const container = document.getElementById('sidebar-party-list');
    container.innerHTML = '';

    const list = (sidebarFilter === 'my')
        ? allServerParties.filter(p => p.myRole !== null)
        : allServerParties;

    if (list.length === 0) {
        container.innerHTML = `<div class="meta-subtext" style="padding:10px;">No parties found.</div>`;
        return;
    }
    list.forEach(p => container.appendChild(createPartyCardElement(p, true)));
}

function renderDashboard() {
    renderSidebarList();

    // Created by Me
    const myCreatedGrid = document.getElementById('my-created-parties-grid');
    myCreatedGrid.innerHTML = '';
    const myCreated = allServerParties.filter(p => Number(p.ownerUserId) === Number(myUser.userId));
    if (myCreated.length === 0) {
        myCreatedGrid.innerHTML = `<div class="meta-subtext">You haven't created any parties yet.</div>`;
    } else {
        myCreated.forEach(p => myCreatedGrid.appendChild(createPartyCardElement(p)));
    }

    // All Server Parties
    const allGrid = document.getElementById('all-server-parties-grid');
    allGrid.innerHTML = '';
    if (allServerParties.length === 0) {
        allGrid.innerHTML = `<div class="meta-subtext">No parties on the server yet. Create the first one!</div>`;
    } else {
        allServerParties.forEach(p => allGrid.appendChild(createPartyCardElement(p)));
    }
}

function renderFriendsSection() {
    const grid = document.getElementById('friends-grid');
    grid.innerHTML = '';
    if (myFriends.length === 0) {
        grid.innerHTML = `<div class="meta-subtext">Use the top search bar to find users and add them as friends!</div>`;
        return;
    }

    myFriends.forEach(f => {
        const card = document.createElement('div');
        card.className = 'party-card';
        const row = document.createElement('div');
        row.className = 'row-between';

        const name = document.createElement('strong');
        name.textContent = `👤 ${f.username}`;

        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn-secondary btn-sm';
        viewBtn.textContent = 'View Profile';
        viewBtn.onclick = (e) => {
            e.stopPropagation();
            openProfileModal(f.id);
        };

        row.appendChild(name);
        row.appendChild(viewBtn);
        card.appendChild(row);
        grid.appendChild(card);
    });
}

// Universal Search Bar (Parties + Users)
const globalSearchInput = document.getElementById('global-search-input');
const globalSearchDropdown = document.getElementById('global-search-dropdown');

globalSearchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    if (!q) {
        globalSearchDropdown.style.display = 'none';
        return;
    }

    fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(({ parties, users }) => {
            globalSearchDropdown.innerHTML = '';
            globalSearchDropdown.style.display = 'block';

            if (parties.length === 0 && users.length === 0) {
                globalSearchDropdown.innerHTML = `<div class="meta-subtext">No matching parties or users.</div>`;
                return;
            }

            if (parties.length > 0) {
                const h = document.createElement('div');
                h.className = 'meta-subtext';
                h.style.marginBottom = '6px';
                h.textContent = '🎬 PARTIES';
                globalSearchDropdown.appendChild(h);

                parties.forEach(p => {
                    const row = document.createElement('div');
                    row.className = 'result-item';
                    row.innerHTML = `<span class="status-dot ${p.isActive ? 'active' : 'idle'}"></span>
                                     <div style="flex:1;"><b>${p.partyName}</b> <span class="meta-subtext">(${p.partyId})</span></div>`;
                    row.onclick = () => {
                        globalSearchDropdown.style.display = 'none';
                        socket.emit('join_party', { partyId: p.partyId });
                    };
                    globalSearchDropdown.appendChild(row);
                });
            }

            if (users.length > 0) {
                const h = document.createElement('div');
                h.className = 'meta-subtext';
                h.style.margin = '8px 0 6px 0';
                h.textContent = '👥 USERS';
                globalSearchDropdown.appendChild(h);

                users.forEach(u => {
                    const row = document.createElement('div');
                    row.className = 'result-item';
                    const nameSpan = document.createElement('span');
                    nameSpan.style.flex = '1';
                    nameSpan.textContent = `👤 ${u.username}`;

                    const profBtn = document.createElement('button');
                    profBtn.className = 'btn-secondary btn-sm';
                    profBtn.textContent = 'Profile';
                    profBtn.onclick = () => {
                        globalSearchDropdown.style.display = 'none';
                        openProfileModal(u.id);
                    };

                    row.appendChild(nameSpan);
                    row.appendChild(profBtn);
                    globalSearchDropdown.appendChild(row);
                });
            }
        });
});

// Profile Inspection Modal
async function openProfileModal(targetUserId) {
    const res = await fetch(`/api/profile/${targetUserId}`);
    if (!res.ok) return;
    const { user, friends, parties } = await res.json();

    document.getElementById('profile-modal-title').textContent = `👤 ${user.username}'s Profile`;
    const actionsDiv = document.getElementById('profile-modal-actions');
    actionsDiv.innerHTML = '';

    if (Number(user.id) !== Number(myUser.userId)) {
        const isAlreadyFriend = myFriends.some(f => Number(f.id) === Number(user.id));
        const friendBtn = document.createElement('button');
        friendBtn.className = isAlreadyFriend ? 'btn-danger-sm' : 'btn-accent btn-sm';
        friendBtn.textContent = isAlreadyFriend ? '✕ Remove Friend' : '+ Add Friend';
        friendBtn.onclick = () => {
            socket.emit(isAlreadyFriend ? 'remove_friend' : 'add_friend', user.id);
            setTimeout(() => openProfileModal(user.id), 200);
        };
        actionsDiv.appendChild(friendBtn);
    }

    const fContainer = document.getElementById('profile-modal-friends');
    fContainer.innerHTML = '';
    if (friends.length === 0) fContainer.innerHTML = `<div class="meta-subtext">No friends added yet.</div>`;
    friends.forEach(f => {
        const d = document.createElement('div');
        d.className = 'result-item';
        d.innerHTML = `<span class="status-dot ${f.isOnline ? 'active' : 'idle'}"></span> <b>${f.username}</b>`;
        d.onclick = () => openProfileModal(f.id);
        fContainer.appendChild(d);
    });

    const pContainer = document.getElementById('profile-modal-parties');
    pContainer.innerHTML = '';
    if (parties.length === 0) pContainer.innerHTML = `<div class="meta-subtext">Not a member of any parties yet.</div>`;
    parties.forEach(p => {
        const d = document.createElement('div');
        d.className = 'result-item';
        d.innerHTML = `<span class="status-dot ${p.isActive ? 'active' : 'idle'}"></span>
                       <div style="flex:1;"><b>${p.partyName}</b> <span class="meta-subtext">[${p.role.toUpperCase()}]</span></div>`;
        d.onclick = () => {
            document.getElementById('profile-modal').style.display = 'none';
            socket.emit('join_party', { partyId: p.partyId });
        };
        pContainer.appendChild(d);
    });

    document.getElementById('profile-modal').style.display = 'flex';
}

document.getElementById('btn-close-profile-modal').onclick = () => {
    document.getElementById('profile-modal').style.display = 'none';
};

// ==========================================
// 3. CREATE PARTY, QUICK PARTY & FRIEND INVITES
// ==========================================
document.getElementById('btn-open-create-modal').onclick = () => {
    const fList = document.getElementById('create-modal-friends-list');
    fList.innerHTML = '';
    if (myFriends.length === 0) {
        fList.innerHTML = `<div class="meta-subtext">No friends to invite yet (you can skip this).</div>`;
    } else {
        myFriends.forEach(f => {
            const lbl = document.createElement('label');
            lbl.className = 'row-gap';
            lbl.style.fontSize = '13px';
            lbl.innerHTML = `<input type="checkbox" class="friend-invite-check" value="${f.id}"> <span>${f.username}</span>`;
            fList.appendChild(lbl);
        });
    }
    document.getElementById('create-party-modal').style.display = 'flex';
};

document.getElementById('btn-cancel-create-modal').onclick = () => {
    document.getElementById('create-party-modal').style.display = 'none';
};

document.getElementById('btn-confirm-create-party').onclick = () => {
    const partyName = document.getElementById('new-party-name').value.trim();
    if (!partyName) return alert("Please give your party a name!");
    const isPublic = document.getElementById('new-party-public').checked;
    const invitedFriendIds = Array.from(document.querySelectorAll('.friend-invite-check:checked')).map(cb => Number(cb.value));

    document.getElementById('create-party-modal').style.display = 'none';
    document.getElementById('new-party-name').value = '';
    socket.emit('create_party', { partyName, isPublic, isQuick: false, invitedFriendIds });
};

document.getElementById('btn-quick-party').onclick = () => {
    socket.emit('create_party', { partyName: '', isPublic: false, isQuick: true, invitedFriendIds: [] });
};

document.getElementById('btn-direct-join').onclick = () => {
    const id = document.getElementById('direct-join-id').value.trim();
    if (id) socket.emit('join_party', { partyId: id });
};

// Live Toast Invitations
socket.on('party_invite', ({ partyId, partyName, fromUsername }) => {
    const container = document.getElementById('invite-toast-container');
    const toast = document.createElement('div');
    toast.className = 'invite-toast';
    toast.innerHTML = `<div><b>🎉 Party Invite!</b><div class="meta-subtext">${fromUsername} invited you to <b>${partyName}</b></div></div>`;

    const joinBtn = document.createElement('button');
    joinBtn.className = 'btn-accent btn-sm';
    joinBtn.textContent = 'Join Now';
    joinBtn.onclick = () => {
        toast.remove();
        socket.emit('join_party', { partyId });
    };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-secondary btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => toast.remove();

    toast.appendChild(joinBtn);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
});

// ==========================================
// 4. ACTIVE PARTY ROOM & PERSISTENT STATE
// ==========================================
socket.on('party_error', (msg) => {
    const notice = document.getElementById('dashboard-notice');
    notice.style.display = 'block';
    notice.textContent = msg;
    setTimeout(() => { notice.style.display = 'none'; }, 5000);
});

socket.on('party_notice', (msg) => {
    const notice = document.getElementById('dashboard-notice');
    notice.style.display = 'block';
    notice.style.background = '#1e3a8a';
    notice.style.borderColor = '#3b82f6';
    notice.textContent = msg;
});

socket.on('party_joined', (data) => {
    currentParty = data;
    myRole = data.role;

    document.getElementById('dashboard-view').style.display = 'none';
    document.getElementById('party-view').style.display = 'flex';

    document.getElementById('active-party-title').textContent = data.partyName;
    applyRolePermissions();

    // Load Persistent Queue & Chat History
    renderQueue(data.queue || []);
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.innerHTML = '';
    (data.chatHistory || []).forEach(msg => appendChatMessage(msg));

    // Load Media Source & Resume from Last Stopped Timestamp!
    loadMediaIntoPlayer(data.videoSource, data.videoId, data.videoTitle, data.time, data.state);
    renderPartyFriendInviter();
});

document.getElementById('btn-back-dashboard').onclick = () => {
    socket.emit('leave_party');
    stopLocalCall();
    currentParty = null;
    if (player && player.pauseVideo) player.pauseVideo();
    html5Player.pause();
    showDashboardView();
};

document.getElementById('btn-copy-party-id').onclick = () => {
    if (!currentParty) return;
    navigator.clipboard.writeText(currentParty.partyId);
    alert(`Copied Party ID: ${currentParty.partyId} — Share this with friends!`);
};

document.getElementById('btn-delete-active-party').onclick = () => {
    if (!currentParty) return;
    if (confirm(`Delete party "${currentParty.partyName}" permanently?`)) {
        socket.emit('delete_party', { partyId: currentParty.partyId });
    }
};

function applyRolePermissions() {
    if (!currentParty) return;
    const roleBadges = { owner: '👑 OWNER', admin: '🛡️ ADMIN', curator: '🎵 CURATOR', member: '👤 MEMBER' };
    document.getElementById('active-party-meta').textContent =
        `ID: ${currentParty.partyId} • ${currentParty.isPublic ? 'Public' : 'Private'} • Your Rank: ${roleBadges[myRole]}`;

    const isOwner = Number(currentParty.ownerUserId) === Number(myUser.userId);
    document.getElementById('btn-delete-active-party').style.display = isOwner ? 'inline-block' : 'none';

    const canCurate = ROLE_LEVEL[myRole] >= ROLE_LEVEL.curator;
    document.getElementById('media-search-input').disabled = !canCurate;
    document.getElementById('seek-bar').disabled = (ROLE_LEVEL[myRole] < ROLE_LEVEL.admin);
    document.getElementById('live-invite-section').style.display = (ROLE_LEVEL[myRole] >= ROLE_LEVEL.admin) ? 'block' : 'none';
}

function renderPartyFriendInviter() {
    const list = document.getElementById('party-invite-friends-list');
    if (!list) return;
    list.innerHTML = '';
    if (myFriends.length === 0) {
        list.innerHTML = `<div class="meta-subtext">Add friends from the dashboard to invite them here.</div>`;
        return;
    }
    myFriends.forEach(f => {
        const row = document.createElement('div');
        row.className = 'row-between';
        row.style.fontSize = '12px';
        row.innerHTML = `<span>👤 ${f.username}</span>`;
        const btn = document.createElement('button');
        btn.className = 'mod-btn';
        btn.textContent = 'Invite';
        btn.onclick = () => {
            socket.emit('invite_friend_to_party', { friendUserId: f.id });
            btn.textContent = 'Invited ✓';
        };
        row.appendChild(btn);
        list.appendChild(row);
    });
}

socket.on('role_updated', (newRole) => {
    myRole = newRole;
    applyRolePermissions();
});

socket.on('kicked_from_party', (reason) => {
    alert(reason);
    stopLocalCall();
    currentParty = null;
    showDashboardView();
    socket.emit('request_dashboard');
});

// Knock Requests
socket.on('knock_request', ({ requesterId, username }) => {
    const container = document.getElementById('knock-container');
    const banner = document.createElement('div');
    banner.className = 'glass-panel party-header-bar';
    banner.style.borderLeft = '4px solid #e50914';
    banner.innerHTML = `<span>🔒 <b>${username}</b> is requesting to join this private party.</span>`;

    const btns = document.createElement('div');
    btns.className = 'row-gap';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn-accent btn-sm';
    acceptBtn.textContent = 'Approve';
    acceptBtn.onclick = () => {
        socket.emit('resolve_knock', { requesterId, approved: true });
        banner.remove();
    };

    const denyBtn = document.createElement('button');
    denyBtn.className = 'btn-secondary btn-sm';
    denyBtn.textContent = 'Decline';
    denyBtn.onclick = () => {
        socket.emit('resolve_knock', { requesterId, approved: false });
        banner.remove();
    };

    btns.appendChild(acceptBtn);
    btns.appendChild(denyBtn);
    banner.appendChild(btns);
    container.appendChild(banner);
});

// ==========================================
// 5. MULTI-SOURCE PLAYER (YouTube + HTML5 URL + Local File P2P)
// ==========================================
window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('player', {
        height: '360',
        width: '640',
        videoId: '8hP9D6kZseM',
        playerVars: {
            'controls': 0, 'disablekb': 1, 'rel': 0, 'modestbranding': 1, 'iv_load_policy': 3, 'fs': 0
        },
        events: {
            'onReady': () => setInterval(updateProgressBar, 500),
            'onStateChange': (e) => {
                if (e.data === 1 || e.data === 2) updatePlayPauseUI(e.data === 1);
                if (e.data === 0) socket.emit('video_ended');
            }
        }
    });
};

function loadMediaIntoPlayer(source, videoId, title, startTime = 0, playState = 'paused', streamPeerId = null) {
    activeMediaSource = source || 'youtube';
    document.getElementById('now-playing-label').textContent = `Now Playing: ${title || videoId}`;
    const ytDiv = document.getElementById('player');

    if (activeMediaSource === 'youtube') {
        html5Player.pause();
        html5Player.style.display = 'none';
        ytDiv.style.display = 'block';

        if (player && player.loadVideoById) {
            blockEcho();
            player.loadVideoById(videoId, startTime);
            player.unMute();
            if (playState === 'playing') player.playVideo();
            else setTimeout(() => player.pauseVideo(), 400);
        }
    } else if (activeMediaSource === 'url') {
        if (player && player.pauseVideo) player.pauseVideo();
        ytDiv.style.display = 'none';
        html5Player.style.display = 'block';
        html5Player.srcObject = null;
        html5Player.src = videoId;
        html5Player.currentTime = startTime || 0;
        if (playState === 'playing') html5Player.play().catch(() => {});
        else html5Player.pause();
    } else if (activeMediaSource === 'local' && streamPeerId) {
        // Receive WebRTC Local File Stream from Host
        if (player && player.pauseVideo) player.pauseVideo();
        ytDiv.style.display = 'none';
        html5Player.style.display = 'block';

        const viewerPeer = new Peer();
        viewerPeer.on('open', () => {
            const conn = viewerPeer.call(streamPeerId, createDummyMediaStream());
            conn.on('stream', (remoteFileStream) => {
                html5Player.srcObject = remoteFileStream;
                html5Player.play().catch(() => {});
            });
        });
    }
}

function createDummyMediaStream() {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    return dest.stream;
}

socket.on('load_new_media', (data) => {
    loadMediaIntoPlayer(data.videoSource, data.videoId, data.videoTitle, 0, 'playing', data.streamPeerId);
});

// Unified Player Controls
function getActiveCurrentTime() {
    if (activeMediaSource === 'youtube') return (player && player.getCurrentTime) ? player.getCurrentTime() : 0;
    return html5Player.currentTime || 0;
}

function getActiveDuration() {
    if (activeMediaSource === 'youtube') return (player && player.getDuration) ? player.getDuration() : 0;
    return html5Player.duration || 0;
}

function formatTime(s) {
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function updatePlayPauseUI(isPlaying) {
    document.getElementById('btn-play-pause').innerText = isPlaying ? '⏸' : '▶';
}

function updateProgressBar() {
    const cur = getActiveCurrentTime();
    const dur = getActiveDuration();
    if (dur > 0) {
        document.getElementById('seek-bar').value = (cur / dur) * 100;
        document.getElementById('time-display').innerText = `${formatTime(cur)} / ${formatTime(dur)}`;
    }
}

function togglePlayPause() {
    if (!canControlPlayback()) return;
    const cur = getActiveCurrentTime();

    if (activeMediaSource === 'youtube') {
        const st = player.getPlayerState();
        if (st === 1) { player.pauseVideo(); socket.emit('pause_video', cur); }
        else { player.playVideo(); socket.emit('play_video', cur); }
    } else {
        if (!html5Player.paused) { html5Player.pause(); updatePlayPauseUI(false); socket.emit('pause_video', cur); }
        else { html5Player.play(); updatePlayPauseUI(true); socket.emit('play_video', cur); }
    }
}

function seekRelative(delta) {
    if (!canControlPlayback()) return;
    const target = Math.max(0, Math.min(getActiveDuration(), getActiveCurrentTime() + delta));
    if (activeMediaSource === 'youtube') player.seekTo(target, true);
    else html5Player.currentTime = target;
    socket.emit('play_video', target);
}

function toggleMute() {
    if (activeMediaSource === 'youtube') {
        if (player.isMuted()) { player.unMute(); document.getElementById('btn-mute').innerText = '🔊'; }
        else { player.mute(); document.getElementById('btn-mute').innerText = '🔇'; }
    } else {
        html5Player.muted = !html5Player.muted;
        document.getElementById('btn-mute').innerText = html5Player.muted ? '🔇' : '🔊';
    }
}

function changeVolume(delta) {
    const slider = document.getElementById('volume-slider');
    const nextVol = Math.max(0, Math.min(100, Number(slider.value) + delta));
    slider.value = nextVol;
    if (activeMediaSource === 'youtube' && player) player.setVolume(nextVol);
    html5Player.volume = nextVol / 100;
}

function toggleCaptions() {
    if (activeMediaSource !== 'youtube' || !player) return;
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

document.getElementById('btn-play-pause').onclick = togglePlayPause;
document.getElementById('player-shield').onclick = togglePlayPause;
document.getElementById('btn-mute').onclick = toggleMute;
document.getElementById('btn-captions').onclick = toggleCaptions;
document.getElementById('btn-skip').onclick = () => { if (canControlPlayback()) socket.emit('skip_video'); };

document.getElementById('seek-bar').oninput = (e) => {
    if (!canControlPlayback()) return;
    const target = (e.target.value / 100) * getActiveDuration();
    if (activeMediaSource === 'youtube') player.seekTo(target, true);
    else html5Player.currentTime = target;
    socket.emit('play_video', target);
};

document.getElementById('volume-slider').oninput = (e) => changeVolume(0);

socket.on('sync_play', (time) => {
    blockEcho();
    if (activeMediaSource === 'youtube') {
        if (Math.abs(player.getCurrentTime() - time) > 1.5) player.seekTo(time, true);
        player.playVideo();
    } else {
        if (Math.abs(html5Player.currentTime - time) > 1.5) html5Player.currentTime = time;
        html5Player.play().catch(() => {});
        updatePlayPauseUI(true);
    }
});

socket.on('sync_pause', (time) => {
    blockEcho();
    if (activeMediaSource === 'youtube') {
        player.seekTo(time, true);
        player.pauseVideo();
    } else {
        html5Player.currentTime = time;
        html5Player.pause();
        updatePlayPauseUI(false);
    }
});

window.addEventListener('keydown', (e) => {
    if (!currentParty) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

    switch (e.code) {
        case 'Space': e.preventDefault(); togglePlayPause(); break;
        case 'ArrowRight': e.preventDefault(); seekRelative(5); break;
        case 'ArrowLeft': e.preventDefault(); seekRelative(-5); break;
        case 'ArrowUp': e.preventDefault(); changeVolume(10); break;
        case 'ArrowDown': e.preventDefault(); changeVolume(-10); break;
        case 'KeyM': e.preventDefault(); toggleMute(); break;
        case 'KeyC': e.preventDefault(); toggleCaptions(); break;
    }
});

// ==========================================
// 6. MEDIA SOURCE SWITCHER (YT / TMDB / URL / LOCAL FILE)
// ==========================================
const mediaSourceSelect = document.getElementById('media-source-select');
const mediaSearchInput = document.getElementById('media-search-input');
const btnLoadUrl = document.getElementById('btn-load-url');
const localFileInput = document.getElementById('local-file-input');

mediaSourceSelect.onchange = () => {
    const mode = mediaSourceSelect.value;
    document.getElementById('search-results').innerHTML = '';

    if (mode === 'youtube' || mode === 'tmdb') {
        mediaSearchInput.style.display = 'block';
        btnLoadUrl.style.display = 'none';
        localFileInput.style.display = 'none';
        mediaSearchInput.placeholder = mode === 'tmdb' ? '🎬 Search Movies via TMDB...' : '▶ Search YouTube videos...';
    } else if (mode === 'url') {
        mediaSearchInput.style.display = 'block';
        btnLoadUrl.style.display = 'inline-block';
        localFileInput.style.display = 'none';
        mediaSearchInput.placeholder = '🔗 Paste direct video link (.mp4, .webm, or stream URL)...';
    } else if (mode === 'local') {
        mediaSearchInput.style.display = 'none';
        btnLoadUrl.style.display = 'none';
        localFileInput.style.display = 'block';
    }
};

mediaSearchInput.oninput = (e) => {
    const mode = mediaSourceSelect.value;
    if (mode !== 'youtube' && mode !== 'tmdb') return;
    const query = e.target.value.trim();
    clearTimeout(debounceTimer);
    if (query.length > 0) {
        debounceTimer = setTimeout(() => {
            socket.emit('search_media', { query, source: mode });
        }, 450);
    } else {
        document.getElementById('search-results').innerHTML = '';
    }
};

btnLoadUrl.onclick = () => {
    const url = mediaSearchInput.value.trim();
    if (!url) return;
    socket.emit('change_media_source', {
        videoSource: 'url',
        videoId: url,
        videoTitle: 'Direct Web Video Stream'
    });
    mediaSearchInput.value = '';
};

localFileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileUrl = URL.createObjectURL(file);
    if (player && player.pauseVideo) player.pauseVideo();
    document.getElementById('player').style.display = 'none';
    html5Player.style.display = 'block';
    html5Player.srcObject = null;
    html5Player.src = fileUrl;
    html5Player.play();

    // Stream Local File to Party via WebRTC
    if (localFilePeer) localFilePeer.destroy();
    localFilePeer = new Peer();
    localFilePeer.on('open', (streamPeerId) => {
        socket.emit('change_media_source', {
            videoSource: 'local',
            videoId: file.name,
            videoTitle: `💻 Local File: ${file.name}`,
            streamPeerId
        });
    });

    localFilePeer.on('call', (call) => {
        const stream = html5Player.captureStream ? html5Player.captureStream() : html5Player.mozCaptureStream();
        call.answer(stream);
    });
};

socket.on('search_results', (items) => {
    const container = document.getElementById('search-results');
    container.innerHTML = '';
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'result-item';
        div.innerHTML = `<img src="${item.thumb}" class="result-thumb">`;

        const titleDiv = document.createElement('div');
        titleDiv.className = 'result-title';
        titleDiv.textContent = item.title;

        const playNowBtn = document.createElement('button');
        playNowBtn.className = 'btn-accent btn-sm';
        playNowBtn.textContent = '▶ Play Now';
        playNowBtn.onclick = (e) => {
            e.stopPropagation();
            socket.emit('change_media_source', {
                videoSource: 'youtube',
                videoId: item.videoId,
                videoTitle: item.title
            });
            container.innerHTML = '';
            mediaSearchInput.value = '';
        };

        const qBtn = document.createElement('button');
        qBtn.className = 'btn-secondary btn-sm';
        qBtn.textContent = '+ Queue';
        qBtn.onclick = (e) => {
            e.stopPropagation();
            socket.emit('add_to_queue', {
                videoSource: 'youtube',
                videoId: item.videoId,
                title: item.title
            });
            container.innerHTML = '';
            mediaSearchInput.value = '';
        };

        div.appendChild(titleDiv);
        div.appendChild(playNowBtn);
        div.appendChild(qBtn);
        container.appendChild(div);
    });
});

function renderQueue(queue) {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    if (!queue || queue.length === 0) {
        list.textContent = 'Queue is empty.';
    } else {
        queue.forEach((v, idx) => {
            const d = document.createElement('div');
            d.textContent = `${idx + 1}. ${v.title}`;
            list.appendChild(d);
        });
    }
}

socket.on('update_queue', renderQueue);

// ==========================================
// 7. PERSISTENT CHAT & RBAC ROSTER
// ==========================================
const chatInput = document.getElementById('chat-input');

function appendChatMessage(data) {
    const chatMessages = document.getElementById('chat-messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg';

    const senderSpan = document.createElement('span');
    senderSpan.className = 'chat-sender';
    senderSpan.textContent = `${data.sender}:`;

    const textSpan = document.createElement('span');
    textSpan.textContent = ` ${data.text}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = data.timestamp || '';

    msgDiv.appendChild(senderSpan);
    msgDiv.appendChild(textSpan);
    msgDiv.appendChild(timeSpan);
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
    if (isChatRestricted) return;
    const text = chatInput.value.trim();
    if (text) {
        socket.emit('chat_message', text);
        chatInput.value = '';
    }
}

document.getElementById('btn-send-chat').onclick = sendMessage;
chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };
socket.on('chat_message', appendChatMessage);

socket.on('chat_restriction_updated', (restricted) => {
    isChatRestricted = restricted;
    chatInput.disabled = restricted;
    chatInput.placeholder = restricted ? "🔇 Chat restricted by Admin" : "Send a message...";
});

socket.on('update_roster', (users) => {
    document.getElementById('roster-count').textContent = users.length;
    const rosterList = document.getElementById('roster-list');
    rosterList.innerHTML = '';

    users.sort((a, b) => ROLE_LEVEL[b.role] - ROLE_LEVEL[a.role]);
    const myLevel = ROLE_LEVEL[myRole];

    users.forEach(u => {
        const item = document.createElement('div');
        item.className = 'roster-item';

        const header = document.createElement('div');
        header.className = 'roster-header';

        const nameSpan = document.createElement('span');
        nameSpan.style.cursor = 'pointer';
        nameSpan.textContent = `${u.username} ${u.id === socket.id ? '(You)' : ''} ${u.inCall ? '📷' : ''}`;
        nameSpan.onclick = () => openProfileModal(u.userId);

        const badge = document.createElement('span');
        badge.className = `role-badge role-${u.role}`;
        badge.textContent = u.role;

        header.appendChild(nameSpan);
        header.appendChild(badge);
        item.appendChild(header);

        const targetLevel = ROLE_LEVEL[u.role];
        if (u.id !== socket.id && myLevel >= ROLE_LEVEL.admin && myLevel > targetLevel) {
            const toolbar = document.createElement('div');
            toolbar.className = 'mod-toolbar';

            const roleSelect = document.createElement('select');
            roleSelect.className = 'mod-select';
            const allowed = (myRole === 'owner') ? ['member', 'curator', 'admin'] : ['member', 'curator'];
            allowed.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r;
                opt.textContent = r.toUpperCase();
                if (u.role === r) opt.selected = true;
                roleSelect.appendChild(opt);
            });
            roleSelect.onchange = (e) => socket.emit('moderate_user', { targetId: u.id, action: 'set_role', newRole: e.target.value });
            toolbar.appendChild(roleSelect);

            const chatBtn = document.createElement('button');
            chatBtn.className = 'mod-btn';
            chatBtn.textContent = u.chatRestricted ? 'Unmute Chat' : 'Mute Chat';
            chatBtn.onclick = () => socket.emit('moderate_user', { targetId: u.id, action: 'toggle_chat' });
            toolbar.appendChild(chatBtn);

            if (u.inCall) {
                const muteMic = document.createElement('button');
                muteMic.className = 'mod-btn';
                muteMic.textContent = u.callMuted ? 'Unmute Mic' : 'Mute Mic';
                muteMic.onclick = () => socket.emit('moderate_user', { targetId: u.id, action: 'toggle_call_mute' });
                toolbar.appendChild(muteMic);

                const endCall = document.createElement('button');
                endCall.className = 'mod-btn danger';
                endCall.textContent = 'End Call';
                endCall.onclick = () => socket.emit('moderate_user', { targetId: u.id, action: 'remove_from_call' });
                toolbar.appendChild(endCall);
            }

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

// ==========================================
// 8. WEBRTC PARTY VIDEO CALLS
// ==========================================
const btnJoinCall = document.getElementById('btn-join-call');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');
const btnLeaveCall = document.getElementById('btn-leave-call');
const videoGrid = document.getElementById('video-grid');

function stopLocalCall() {
    if (myVideoStream) {
        myVideoStream.getTracks().forEach(t => t.stop());
        myVideoStream = null;
    }
    if (myPeer) { myPeer.destroy(); myPeer = null; }
    Object.values(activePeers).forEach(c => c.close());
    videoGrid.innerHTML = '';

    btnJoinCall.style.display = 'inline-block';
    btnToggleMic.style.display = 'none';
    btnToggleCam.style.display = 'none';
    btnLeaveCall.style.display = 'none';
}

btnJoinCall.onclick = async () => {
    try {
        myVideoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        addVideoTile('local', myVideoStream, 'You', true);

        btnJoinCall.style.display = 'none';
        btnToggleMic.style.display = 'inline-block';
        btnToggleCam.style.display = 'inline-block';
        btnLeaveCall.style.display = 'inline-block';

        myPeer = new Peer();
        myPeer.on('open', (peerId) => socket.emit('join_video_call', peerId));
        myPeer.on('call', (call) => {
            call.answer(myVideoStream);
            call.on('stream', (remStream) => addVideoTile(call.peer, remStream, call.metadata?.username || 'Member', false));
            call.on('close', () => removeVideoTile(call.peer));
            activePeers[call.peer] = call;
        });
    } catch (e) {
        alert("Camera/Microphone permission denied.");
    }
};

socket.on('user_joined_video', ({ peerId, username }) => {
    if (!myVideoStream || !myPeer) return;
    const call = myPeer.call(peerId, myVideoStream, { metadata: { username: myUser.username } });
    call.on('stream', (remStream) => addVideoTile(peerId, remStream, username, false));
    call.on('close', () => removeVideoTile(peerId));
    activePeers[peerId] = call;
});

socket.on('user_left_video', (peerId) => {
    if (activePeers[peerId]) { activePeers[peerId].close(); delete activePeers[peerId]; }
    removeVideoTile(peerId);
});

socket.on('force_mute_status', (muted) => {
    isServerCallMuted = muted;
    if (!myVideoStream) return;
    const audioTrack = myVideoStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !muted;
        btnToggleMic.disabled = muted;
        btnToggleMic.textContent = muted ? '🎙️❌ Muted' : '🎤 Mute Mic';
    }
});

socket.on('force_leave_call', () => {
    stopLocalCall();
    alert("Removed from call by Admin.");
});

function addVideoTile(id, stream, label, muted) {
    if (document.getElementById(`tile-${id}`)) return;
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${id}`;

    const v = document.createElement('video');
    v.srcObject = stream;
    v.muted = muted;
    v.onloadedmetadata = () => v.play();

    const lbl = document.createElement('div');
    lbl.className = 'video-label';
    lbl.textContent = label;

    tile.appendChild(v);
    tile.appendChild(lbl);
    videoGrid.appendChild(tile);
}

function removeVideoTile(id) {
    const el = document.getElementById(`tile-${id}`);
    if (el) el.remove();
}

btnToggleMic.onclick = () => {
    if (!myVideoStream || isServerCallMuted) return;
    const t = myVideoStream.getAudioTracks()[0];
    if (t) { t.enabled = !t.enabled; btnToggleMic.textContent = t.enabled ? '🎤 Mute Mic' : '🔇 Unmute Mic'; }
};

btnToggleCam.onclick = () => {
    if (!myVideoStream) return;
    const t = myVideoStream.getVideoTracks()[0];
    if (t) { t.enabled = !t.enabled; btnToggleCam.textContent = t.enabled ? '📷 Hide Cam' : '🚫 Show Cam'; }
};

btnLeaveCall.onclick = () => {
    stopLocalCall();
    socket.emit('leave_video_call');
};