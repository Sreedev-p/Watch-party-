const socket = io();

// Global State
let myUser = { userId: null, username: '', createdAt: null };
let allServerParties = [];
let myFriends = [];
let sidebarFilter = 'my';

// Active Party State
const ROLE_LEVEL = { member: 1, curator: 2, admin: 3, owner: 4 };
let currentParty = null;
let myRole = 'member';
let activeMediaSource = 'youtube';
let isChatRestricted = false;
let isServerCallMuted = false;
let captionsEnabled = false;
let autoPlayNext = true;
let overlayChatEnabled = true;

// Players, Sync & Telemetry
let player;
const html5Player = document.getElementById('html5-player');
let isSyncing = false;
let syncFailsafe;
let debounceTimer;
let idleControlsTimer;
const latencySamples = [];
let currentDriftMs = 0;

// WebRTC State
let myPeer = null;
let myVideoStream = null;
let inActiveCall = false;
const activePeers = {};

function blockEcho() {
    isSyncing = true;
    clearTimeout(syncFailsafe);
    syncFailsafe = setTimeout(() => { isSyncing = false; }, 1000);
}

function canControlPlayback() {
    if (ROLE_LEVEL[myRole] < ROLE_LEVEL.admin) {
        alert("Only Admins and the Party Owner can control video playback.");
        return false;
    }
    return true;
}

// Update filled range slider gradient (matches reference UI)
function updateSliderFill(sliderEl, percent) {
    const clamped = Math.max(0, Math.min(100, percent || 0));
    sliderEl.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${clamped}%, #3a3d4a ${clamped}%, #3a3d4a 100%)`;
}

// ==========================================
// 1. LATENCY TELEMETRY & AUTO-JOIN VIA INVITE LINK (?party=PTY-XXXX)
// ==========================================
setInterval(() => {
    socket.emit('latency_ping', Date.now());
}, 4000);

socket.on('latency_pong', (sentTime) => {
    const rtt = Math.max(1, Date.now() - sentTime);
    latencySamples.push(rtt);
    if (latencySamples.length > 20) latencySamples.shift();

    const sorted = [...latencySamples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || rtt;

    document.getElementById('nav-ping-label').textContent = `RTT: ${rtt}ms`;
    document.getElementById('stat-p95-latency').textContent = `${p95} ms`;
});

document.getElementById('btn-open-telemetry').onclick = () => {
    document.getElementById('telemetry-modal').style.display = 'flex';
};
document.getElementById('btn-close-telemetry').onclick = () => {
    document.getElementById('telemetry-modal').style.display = 'none';
};

// ==========================================
// 2. AUTHENTICATION & VIEW ROUTING
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
    window.location.href = '/';
};

socket.on('auth_success', ({ userId, username, createdAt, parties, friends }) => {
    myUser = { userId, username, createdAt };
    allServerParties = parties || [];
    myFriends = friends || [];

    document.getElementById('nav-username').textContent = username;
    document.getElementById('nav-avatar').textContent = username.charAt(0).toUpperCase();
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('top-navbar').style.display = 'flex';

    // Check URL for shareable invite link (?party=PTY-XXXX)
    const params = new URLSearchParams(window.location.search);
    const invitePartyId = params.get('party');
    if (invitePartyId) {
        window.history.replaceState({}, document.title, '/');
        socket.emit('join_party', { partyId: invitePartyId });
    } else {
        showDashboardView();
    }
});

socket.on('auth_error', (msg) => {
    sessionStorage.removeItem('wp_token');
    document.getElementById('auth-view').style.display = 'flex';
    const alertBox = document.getElementById('auth-alert');
    alertBox.style.display = 'block';
    alertBox.textContent = msg;
});

function hideAllViews() {
    document.getElementById('dashboard-view').style.display = 'none';
    document.getElementById('party-view').style.display = 'none';
    document.getElementById('profile-view').style.display = 'none';
}

function showDashboardView() {
    hideAllViews();
    document.getElementById('dashboard-view').style.display = 'flex';
    renderDashboard();
}

document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;

        if (currentParty) {
            socket.emit('leave_party');
            stopLocalCall();
            currentParty = null;
        }

        if (tab === 'home') {
            showDashboardView();
            document.getElementById('section-created-by-me').style.display = 'block';
            document.getElementById('section-member-parties').style.display = 'block';
            document.getElementById('section-friends').style.display = 'none';
        } else if (tab === 'my-parties') {
            showDashboardView();
            document.getElementById('section-created-by-me').style.display = 'block';
            document.getElementById('section-member-parties').style.display = 'block';
            document.getElementById('section-friends').style.display = 'none';
        } else if (tab === 'friends') {
            showDashboardView();
            document.getElementById('section-created-by-me').style.display = 'none';
            document.getElementById('section-member-parties').style.display = 'none';
            document.getElementById('section-friends').style.display = 'block';
            renderFriendsSection();
        } else if (tab === 'profile') {
            openFullProfilePage(myUser.userId);
        }
    };
});

document.getElementById('nav-logo').onclick = () => document.querySelector('[data-tab="home"]').click();
document.getElementById('nav-user-chip').onclick = () => document.querySelector('[data-tab="profile"]').click();

// ==========================================
// 3. DASHBOARD RENDERING & FULL-PAGE PROFILE VIEW
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

