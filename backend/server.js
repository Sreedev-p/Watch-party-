require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'watch-party-super-secret-key-2026';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const ROLES = { MEMBER: 'member', CURATOR: 'curator', ADMIN: 'admin', OWNER: 'owner' };
const ROLE_LEVEL = { member: 1, curator: 2, admin: 3, owner: 4 };

// In-Memory Write-Through State: partyId -> Party Object
const parties = {};
// Track online users by userId -> Set of socket.ids (for instant Friend Invites!)
const onlineUsers = {};

function generatePartyId(prefix = 'PTY') {
    return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function getCurrentPartyTime(party) {
    if (!party) return 0;
    let t = Number(party.time) || 0;
    if (party.state === 'playing') {
        t += (Date.now() - party.lastUpdate) / 1000;
    }
    return t;
}

async function persistParty(partyId) {
    const p = parties[partyId];
    if (!p) return;
    p.time = getCurrentPartyTime(p);
    p.lastUpdate = Date.now();
    try {
        await db.saveParty(p);
    } catch (err) {
        console.error(`Failed to persist party ${partyId}:`, err);
    }
}

// Compile dashboard summary for a specific user
async function buildDashboardPayload(userId) {
    const memberships = userId ? await db.getAllMembershipsForUser(userId) : [];
    const roleMap = {};
    memberships.forEach(m => { roleMap[m.party_id] = m.role; });

    const allPartiesList = Object.values(parties).map(p => {
        const activeCount = Object.keys(p.users).length;
        return {
            partyId: p.partyId,
            partyName: p.partyName,
            ownerUserId: p.ownerUserId,
            ownerUsername: p.ownerUsername || 'User',
            isPublic: p.isPublic,
            activeCount: activeCount,
            isActive: activeCount > 0,
            myRole: roleMap[p.partyId] || (Number(p.ownerUserId) === Number(userId) ? 'owner' : null),
            videoTitle: p.videoTitle || 'Ready to Watch'
        };
    });

    // Sort globally by active users first, then newest
    allPartiesList.sort((a, b) => b.activeCount - a.activeCount);
    return allPartiesList;
}

async function broadcastDashboardUpdate() {
    const sockets = await io.fetchSockets();
    for (const s of sockets) {
        if (s.userId) {
            const payload = await buildDashboardPayload(s.userId);
            s.emit('dashboard_data', payload);
        }
    }
}

function broadcastRoster(partyId) {
    const p = parties[partyId];
    if (!p) return;
    io.to(partyId).emit('update_roster', Object.values(p.users));
}

// ==========================================
// 1. REST API: AUTH, SEARCH & PROFILES
// ==========================================
app.post('/api/auth', async (req, res) => {
    try {
        const { username, password, mode } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const cleanUser = username.trim();
        const existing = await db.findUserByUsername(cleanUser);

        if (mode === 'register') {
            if (existing) return res.status(400).json({ error: 'Username already taken. Please Login.' });
            const hash = await bcrypt.hash(password, 10);
            const newUser = await db.createUser(cleanUser, hash, null);
            const token = jwt.sign({ userId: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token, userId: newUser.id, username: newUser.username });
        } else {
            if (!existing || !(await bcrypt.compare(password, existing.password_hash))) {
                return res.status(401).json({ error: 'Invalid username or password.' });
            }
            const token = jwt.sign({ userId: existing.id, username: existing.username }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token, userId: existing.id, username: existing.username });
        }
    } catch (err) {
        console.error('Auth error:', err);
        res.status(500).json({ error: 'Server error during authentication.' });
    }
});