// De-cluttered Party Card (Does NOT show long noisy video filenames)
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
    badge.textContent = p.isPublic ? 'Public' : 'Private';

    topRow.appendChild(titleWrap);
    topRow.appendChild(badge);
    card.appendChild(topRow);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'row-between';

    const meta = document.createElement('span');
    meta.className = 'meta-subtext mono-text';
    meta.textContent = `${p.partyId} • ${p.activeCount} online ${p.myRole ? `• ${p.myRole.toUpperCase()}` : ''}`;
    bottomRow.appendChild(meta);

    if (!compact && Number(p.ownerUserId) === Number(myUser.userId)) {
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

    // Section 1: Created by Me
    const myCreatedGrid = document.getElementById('my-created-parties-grid');
    myCreatedGrid.innerHTML = '';
    const myCreated = allServerParties.filter(p => Number(p.ownerUserId) === Number(myUser.userId));
    if (myCreated.length === 0) {
        myCreatedGrid.innerHTML = `<div class="meta-subtext">You haven't created any parties yet.</div>`;
    } else {
        myCreated.forEach(p => myCreatedGrid.appendChild(createPartyCardElement(p)));
    }

    // Section 2: Parties User is a Member Of (Requirement 4)
    const memberGrid = document.getElementById('member-parties-grid');
    memberGrid.innerHTML = '';
    const memberParties = allServerParties.filter(p => p.myRole !== null);
    if (memberParties.length === 0) {
        memberGrid.innerHTML = `<div class="meta-subtext">You haven't joined any parties yet. Use the left sidebar to explore Global Top parties!</div>`;
    } else {
        memberParties.forEach(p => memberGrid.appendChild(createPartyCardElement(p)));
    }
}

function renderFriendsSection() {
    const grid = document.getElementById('friends-grid');
    grid.innerHTML = '';
    if (myFriends.length === 0) {
        grid.innerHTML = `<div class="meta-subtext">Use the top search bar to find users and add them as friends.</div>`;
        return;
    }

    myFriends.forEach(f => {
        const card = document.createElement('div');
        card.className = 'party-card';
        const row = document.createElement('div');
        row.className = 'row-between';

        const nameWrap = document.createElement('div');
        nameWrap.className = 'row-gap';
        const av = document.createElement('div');
        av.className = 'avatar-circle';
        av.textContent = f.username.charAt(0).toUpperCase();
        const name = document.createElement('strong');
        name.textContent = f.username;
        nameWrap.appendChild(av);
        nameWrap.appendChild(name);

        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn-secondary btn-sm';
        viewBtn.textContent = 'View Profile';
        viewBtn.onclick = (e) => {
            e.stopPropagation();
            openFullProfilePage(f.id);
        };

        row.appendChild(nameWrap);
        row.appendChild(viewBtn);
        card.appendChild(row);
        grid.appendChild(card);
    });
}

// Universal Search Bar
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
                h.textContent = 'PARTIES';
                globalSearchDropdown.appendChild(h);

                parties.forEach(p => {
                    const row = document.createElement('div');
                    row.className = 'result-item';
                    row.innerHTML = `<span class="status-dot ${p.isActive ? 'active' : 'idle'}"></span>
                                     <div style="flex:1;"><b>${p.partyName}</b> <span class="meta-subtext mono-text">(${p.partyId})</span></div>`;
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
                h.textContent = 'USERS';
                globalSearchDropdown.appendChild(h);

                users.forEach(u => {
                    const row = document.createElement('div');
                    row.className = 'result-item';
                    const nameSpan = document.createElement('span');
                    nameSpan.style.flex = '1';
                    nameSpan.textContent = u.username;

                    const profBtn = document.createElement('button');
                    profBtn.className = 'btn-secondary btn-sm';
                    profBtn.textContent = 'Inspect Profile';
                    profBtn.onclick = () => {
                        globalSearchDropdown.style.display = 'none';
                        openFullProfilePage(u.id);
                    };

                    row.appendChild(nameSpan);
                    row.appendChild(profBtn);
                    globalSearchDropdown.appendChild(row);
                });
            }
        });
});

// Requirement 6: Full-Page Discord-Style User Profile Screen
async function openFullProfilePage(targetUserId) {
    const res = await fetch(`/api/profile/${targetUserId}`);
    if (!res.ok) return;
    const { user, friends, parties } = await res.json();

    hideAllViews();
    document.getElementById('profile-view').style.display = 'block';

    document.getElementById('profile-page-avatar').textContent = user.username.charAt(0).toUpperCase();
    document.getElementById('profile-page-username').textContent = user.username;
    document.getElementById('profile-page-handle').textContent = `UID #${String(user.id).padStart(4, '0')}`;
    document.getElementById('profile-page-created').textContent = user.created_at
        ? new Date(user.created_at).toLocaleDateString([], { month: 'short', year: 'numeric' })
        : 'Oct 2026';

    const actionsDiv = document.getElementById('profile-page-actions');
    actionsDiv.innerHTML = '';

    if (Number(user.id) !== Number(myUser.userId)) {
        const isAlreadyFriend = myFriends.some(f => Number(f.id) === Number(user.id));
        const friendBtn = document.createElement('button');
        friendBtn.className = isAlreadyFriend ? 'btn-danger-sm' : 'btn-accent';
        friendBtn.style.width = '100%';
        friendBtn.textContent = isAlreadyFriend ? 'Remove Friend' : 'Add Friend';
        friendBtn.onclick = () => {
            socket.emit(isAlreadyFriend ? 'remove_friend' : 'add_friend', user.id);
            setTimeout(() => openFullProfilePage(user.id), 200);
        };
        actionsDiv.appendChild(friendBtn);
    }

    document.getElementById('profile-friends-count').textContent = friends.length;
    const fContainer = document.getElementById('profile-page-friends');
    fContainer.innerHTML = '';
    if (friends.length === 0) fContainer.innerHTML = `<div class="meta-subtext">No connected friends yet.</div>`;
    friends.forEach(f => {
        const d = document.createElement('div');
        d.className = 'result-item';
        d.innerHTML = `<span class="status-dot ${f.isOnline ? 'active' : 'idle'}"></span> <b>${f.username}</b>`;
        d.onclick = () => openFullProfilePage(f.id);
        fContainer.appendChild(d);
    });

    document.getElementById('profile-parties-count').textContent = parties.length;
    const pContainer = document.getElementById('profile-page-parties');
    pContainer.innerHTML = '';
    if (parties.length === 0) pContainer.innerHTML = `<div class="meta-subtext">Not a member of any parties yet.</div>`;
    parties.forEach(p => {
        const d = document.createElement('div');
        d.className = 'result-item';
        d.innerHTML = `<span class="status-dot ${p.isActive ? 'active' : 'idle'}"></span>
                       <div style="flex:1;"><b>${p.partyName}</b> <span class="meta-subtext mono-text">[${p.role.toUpperCase()}]</span></div>`;
        d.onclick = () => socket.emit('join_party', { partyId: p.partyId });
        pContainer.appendChild(d);
    });
}

document.getElementById('btn-profile-back').onclick = () => showDashboardView();

// ==========================================
// 4. CREATE PARTY, QUICK PARTY & FRIEND INVITES
// ==========================================
document.getElementById('btn-open-create-modal').onclick = () => {
    const fList = document.getElementById('create-modal-friends-list');
    fList.innerHTML = '';
    if (myFriends.length === 0) {
        fList.innerHTML = `<div class="meta-subtext">No friends added yet (you can skip this step).</div>`;
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
    if (!partyName) return alert("Please enter a party name.");
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

socket.on('party_invite', ({ partyId, partyName, fromUsername }) => {
    const container = document.getElementById('invite-toast-container');
    const toast = document.createElement('div');
    toast.className = 'invite-toast';
    toast.innerHTML = `<div><b>Party Invitation</b><div class="meta-subtext">${fromUsername} invited you to <b>${partyName}</b></div></div>`;

    const joinBtn = document.createElement('button');
    joinBtn.className = 'btn-accent btn-sm';
    joinBtn.textContent = 'Join';
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
// 5. ACTIVE PARTY ROOM & STRICT RBAC UI HIDING
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
    notice.textContent = msg;
});

socket.on('party_joined', (data) => {
    currentParty = data;
    myRole = data.role;

    hideAllViews();
    document.getElementById('party-view').style.display = 'flex';
    document.getElementById('active-party-title').textContent = data.partyName;

    applyRolePermissions();
    updateCallButtonBadge(data.callCount || 0);

    renderQueue(data.queue || []);
    renderHistory(data.history || []);
    renderPoll(data.activePoll || null);

    const chatMessages = document.getElementById('chat-messages');
    const overlayMessages = document.getElementById('overlay-chat-messages');
    chatMessages.innerHTML = '';
    overlayMessages.innerHTML = '';
    (data.chatHistory || []).forEach(msg => appendChatMessage(msg));

    loadMediaIntoPlayer(data.videoSource, data.videoId, data.videoTitle, data.time, data.state);
    renderPartyFriendInviter();
});

document.getElementById('btn-back-dashboard').onclick = () => {
    socket.emit('leave_party');
    stopLocalCall();
    currentParty = null;
    document.body.classList.remove('lights-off');
    if (player && player.pauseVideo) player.pauseVideo();
    html5Player.pause();
    showDashboardView();
};

document.getElementById('btn-copy-invite-link').onclick = () => {
    if (!currentParty) return;
    const link = `${window.location.origin}/?party=${currentParty.partyId}`;
    navigator.clipboard.writeText(link);
    alert(`Shareable Invite Link copied:\n${link}`);
};

document.getElementById('btn-copy-party-id').onclick = () => {
    if (!currentParty) return;
    navigator.clipboard.writeText(currentParty.partyId);
    alert(`Copied Party ID: ${currentParty.partyId}`);
};

document.getElementById('btn-delete-active-party').onclick = () => {
    if (!currentParty) return;
    if (confirm(`Delete party "${currentParty.partyName}" permanently?`)) {
        socket.emit('delete_party', { partyId: currentParty.partyId });
    }
};

// Requirement 7: Strictly hide/restrict search bar and transport controls according to role
function applyRolePermissions() {
    if (!currentParty) return;
    document.getElementById('active-party-meta').textContent =
        `ID: ${currentParty.partyId} • ${currentParty.isPublic ? 'Public' : 'Private'} • Role: ${myRole.toUpperCase()}`;

    const isOwner = Number(currentParty.ownerUserId) === Number(myUser.userId) || myRole === 'owner';
    const canCurate = ROLE_LEVEL[myRole] >= ROLE_LEVEL.curator;
    const canAdmin = ROLE_LEVEL[myRole] >= ROLE_LEVEL.admin;

    document.getElementById('btn-delete-active-party').style.display = isOwner ? 'inline-flex' : 'none';

    // Hide the entire media search/upload toolbar if user is just a Member (Level 1)
    document.getElementById('party-media-toolbar').style.display = canCurate ? 'flex' : 'none';
    if (!canCurate) document.getElementById('search-results').innerHTML = '';

    // Hide/Restrict transport controls for non-admins
    document.getElementById('btn-prev').style.display = canAdmin ? 'inline-flex' : 'none';
    document.getElementById('btn-skip').style.display = canAdmin ? 'inline-flex' : 'none';
    document.getElementById('util-prev').style.display = canAdmin ? 'inline-flex' : 'none';
    document.getElementById('util-next').style.display = canAdmin ? 'inline-flex' : 'none';
    document.getElementById('btn-replay-last').style.display = canAdmin ? 'inline-block' : 'none';
    document.getElementById('seek-bar').disabled = !canAdmin;
    document.getElementById('live-invite-section').style.display = canAdmin ? 'block' : 'none';
}

function renderPartyFriendInviter() {
    const list = document.getElementById('party-invite-friends-list');
    if (!list) return;
    list.innerHTML = '';
    if (myFriends.length === 0) {
        list.innerHTML = `<div class="meta-subtext">Add friends from the dashboard to invite them.</div>`;
        return;
    }
    myFriends.forEach(f => {
        const row = document.createElement('div');
        row.className = 'row-between';
        row.style.fontSize = '12px';
        row.innerHTML = `<span>${f.username}</span>`;
        const btn = document.createElement('button');
        btn.className = 'mod-btn';
        btn.textContent = 'Invite';
        btn.onclick = () => {
            socket.emit('invite_friend_to_party', { friendUserId: f.id });
            btn.textContent = 'Sent';
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

socket.on('knock_request', ({ requesterId, username }) => {
    const container = document.getElementById('knock-container');
    const banner = document.createElement('div');
    banner.className = 'glass-panel party-header-bar';
    banner.style.borderLeft = '4px solid var(--accent)';
    banner.innerHTML = `<span><b>${username}</b> is requesting to join this private party.</span>`;

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
// 6. PLAYER ENGINE, ELASTIC SYNC & OVERLAY CHAT
// ==========================================
window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '8hP9D6kZseM',
        playerVars: {
            'controls': 0, 'disablekb': 1, 'rel': 0, 'modestbranding': 1, 'iv_load_policy': 3, 'fs': 0
        },
        events: {
            'onReady': () => {
                setInterval(updateProgressBar, 400);
                updateSliderFill(document.getElementById('volume-slider'), 100);
            },
            'onStateChange': (e) => {
                if (e.data === 1 || e.data === 2) updatePlayPauseUI(e.data === 1);
                if (e.data === 0 && autoPlayNext) socket.emit('video_ended');
            }
        }
    });
};

html5Player.onended = () => { if (autoPlayNext) socket.emit('video_ended'); };

function setPlayerPlaybackRate(rate) {
    if (activeMediaSource === 'youtube' && player && player.setPlaybackRate) {
        player.setPlaybackRate(rate);
    } else if (html5Player) {
        html5Player.playbackRate = rate;
    }
    const pill = document.getElementById('sync-status-pill');
    if (pill) {
        pill.textContent = `Sync: ${rate.toFixed(2)}x (${currentDriftMs}ms)`;
    }
    document.getElementById('stat-playback-rate').textContent = `${rate.toFixed(2)}x`;
}

socket.on('sync_heartbeat', ({ state, time }) => {
    if (!currentParty || state !== 'playing') {
        setPlayerPlaybackRate(1.0);
        return;
    }

    const localTime = getActiveCurrentTime();
    const drift = time - localTime;
    const absDrift = Math.abs(drift);
    currentDriftMs = Math.round(absDrift * 1000);
    document.getElementById('stat-current-drift').textContent = `${currentDriftMs} ms`;

    if (absDrift > 3.0) {
        if (activeMediaSource === 'youtube' && player.seekTo) player.seekTo(time, true);
        else html5Player.currentTime = time;
        setPlayerPlaybackRate(1.0);
    } else if (absDrift > 0.22) {
        const subtleRate = drift > 0 ? 1.05 : 0.95;
        setPlayerPlaybackRate(subtleRate);
    } else {
        setPlayerPlaybackRate(1.0);
    }
});

function loadMediaIntoPlayer(source, videoId, title, startTime = 0, playState = 'paused') {
    activeMediaSource = source || 'youtube';
    const ytDiv = document.getElementById('player');

    if (activeMediaSource === 'youtube') {
        html5Player.pause();
        html5Player.style.display = 'none';
        ytDiv.style.display = 'block';

        if (player && player.loadVideoById) {
            blockEcho();
            player.loadVideoById(videoId, startTime);
            player.unMute();
            if (playState === 'playing') {
                player.playVideo();
                updatePlayPauseUI(true);
            } else {
                setTimeout(() => { player.pauseVideo(); updatePlayPauseUI(false); }, 400);
            }
        }
    } else {
        if (player && player.pauseVideo) player.pauseVideo();
        ytDiv.style.display = 'none';
        html5Player.style.display = 'block';
        html5Player.src = videoId;
        html5Player.onloadedmetadata = () => {
            if (startTime > 0 && Number.isFinite(html5Player.duration)) {
                html5Player.currentTime = startTime;
            }
            if (playState === 'playing') {
                html5Player.play().catch(() => {});
                updatePlayPauseUI(true);
            } else {
                html5Player.pause();
                updatePlayPauseUI(false);
            }
        };
    }
}

socket.on('load_new_media', (data) => {
    loadMediaIntoPlayer(data.videoSource, data.videoId, data.videoTitle, 0, 'playing');
});

function getActiveCurrentTime() {
    if (activeMediaSource === 'youtube') return (player && player.getCurrentTime) ? player.getCurrentTime() : 0;
    return html5Player.currentTime || 0;
}

function getActiveDuration() {
    const raw = (activeMediaSource === 'youtube')
        ? ((player && player.getDuration) ? player.getDuration() : 0)
        : html5Player.duration;
    return (Number.isFinite(raw) && raw > 0) ? raw : 0;
}

function formatTime(s) {
    if (!Number.isFinite(s) || s < 0) return '00:00';
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function updatePlayPauseUI(isPlaying) {
    document.getElementById('svg-play').style.display = isPlaying ? 'none' : 'block';
    document.getElementById('svg-pause').style.display = isPlaying ? 'block' : 'none';
    const centerCircle = document.getElementById('center-play-indicator');
    if (isPlaying) centerCircle.classList.add('hidden');
    else centerCircle.classList.remove('hidden');
}

function updateProgressBar() {
    const cur = getActiveCurrentTime();
    const dur = getActiveDuration();
    const seekBar = document.getElementById('seek-bar');
    if (dur > 0) {
        const pct = (cur / dur) * 100;
        seekBar.value = pct;
        updateSliderFill(seekBar, pct);
        document.getElementById('time-display').innerText = `${formatTime(cur)} / ${formatTime(dur)}`;
    } else {
        updateSliderFill(seekBar, 0);
        document.getElementById('time-display').innerText = `${formatTime(cur)} / 00:00`;
    }
}

function togglePlayPause() {
    if (!canControlPlayback()) return;
    const cur = getActiveCurrentTime();

    if (activeMediaSource === 'youtube') {
        const st = player.getPlayerState();
        if (st === 1) { player.pauseVideo(); socket.emit('pause_video', { time: cur, sentAt: Date.now() }); }
        else { player.playVideo(); socket.emit('play_video', { time: cur, sentAt: Date.now() }); }
    } else {
        if (!html5Player.paused) { html5Player.pause(); updatePlayPauseUI(false); socket.emit('pause_video', { time: cur, sentAt: Date.now() }); }
        else { html5Player.play(); updatePlayPauseUI(true); socket.emit('play_video', { time: cur, sentAt: Date.now() }); }
    }
}

function seekRelative(delta) {
    if (!canControlPlayback()) return;
    const dur = getActiveDuration();
    if (dur <= 0) return;
    const target = Math.max(0, Math.min(dur, getActiveCurrentTime() + delta));
    if (activeMediaSource === 'youtube') player.seekTo(target, true);
    else html5Player.currentTime = target;
    socket.emit('play_video', { time: target, sentAt: Date.now() });
}

function toggleMute() {
    const volOn = document.getElementById('svg-vol-on');
    const volMute = document.getElementById('svg-vol-mute');
    if (activeMediaSource === 'youtube') {
        if (player.isMuted()) {
            player.unMute();
            volOn.style.display = 'block';
            volMute.style.display = 'none';
        } else {
            player.mute();
            volOn.style.display = 'none';
            volMute.style.display = 'block';
        }
    } else {
        html5Player.muted = !html5Player.muted;
        volOn.style.display = html5Player.muted ? 'none' : 'block';
        volMute.style.display = html5Player.muted ? 'block' : 'none';
    }
}

function changeVolume(delta) {
    const slider = document.getElementById('volume-slider');
    const nextVol = Math.max(0, Math.min(100, Number(slider.value) + delta));
    slider.value = nextVol;
    updateSliderFill(slider, nextVol);
    if (activeMediaSource === 'youtube' && player && player.setVolume) player.setVolume(nextVol);
    html5Player.volume = nextVol / 100;
}

function toggleCaptions() {
    if (activeMediaSource !== 'youtube' || !player) return;
    captionsEnabled = !captionsEnabled;
    const ccBtn = document.getElementById('btn-captions');
    if (captionsEnabled) {
        player.loadModule('captions');
        player.setOption('captions', 'track', { 'languageCode': 'en' });
        ccBtn.classList.add('active-toggle');
    } else {
        player.unloadModule('captions');
        ccBtn.classList.remove('active-toggle');
    }
}

// Requirement 8: Overlay Chat in Theater & Fullscreen Mode
function syncOverlayChatVisibility() {
    const isTheater = document.getElementById('main-layout').classList.contains('theater-mode');
    const isFull = Boolean(document.fullscreenElement);
    const overlay = document.getElementById('video-chat-overlay');

    if ((isTheater || isFull) && overlayChatEnabled) {
        overlay.style.display = 'flex';
    } else {
        overlay.style.display = 'none';
    }
}

function toggleTheaterMode() {
    document.getElementById('main-layout').classList.toggle('theater-mode');
    syncOverlayChatVisibility();
}

function toggleFullscreenMode() {
    const wrapper = document.getElementById('video-wrapper');
    if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen().catch(() => {});
    }
}

document.addEventListener('fullscreenchange', syncOverlayChatVisibility);

document.getElementById('btn-toggle-overlay-chat').onclick = () => {
    overlayChatEnabled = !overlayChatEnabled;
    document.getElementById('btn-toggle-overlay-chat').classList.toggle('active-toggle', overlayChatEnabled);
    syncOverlayChatVisibility();
};

document.getElementById('btn-close-overlay-chat').onclick = () => {
    overlayChatEnabled = false;
    syncOverlayChatVisibility();
};

// Utility Bar Buttons
document.getElementById('util-expand').onclick = toggleTheaterMode;
document.getElementById('util-lights').onclick = () => {
    const off = document.body.classList.toggle('lights-off');
    document.getElementById('lights-state').textContent = off ? 'Off' : 'On';
};
document.getElementById('util-autoplay').onclick = () => {
    autoPlayNext = !autoPlayNext;
    const el = document.getElementById('autoplay-state');
    el.textContent = autoPlayNext ? 'On' : 'Off';
    el.style.color = autoPlayNext ? 'var(--green-online)' : 'var(--accent)';
};
document.getElementById('util-prev').onclick = () => { if (canControlPlayback()) socket.emit('previous_video'); };
document.getElementById('util-next').onclick = () => { if (canControlPlayback()) socket.emit('skip_video'); };

// Auto-Hide Controls on 3s Mouse Inactivity
const videoWrapper = document.getElementById('video-wrapper');
function resetIdleControlsTimer() {
    videoWrapper.classList.remove('controls-idle');
    clearTimeout(idleControlsTimer);
    idleControlsTimer = setTimeout(() => {
        videoWrapper.classList.add('controls-idle');
    }, 2800);
}
videoWrapper.addEventListener('mousemove', resetIdleControlsTimer);
videoWrapper.addEventListener('mouseleave', () => {
    clearTimeout(idleControlsTimer);
    videoWrapper.classList.remove('controls-idle');
});

document.getElementById('btn-play-pause').onclick = togglePlayPause;
document.getElementById('player-shield').onclick = togglePlayPause;
document.getElementById('player-shield').ondblclick = toggleFullscreenMode;
document.getElementById('btn-mute').onclick = toggleMute;
document.getElementById('btn-captions').onclick = toggleCaptions;
document.getElementById('btn-theater').onclick = toggleTheaterMode;
document.getElementById('btn-fullscreen').onclick = toggleFullscreenMode;
document.getElementById('btn-prev').onclick = () => { if (canControlPlayback()) socket.emit('previous_video'); };
document.getElementById('btn-replay-last').onclick = () => { if (canControlPlayback()) socket.emit('previous_video'); };
document.getElementById('btn-skip').onclick = () => { if (canControlPlayback()) socket.emit('skip_video'); };

document.getElementById('seek-bar').oninput = (e) => {
    if (!canControlPlayback()) return;
    const dur = getActiveDuration();
    if (dur <= 0) return;
    const pct = Number(e.target.value);
    updateSliderFill(e.target, pct);
    const target = (pct / 100) * dur;
    if (activeMediaSource === 'youtube') player.seekTo(target, true);
    else html5Player.currentTime = target;
    socket.emit('play_video', { time: target, sentAt: Date.now() });
};

document.getElementById('volume-slider').oninput = () => changeVolume(0);

socket.on('sync_play', (payload) => {
    blockEcho();
    const time = typeof payload === 'object' ? payload.time : payload;
    if (payload.sentAt) {
        const propMs = Math.max(2, Date.now() - payload.sentAt);
        document.getElementById('stat-p95-latency').textContent = `${propMs} ms`;
    }
    if (activeMediaSource === 'youtube') {
        if (Math.abs(player.getCurrentTime() - time) > 1.5) player.seekTo(time, true);
        player.playVideo();
    } else {
        if (Math.abs(html5Player.currentTime - time) > 1.5) html5Player.currentTime = time;
        html5Player.play().catch(() => {});
        updatePlayPauseUI(true);
    }
});

socket.on('sync_pause', (payload) => {
    blockEcho();
    setPlayerPlaybackRate(1.0);
    const time = typeof payload === 'object' ? payload.time : payload;
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

    resetIdleControlsTimer();
    switch (e.code) {
        case 'Space': e.preventDefault(); togglePlayPause(); break;
        case 'ArrowRight': e.preventDefault(); seekRelative(5); break;
        case 'ArrowLeft': e.preventDefault(); seekRelative(-5); break;
        case 'ArrowUp': e.preventDefault(); changeVolume(10); break;
        case 'ArrowDown': e.preventDefault(); changeVolume(-10); break;
        case 'KeyM': e.preventDefault(); toggleMute(); break;
        case 'KeyC': e.preventDefault(); toggleCaptions(); break;
        case 'KeyT': e.preventDefault(); toggleTheaterMode(); break;
        case 'KeyF': e.preventDefault(); toggleFullscreenMode(); break;
    }
});

// ==========================================
// 7. MOVIE DISCOVERY (CATEGORIES & FUZZY SEARCH) + CHUNKED LOCAL UPLOAD
// ==========================================
const mediaSourceSelect = document.getElementById('media-source-select');
const movieCategorySelect = document.getElementById('movie-category-select');
const mediaSearchInput = document.getElementById('media-search-input');
const btnLoadUrl = document.getElementById('btn-load-url');
const localFileInput = document.getElementById('local-file-input');
const uploadStatus = document.getElementById('upload-status');

function fetchRecommendedMovies() {
    const cat = movieCategorySelect.value;
    const q = mediaSearchInput.value.trim();
    fetch(`/api/movies?category=${encodeURIComponent(cat)}&q=${encodeURIComponent(q)}`)
        .then(r => r.json())
        .then(movies => renderMediaResults(movies.map(m => ({
            videoId: m.videoId,
            title: `${m.title} (${m.year}) • ${m.category} • ★ ${m.rating}`,
            thumb: m.thumb
        }))));
}

mediaSourceSelect.onchange = () => {
    const mode = mediaSourceSelect.value;
    document.getElementById('search-results').innerHTML = '';

    movieCategorySelect.style.display = (mode === 'recommendations') ? 'inline-block' : 'none';
    mediaSearchInput.style.display = (mode !== 'local') ? 'block' : 'none';
    btnLoadUrl.style.display = (mode === 'url') ? 'inline-flex' : 'none';
    localFileInput.style.display = (mode === 'local') ? 'block' : 'none';

    if (mode === 'recommendations') {
        mediaSearchInput.placeholder = 'Fuzzy search curated movies (e.g. interstelar, anime, sci-fi)...';
        fetchRecommendedMovies();
    } else if (mode === 'youtube' || mode === 'tmdb') {
        mediaSearchInput.placeholder = mode === 'tmdb' ? 'Search TMDB Movies...' : 'Search YouTube videos...';
    } else if (mode === 'url') {
        mediaSearchInput.placeholder = 'Paste direct video stream link (.mp4, .webm)...';
    }
};

movieCategorySelect.onchange = fetchRecommendedMovies;

mediaSearchInput.oninput = (e) => {
    const mode = mediaSourceSelect.value;
    const query = e.target.value.trim();
    clearTimeout(debounceTimer);

    if (mode === 'recommendations') {
        debounceTimer = setTimeout(fetchRecommendedMovies, 200);
        return;
    }
    if (mode !== 'youtube' && mode !== 'tmdb') return;

    if (query.length > 0) {
        debounceTimer = setTimeout(() => {
            socket.emit('search_media', { query, source: mode });
        }, 400);
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
        videoTitle: 'Direct Video Stream'
    });
    mediaSearchInput.value = '';
};

localFileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadStatus.style.display = 'inline-block';
    uploadStatus.textContent = `Streaming chunks for "${file.name}"...`;

    try {
        const res = await fetch('/api/upload-local', {
            method: 'POST',
            headers: {
                'x-file-name': encodeURIComponent(file.name),
                'Content-Type': 'application/octet-stream'
            },
            body: file
        });
        const data = await res.json();
        uploadStatus.style.display = 'none';
        localFileInput.value = '';

        if (data.streamUrl) {
            socket.emit('change_media_source', {
                videoSource: 'url',
                videoId: data.streamUrl,
                videoTitle: data.title
            });
        }
    } catch (err) {
        uploadStatus.textContent = 'Upload failed.';
        setTimeout(() => { uploadStatus.style.display = 'none'; }, 3000);
    }
};

function renderMediaResults(items) {
    const container = document.getElementById('search-results');
    container.innerHTML = '';
    const canAdmin = ROLE_LEVEL[myRole] >= ROLE_LEVEL.admin;

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'result-item';
        div.innerHTML = `<img src="${item.thumb}" class="result-thumb">`;

        const titleDiv = document.createElement('div');
        titleDiv.className = 'result-title';
        titleDiv.textContent = item.title;
        div.appendChild(titleDiv);

        if (canAdmin) {
            const playNowBtn = document.createElement('button');
            playNowBtn.className = 'btn-accent btn-sm';
            playNowBtn.textContent = 'Play';
            playNowBtn.onclick = (e) => {
                e.stopPropagation();
                socket.emit('change_media_source', {
                    videoSource: 'youtube',
                    videoId: item.videoId,
                    videoTitle: item.title
                });
                container.innerHTML = '';
            };
            div.appendChild(playNowBtn);
        }

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
        };
        div.appendChild(qBtn);
        container.appendChild(div);
    });
}