// Universal Search (Parties by Name/ID + Users by Username)
app.get('/api/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim().toLowerCase();
        if (!q) return res.json({ parties: [], users: [] });

        const matchedParties = Object.values(parties)
            .filter(p => p.partyName.toLowerCase().includes(q) || p.partyId.toLowerCase().includes(q))
            .map(p => ({
                partyId: p.partyId,
                partyName: p.partyName,
                isPublic: p.isPublic,
                activeCount: Object.keys(p.users).length,
                isActive: Object.keys(p.users).length > 0
            }));

        const matchedUsers = await db.searchUsers(q);
        res.json({ parties: matchedParties, users: matchedUsers });
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// Fetch Any User's Profile (Friends + Parties they belong to)
app.get('/api/profile/:userId', async (req, res) => {
    try {
        const targetId = Number(req.params.userId);
        const user = await db.findUserById(targetId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const friends = await db.getFriends(targetId);
        const friendsWithStatus = friends.map(f => ({
            ...f,
            isOnline: Boolean(onlineUsers[f.id] && onlineUsers[f.id].size > 0)
        }));

        const userParties = await db.getUserParties(targetId);
        const enrichedParties = userParties.map(up => {
            const liveParty = parties[up.party_id];
            const activeCount = liveParty ? Object.keys(liveParty.users).length : 0;
            return {
                partyId: up.party_id,
                partyName: up.party_name,
                isPublic: up.is_public,
                role: up.role,
                activeCount,
                isActive: activeCount > 0
            };
        });

        res.json({ user, friends: friendsWithStatus, parties: enrichedParties });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

// ==========================================
// 2. SOCKET.IO REAL-TIME ENGINE
// ==========================================
async function admitUserToParty(targetSocket, partyId, defaultRole = ROLES.MEMBER) {
    const party = parties[partyId];
    if (!party) return;

    // Leave previous party if switching
    if (targetSocket.partyId && targetSocket.partyId !== partyId) {
        await handleLeaveParty(targetSocket);
    }

    targetSocket.join(partyId);
    targetSocket.partyId = partyId;

    const isOwner = Number(party.ownerUserId) === Number(targetSocket.userId);
    const savedRoleRow = await db.getUserRole(partyId, targetSocket.userId);

    let assignedRole = defaultRole;
    if (isOwner || defaultRole === ROLES.OWNER) {
        assignedRole = ROLES.OWNER;
    } else if (savedRoleRow) {
        assignedRole = savedRoleRow.role;
    }

    await db.setUserRole(partyId, targetSocket.userId, assignedRole);

    party.users[targetSocket.id] = {
        id: targetSocket.id,
        userId: targetSocket.userId,
        username: targetSocket.username,
        role: assignedRole,
        chatRestricted: false,
        callMuted: false,
        inCall: false
    };

    // Send complete persistent party state (including last stopped timestamp & chat history!)
    targetSocket.emit('party_joined', {
        partyId: party.partyId,
        partyName: party.partyName,
        username: targetSocket.username,
        isPublic: party.isPublic,
        role: assignedRole,
        ownerUserId: party.ownerUserId,
        videoSource: party.videoSource,
        videoId: party.videoId,
        videoTitle: party.videoTitle,
        state: party.state,
        time: getCurrentPartyTime(party),
        queue: party.queue,
        chatHistory: party.chatHistory
    });

    broadcastRoster(partyId);
    await broadcastDashboardUpdate();
}

async function handleLeaveParty(socket) {
    const partyId = socket.partyId;
    if (!partyId || !parties[partyId]) return;

    const party = parties[partyId];

    if (socket.peerId) {
        socket.to(partyId).emit('user_left_video', socket.peerId);
        socket.peerId = null;
    }

    // Freeze current playback timestamp before removing user
    party.time = getCurrentPartyTime(party);
    party.lastUpdate = Date.now();

    delete party.users[socket.id];
    socket.leave(partyId);
    socket.partyId = null;

    const remainingUsers = Object.values(party.users);

    if (remainingUsers.length === 0) {
        // Party survives emptiness! Pause playback and save exact timestamp to PostgreSQL
        party.state = 'paused';
        await persistParty(partyId);
    } else {
        // Priority Succession if Owner leaves while others are still watching
        const hasOnlineOwner = remainingUsers.some(u => u.role === ROLES.OWNER);
        if (!hasOnlineOwner) {
            remainingUsers.sort((a, b) => ROLE_LEVEL[b.role] - ROLE_LEVEL[a.role]);
            const nextInLine = remainingUsers[0];
            nextInLine.role = ROLES.OWNER;
            await db.setUserRole(partyId, nextInLine.userId, ROLES.OWNER);
            io.to(nextInLine.id).emit('role_updated', ROLES.OWNER);
        }
        broadcastRoster(partyId);
        await persistParty(partyId);
    }

    await broadcastDashboardUpdate();
}

io.on('connection', (socket) => {

    // 1. AUTHENTICATE & LOAD DASHBOARD
    socket.on('authenticate', async (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const userInDb = await db.findUserByUsername(decoded.username);
            if (!userInDb || userInDb.id !== decoded.userId) {
                return socket.emit('auth_error', 'Account not found. Please log in again.');
            }
            socket.userId = userInDb.id;
            socket.username = userInDb.username;

            if (!onlineUsers[socket.userId]) onlineUsers[socket.userId] = new Set();
            onlineUsers[socket.userId].add(socket.id);

            const dashboardParties = await buildDashboardPayload(socket.userId);
            const friends = await db.getFriends(socket.userId);

            socket.emit('auth_success', {
                userId: userInDb.id,
                username: userInDb.username,
                parties: dashboardParties,
                friends
            });
        } catch (err) {
            socket.emit('auth_error', 'Session expired. Please log in again.');
        }
    });

    socket.on('request_dashboard', async () => {
        if (!socket.userId) return;
        const payload = await buildDashboardPayload(socket.userId);
        socket.emit('dashboard_data', payload);
    });

    // 2. CREATE PARTY & QUICK PARTY
    socket.on('create_party', async ({ partyName, isPublic, isQuick, invitedFriendIds }) => {
        if (!socket.userId) return;

        const prefix = isQuick ? 'QUICK' : 'PTY';
        const partyId = generatePartyId(prefix);
        const cleanName = isQuick ? `Quick Party (${partyId.split('-')[1]})` : (partyName || 'Watch Party').trim();

        parties[partyId] = {
            partyId,
            partyName: cleanName,
            ownerUserId: socket.userId,
            ownerUsername: socket.username,
            isPublic: isQuick ? false : Boolean(isPublic),
            videoSource: 'youtube',
            videoId: '8hP9D6kZseM',
            videoTitle: 'Interstellar Official Trailer',
            state: 'paused',
            time: 0,
            lastUpdate: Date.now(),
            queue: [],
            chatHistory: [],
            lastQueuePop: 0,
            users: {}
        };

        await persistParty(partyId);
        await db.setUserRole(partyId, socket.userId, ROLES.OWNER);
        await admitUserToParty(socket, partyId, ROLES.OWNER);

        // Send live invites to selected friends
        if (Array.isArray(invitedFriendIds)) {
            for (const fid of invitedFriendIds) {
                await db.setUserRole(partyId, Number(fid), ROLES.MEMBER);
                const friendSockets = onlineUsers[Number(fid)];
                if (friendSockets) {
                    friendSockets.forEach(sid => {
                        io.to(sid).emit('party_invite', {
                            partyId,
                            partyName: cleanName,
                            fromUsername: socket.username
                        });
                    });
                }
            }
        }
    });

    // 3. JOIN PARTY (Public OR Existing Member OR Knock)
    socket.on('join_party', async ({ partyId }) => {
        if (!socket.userId) return;
        const cleanId = (partyId || '').trim().toUpperCase();
        const party = parties[cleanId];
        if (!party) return socket.emit('party_error', `Party "${cleanId}" does not exist.`);

        const isOwner = Number(party.ownerUserId) === Number(socket.userId);
        const savedRole = await db.getUserRole(cleanId, socket.userId);

        // Public party OR already a member of this private party -> Enter immediately!
        if (party.isPublic || isOwner || savedRole) {
            await admitUserToParty(socket, cleanId, ROLES.MEMBER);
        } else {
            // Private party & not a member yet -> Request Owner/Admin permission
            const activeUsers = Object.values(party.users);
            const moderators = activeUsers.filter(u => ROLE_LEVEL[u.role] >= ROLE_LEVEL.ADMIN);

            if (moderators.length === 0) {
                return socket.emit('party_error', 'This Private Party currently has no Owner/Admin inside to approve your request.');
            }
            moderators.sort((a, b) => ROLE_LEVEL[b.role] - ROLE_LEVEL[a.role]);
            const approver = moderators[0];

            socket.emit('party_notice', `Knock sent! Waiting for ${approver.username} to approve...`);
            io.to(approver.id).emit('knock_request', {
                requesterId: socket.id,
                requesterUserId: socket.userId,
                username: socket.username,
                partyId: cleanId
            });
        }
    });

    socket.on('resolve_knock', async ({ requesterId, approved }) => {
        const party = parties[socket.partyId];
        const actor = party?.users[socket.id];
        if (!party || !actor || ROLE_LEVEL[actor.role] < ROLE_LEVEL.ADMIN) return;

        const requesterSocket = io.sockets.sockets.get(requesterId);
        if (!requesterSocket) return;

        if (approved) {
            await admitUserToParty(requesterSocket, socket.partyId, ROLES.MEMBER);
        } else {
            requesterSocket.emit('party_error', 'Your request to join the private party was declined.');
        }
    });

    socket.on('leave_party', async () => {
        await handleLeaveParty(socket);
        const payload = await buildDashboardPayload(socket.userId);
        socket.emit('dashboard_data', payload);
    });

    // 4. DELETE PARTY (Owner Only)
    socket.on('delete_party', async ({ partyId }) => {
        const party = parties[partyId];
        if (!party || Number(party.ownerUserId) !== Number(socket.userId)) {
            return socket.emit('party_error', 'Only the Party Creator can delete this party.');
        }

        io.to(partyId).emit('kicked_from_party', `The party "${party.partyName}" was deleted by the Owner.`);
        const socketsInParty = await io.in(partyId).fetchSockets();
        socketsInParty.forEach(s => {
            s.leave(partyId);
            s.partyId = null;
        });

        delete parties[partyId];
        await db.deleteParty(partyId);
        await broadcastDashboardUpdate();
    });

    // 5. FRIENDS & LIVE PARTY INVITES
    socket.on('add_friend', async (friendUserId) => {
        if (!socket.userId) return;
        await db.addFriend(socket.userId, Number(friendUserId));
        const friends = await db.getFriends(socket.userId);
        socket.emit('friends_updated', friends);
    });

    socket.on('remove_friend', async (friendUserId) => {
        if (!socket.userId) return;
        await db.removeFriend(socket.userId, Number(friendUserId));
        const friends = await db.getFriends(socket.userId);
        socket.emit('friends_updated', friends);
    });

    socket.on('invite_friend_to_party', async ({ friendUserId }) => {
        const party = parties[socket.partyId];
        const actor = party?.users[socket.id];
        if (!party || !actor || ROLE_LEVEL[actor.role] < ROLE_LEVEL.ADMIN) return;

        // Pre-authorize friend in party_roles so they bypass knocking!
        await db.setUserRole(party.partyId, Number(friendUserId), ROLES.MEMBER);

        const friendSockets = onlineUsers[Number(friendUserId)];
        if (friendSockets) {
            friendSockets.forEach(sid => {
                io.to(sid).emit('party_invite', {
                    partyId: party.partyId,
                    partyName: party.partyName,
                    fromUsername: socket.username
                });
            });
        }
    });

    // 6. RBAC MODERATION
    socket.on('moderate_user', async ({ targetId, action, newRole }) => {
        const party = parties[socket.partyId];
        if (!party) return;

        const actor = party.users[socket.id];
        const target = party.users[targetId];
        if (!actor || !target || socket.id === targetId) return;

        if (ROLE_LEVEL[actor.role] < ROLE_LEVEL.ADMIN || ROLE_LEVEL[actor.role] <= ROLE_LEVEL[target.role]) return;
        const targetSocket = io.sockets.sockets.get(targetId);

        switch (action) {
            case 'set_role':
                if (!ROLE_LEVEL[newRole] || newRole === ROLES.OWNER) return;
                if (ROLE_LEVEL[actor.role] === ROLE_LEVEL.ADMIN && ROLE_LEVEL[newRole] >= ROLE_LEVEL.ADMIN) return;
                target.role = newRole;
                await db.setUserRole(socket.partyId, target.userId, newRole);
                if (targetSocket) targetSocket.emit('role_updated', newRole);
                break;

            case 'toggle_chat':
                target.chatRestricted = !target.chatRestricted;
                if (targetSocket) targetSocket.emit('chat_restriction_updated', target.chatRestricted);
                break;

            case 'toggle_call_mute':
                target.callMuted = !target.callMuted;
                if (targetSocket) targetSocket.emit('force_mute_status', target.callMuted);
                break;

            case 'remove_from_call':
                target.inCall = false;
                if (targetSocket) {
                    if (targetSocket.peerId) {
                        io.to(socket.partyId).emit('user_left_video', targetSocket.peerId);
                        targetSocket.peerId = null;
                    }
                    targetSocket.emit('force_leave_call');
                }
                break;

            case 'kick_from_room':
                if (targetSocket) {
                    await handleLeaveParty(targetSocket);
                    targetSocket.emit('kicked_from_party', `You were removed from the party by ${actor.username}.`);
                }
                break;
        }
        broadcastRoster(socket.partyId);
    });

    // 7. MULTI-SOURCE MEDIA SYNC (YouTube, TMDB, Direct URL, Local File Stream)
    socket.on('play_video', async (time) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        party.state = 'playing';
        party.time = Number(time) || 0;
        party.lastUpdate = Date.now();
        socket.to(socket.partyId).emit('sync_play', party.time);
        await persistParty(socket.partyId);
    });

    socket.on('pause_video', async (time) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        party.state = 'paused';
        party.time = Number(time) || 0;
        party.lastUpdate = Date.now();
        socket.to(socket.partyId).emit('sync_pause', party.time);
        await persistParty(socket.partyId);
    });

    socket.on('change_media_source', async ({ videoSource, videoId, videoTitle, streamPeerId }) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.CURATOR) return;

        party.videoSource = videoSource; // 'youtube' | 'url' | 'local'
        party.videoId = videoId;
        party.videoTitle = videoTitle || 'Custom Media Stream';
        party.time = 0;
        party.state = 'playing';
        party.lastUpdate = Date.now();

        await persistParty(socket.partyId);
        io.to(socket.partyId).emit('load_new_media', {
            videoSource: party.videoSource,
            videoId: party.videoId,
            videoTitle: party.videoTitle,
            streamPeerId: streamPeerId || null
        });
    });

    // 8. SEARCH (YOUTUBE + TMDB MOVIES) & QUEUE
    socket.on('search_media', async ({ query, source }) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.CURATOR) return;

        try {
            let searchQuery = query;
            let isTmdb = (source === 'tmdb');

            // If user has a TMDB_API_KEY configured, fetch official TMDB movie metadata first
            if (isTmdb && process.env.TMDB_API_KEY) {
                const tmdbUrl = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(query)}`;
                const tmdbRes = await fetch(tmdbUrl);
                const tmdbData = await tmdbRes.json();
                if (tmdbData.results && tmdbData.results.length > 0) {
                    const topMovies = tmdbData.results.slice(0, 5);
                    const results = [];
                    for (const m of topMovies) {
                        // Resolve playable YouTube trailer/full stream ID for the TMDB movie
                        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=${encodeURIComponent(m.title + ' ' + (m.release_date || '').slice(0, 4) + ' trailer')}&type=video&key=${process.env.YOUTUBE_API_KEY}`;
                        const ytRes = await fetch(ytUrl);
                        const ytData = await ytRes.json();
                        const vidId = ytData.items?.[0]?.id?.videoId || '8hP9D6kZseM';
                        results.push({
                            videoId: vidId,
                            title: `🎬 ${m.title} (${(m.release_date || 'N/A').slice(0, 4)}) - ★ ${m.vote_average || 'N/A'}`,
                            thumb: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : (ytData.items?.[0]?.snippet?.thumbnails?.default?.url || '')
                        });
                    }
                    return socket.emit('search_results', results);
                }
            }

            // Standard YouTube Search (or Automatic TMDB Fallback via YouTube Movie Search)
            if (isTmdb) searchQuery = `${query} official movie trailer`;
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(searchQuery)}&type=video&key=${process.env.YOUTUBE_API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            if (data.items) {
                const formatted = data.items.map(item => ({
                    videoId: item.id.videoId,
                    title: isTmdb ? `🎬 [TMDB] ${item.snippet.title}` : item.snippet.title,
                    thumb: item.snippet.thumbnails.default.url
                }));
                socket.emit('search_results', formatted);
            }
        } catch (error) {
            console.error("Media Search Error:", error);
        }
    });

    socket.on('add_to_queue', async (videoData) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.CURATOR) return;

        party.queue.push({
            videoSource: videoData.videoSource || 'youtube',
            videoId: videoData.videoId,
            title: videoData.title
        });
        await persistParty(socket.partyId);
        io.to(socket.partyId).emit('update_queue', party.queue);
    });

    socket.on('skip_video', async () => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        if (party.queue.length > 0) {
            const nextVideo = party.queue.shift();
            party.videoSource = nextVideo.videoSource || 'youtube';
            party.videoId = nextVideo.videoId;
            party.videoTitle = nextVideo.title;
            party.time = 0;
            party.state = 'playing';
            party.lastUpdate = Date.now();
            party.lastQueuePop = Date.now();

            await persistParty(socket.partyId);
            io.to(socket.partyId).emit('load_new_media', {
                videoSource: party.videoSource,
                videoId: party.videoId,
                videoTitle: party.videoTitle
            });
            io.to(socket.partyId).emit('update_queue', party.queue);
        }
    });

    socket.on('video_ended', async () => {
        const party = parties[socket.partyId];
        if (!party || Date.now() - party.lastQueuePop < 5000) return;

        if (party.queue.length > 0) {
            const nextVideo = party.queue.shift();
            party.videoSource = nextVideo.videoSource || 'youtube';
            party.videoId = nextVideo.videoId;
            party.videoTitle = nextVideo.title;
            party.time = 0;
            party.state = 'playing';
            party.lastUpdate = Date.now();
            party.lastQueuePop = Date.now();

            await persistParty(socket.partyId);
            io.to(socket.partyId).emit('load_new_media', {
                videoSource: party.videoSource,
                videoId: party.videoId,
                videoTitle: party.videoTitle
            });
            io.to(socket.partyId).emit('update_queue', party.queue);
        }
    });

    // 9. PERSISTENT LIVE CHAT
    socket.on('chat_message', async (text) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || user.chatRestricted) return;

        const msgObj = {
            sender: user.username,
            text: String(text).slice(0, 400),
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        party.chatHistory.push(msgObj);
        if (party.chatHistory.length > 100) party.chatHistory.shift();

        io.to(socket.partyId).emit('chat_message', msgObj);
        await persistParty(socket.partyId);
    });

    // 10. WEBRTC VIDEO CALL SIGNALING
    socket.on('join_video_call', (peerId) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user) return;

        socket.peerId = peerId;
        user.inCall = true;
        broadcastRoster(socket.partyId);

        if (user.callMuted) socket.emit('force_mute_status', true);
        socket.to(socket.partyId).emit('user_joined_video', { peerId, username: user.username });
    });

    socket.on('leave_video_call', () => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !socket.peerId) return;

        if (user) user.inCall = false;
        socket.to(socket.partyId).emit('user_left_video', socket.peerId);
        socket.peerId = null;
        broadcastRoster(socket.partyId);
    });

    // 11. DISCONNECT
    socket.on('disconnect', async () => {
        if (socket.userId && onlineUsers[socket.userId]) {
            onlineUsers[socket.userId].delete(socket.id);
        }
        await handleLeaveParty(socket);
    });
});

// ==========================================
// 3. BOOT & HYDRATE FROM POSTGRESQL
// ==========================================
async function startServer() {
    try {
        await db.initDB();
        const savedParties = await db.getAllParties();
        savedParties.forEach(p => {
            parties[p.party_id] = {
                partyId: p.party_id,
                partyName: p.party_name,
                ownerUserId: p.owner_user_id,
                ownerUsername: p.owner_username || 'Creator',
                isPublic: Boolean(p.is_public),
                videoSource: p.video_source || 'youtube',
                videoId: p.video_id || '8hP9D6kZseM',
                videoTitle: p.video_title || 'Saved Video',
                state: 'paused',
                time: Number(p.last_time) || 0,
                lastUpdate: Date.now(),
                queue: Array.isArray(p.queue_json) ? p.queue_json : [],
                chatHistory: Array.isArray(p.chat_json) ? p.chat_json : [],
                lastQueuePop: 0,
                users: {}
            };
        });
        console.log(`Hydrated ${savedParties.length} persistent parties from PostgreSQL.`);

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => console.log(`Production server running on port ${PORT}`));
    } catch (err) {
        console.error("Failed to start server:", err);
        process.exit(1);
    }
}

startServer();