socket.on('search_results', renderMediaResults);

function renderQueue(queue) {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    if (!queue || queue.length === 0) {
        list.textContent = 'Queue is empty.';
    } else {
        queue.forEach((v, idx) => {
            const d = document.createElement('div');
            d.className = 'history-item';
            d.textContent = `${idx + 1}. ${v.title}`;
            list.appendChild(d);
        });
    }
}

function renderHistory(history) {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    if (!history || history.length === 0) {
        list.textContent = 'No videos watched yet.';
        return;
    }

    const canAdmin = ROLE_LEVEL[myRole] >= ROLE_LEVEL.admin;
    for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];
        const row = document.createElement('div');
        row.className = 'history-item';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = item.title;
        row.appendChild(titleSpan);

        if (canAdmin) {
            const replayBtn = document.createElement('button');
            replayBtn.className = 'mod-btn';
            replayBtn.textContent = 'Replay';
            replayBtn.onclick = () => socket.emit('previous_video', i);
            row.appendChild(replayBtn);
        }

        list.appendChild(row);
    }
}

socket.on('update_queue', renderQueue);
socket.on('update_history', renderHistory);

// ==========================================
// 8. LIVE FLOATING REACTIONS, GROUP POLLS, CHAT & ROSTER
// ==========================================
document.querySelectorAll('.react-btn').forEach(btn => {
    btn.onclick = () => socket.emit('send_reaction', btn.dataset.react);
});

socket.on('party_reaction', ({ reaction }) => {
    const layer = document.getElementById('floating-reactions-layer');
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.style.left = `${Math.floor(Math.random() * 32)}px`;
    el.textContent = reaction;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2400);
});

// Polls Tab Switching
document.getElementById('tab-btn-chat').onclick = () => {
    document.getElementById('tab-btn-chat').classList.add('active');
    document.getElementById('tab-btn-polls').classList.remove('active');
    document.getElementById('chat-subview').style.display = 'flex';
    document.getElementById('polls-subview').style.display = 'none';
};

document.getElementById('tab-btn-polls').onclick = () => {
    document.getElementById('tab-btn-polls').classList.add('active');
    document.getElementById('tab-btn-chat').classList.remove('active');
    document.getElementById('polls-subview').style.display = 'flex';
    document.getElementById('chat-subview').style.display = 'none';
};

document.getElementById('btn-create-poll').onclick = () => {
    const question = document.getElementById('poll-question-input').value.trim();
    const opt1 = document.getElementById('poll-opt1-input').value.trim();
    const opt2 = document.getElementById('poll-opt2-input').value.trim();
    if (!question || !opt1 || !opt2) return alert("Enter a poll question and two options.");
    socket.emit('create_poll', { question, options: [opt1, opt2] });
    document.getElementById('poll-question-input').value = '';
    document.getElementById('poll-opt1-input').value = '';
    document.getElementById('poll-opt2-input').value = '';
};

function renderPoll(poll) {
    const box = document.getElementById('active-poll-box');
    box.innerHTML = '';
    if (!poll) {
        box.innerHTML = `<div class="meta-subtext">No active poll right now. Create one below!</div>`;
        return;
    }

    const title = document.createElement('strong');
    title.style.fontSize = '13px';
    title.textContent = poll.question;
    box.appendChild(title);

    const totalVotes = poll.options.reduce((sum, o) => sum + o.votes, 0) || 1;
    poll.options.forEach((opt, idx) => {
        const pct = Math.round((opt.votes / totalVotes) * 100);
        const bar = document.createElement('div');
        bar.className = 'poll-option-bar';
        bar.innerHTML = `<div class="poll-fill" style="width:${pct}%"></div>
                         <div class="poll-option-content"><span>${opt.text}</span><span class="mono-text">${opt.votes} (${pct}%)</span></div>`;
        bar.onclick = () => socket.emit('vote_poll', idx);
        box.appendChild(bar);
    });
}

socket.on('poll_updated', renderPoll);

// Chat & Overlay Chat Sync
const chatInput = document.getElementById('chat-input');
const overlayChatInput = document.getElementById('overlay-chat-input');

function appendChatMessage(data) {
    const createMsgNode = () => {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-msg';
        const senderSpan = document.createElement('span');
        senderSpan.className = 'chat-sender';
        senderSpan.textContent = `${data.sender}:`;
        const textSpan = document.createElement('span');
        textSpan.textContent = ` ${data.text}`;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-time mono-text';
        timeSpan.textContent = data.timestamp || '';
        msgDiv.appendChild(senderSpan);
        msgDiv.appendChild(textSpan);
        msgDiv.appendChild(timeSpan);
        return msgDiv;
    };

    const chatMessages = document.getElementById('chat-messages');
    chatMessages.appendChild(createMsgNode());
    chatMessages.scrollTop = chatMessages.scrollHeight;

    const overlayMessages = document.getElementById('overlay-chat-messages');
    overlayMessages.appendChild(createMsgNode());
    overlayMessages.scrollTop = overlayMessages.scrollHeight;
}

function sendMessage(inputEl) {
    if (isChatRestricted) return;
    const text = inputEl.value.trim();
    if (text) {
        socket.emit('chat_message', text);
        inputEl.value = '';
    }
}

document.getElementById('btn-send-chat').onclick = () => sendMessage(chatInput);
chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(chatInput); };
overlayChatInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(overlayChatInput); };
socket.on('chat_message', appendChatMessage);

socket.on('chat_restriction_updated', (restricted) => {
    isChatRestricted = restricted;
    chatInput.disabled = restricted;
    overlayChatInput.disabled = restricted;
    chatInput.placeholder = restricted ? "Chat restricted by Admin" : "Send a message...";
});

// Roster & Explicit Host Transfer
socket.on('update_roster', (payload) => {
    const users = Array.isArray(payload) ? payload : (payload.users || []);
    const callCount = payload.callCount || 0;
    updateCallButtonBadge(callCount);

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
        nameSpan.textContent = `${u.username} ${u.id === socket.id ? '(You)' : ''} ${u.inCall ? '• In Call' : ''}`;
        nameSpan.onclick = () => openFullProfilePage(u.userId);

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

            if (myRole === 'owner') {
                const hostBtn = document.createElement('button');
                hostBtn.className = 'mod-btn';
                hostBtn.textContent = 'Make Owner';
                hostBtn.onclick = () => {
                    if (confirm(`Transfer Party Ownership to ${u.username}?`)) {
                        socket.emit('moderate_user', { targetId: u.id, action: 'transfer_ownership' });
                    }
                };
                toolbar.appendChild(hostBtn);
            }

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
// 9. CONDITIONAL RIGHT-EDGE VERTICAL WEBRTC CALL DRAWER (Requirement 9)
// ==========================================
const callDrawer = document.getElementById('call-drawer');
const callOpenTab = document.getElementById('call-drawer-open-tab');
const callCloseTab = document.getElementById('call-drawer-close-tab');
const btnMainJoinCall = document.getElementById('btn-main-join-call');
const joinCallLabel = document.getElementById('join-call-label');

function updateCallButtonBadge(callCount) {
    document.getElementById('drawer-call-count').textContent = `${callCount} in call`;
    if (inActiveCall) {
        joinCallLabel.textContent = `In Call (${callCount})`;
    } else {
        joinCallLabel.textContent = callCount > 0 ? `Join Call (${callCount} active)` : 'Join Call';
    }
}

// Only show the right-edge ◀ arrow AFTER the user has joined a call and collapsed the drawer!
callOpenTab.onclick = () => {
    callDrawer.classList.remove('collapsed');
    callOpenTab.style.display = 'none';
};

callCloseTab.onclick = () => {
    callDrawer.classList.add('collapsed');
    if (inActiveCall) {
        callOpenTab.style.display = 'block';
    }
};

const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');
const btnLeaveCall = document.getElementById('btn-leave-call');
const videoGrid = document.getElementById('video-grid');

function stopLocalCall() {
    inActiveCall = false;
    if (myVideoStream) {
        myVideoStream.getTracks().forEach(t => t.stop());
        myVideoStream = null;
    }
    if (myPeer) { myPeer.destroy(); myPeer = null; }
    Object.values(activePeers).forEach(c => c.close());
    videoGrid.innerHTML = '';

    callDrawer.classList.add('collapsed');
    callOpenTab.style.display = 'none';
    joinCallLabel.textContent = 'Join Call';
}

btnMainJoinCall.onclick = async () => {
    if (inActiveCall) {
        callDrawer.classList.remove('collapsed');
        callOpenTab.style.display = 'none';
        return;
    }

    try {
        myVideoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        inActiveCall = true;
        addVideoTile('local', myVideoStream, 'You', true);

        // Slide open the vertical call drawer on the right edge
        callDrawer.classList.remove('collapsed');
        callOpenTab.style.display = 'none';

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
        btnToggleMic.textContent = muted ? 'Server Muted' : 'Mute Mic';
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
    if (t) { t.enabled = !t.enabled; btnToggleMic.textContent = t.enabled ? 'Mute Mic' : 'Unmute Mic'; }
};

btnToggleCam.onclick = () => {
    if (!myVideoStream) return;
    const t = myVideoStream.getVideoTracks()[0];
    if (t) { t.enabled = !t.enabled; btnToggleCam.textContent = t.enabled ? 'Hide Cam' : 'Show Cam'; }
};

btnLeaveCall.onclick = () => {
    stopLocalCall();
    socket.emit('leave_video_call');
};