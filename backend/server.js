require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'watch-party-super-secret-key-2026';

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const ROLES = { MEMBER: 'member', CURATOR: 'curator', ADMIN: 'admin', OWNER: 'owner' };
const ROLE_LEVEL = { member: 1, curator: 2, admin: 3, owner: 4 };

const parties = {};
const onlineUsers = {};

// Built-in Curated Movie Discovery Catalog (Supports Categories, Rating Filters & Fuzzy Search)
const CURATED_MOVIES = [
    { videoId: 'zSWdZVtXT7E', title: 'Interstellar', category: 'Sci-Fi', year: 2014, rating: 8.7, thumb: 'https://img.youtube.com/vi/zSWdZVtXT7E/mqdefault.jpg' },
    { videoId: 'YoHD9XEInc0', title: 'Inception', category: 'Sci-Fi', year: 2010, rating: 8.8, thumb: 'https://img.youtube.com/vi/YoHD9XEInc0/mqdefault.jpg' },
    { videoId: 'LdOM0x0XDMo', title: 'Tenet', category: 'Sci-Fi', year: 2020, rating: 7.3, thumb: 'https://img.youtube.com/vi/LdOM0x0XDMo/mqdefault.jpg' },
    { videoId: 'uYPbbksJxIg', title: 'Oppenheimer', category: 'Thriller', year: 2023, rating: 8.9, thumb: 'https://img.youtube.com/vi/uYPbbksJxIg/mqdefault.jpg' },
    { videoId: 'EXeTwQWrcwY', title: 'The Dark Knight', category: 'Action', year: 2008, rating: 9.0, thumb: 'https://img.youtube.com/vi/EXeTwQWrcwY/mqdefault.jpg' },
    { videoId: 'hEJnMQG9ev8', title: 'Mad Max: Fury Road', category: 'Action', year: 2015, rating: 8.1, thumb: 'https://img.youtube.com/vi/hEJnMQG9ev8/mqdefault.jpg' },
    { videoId: 'qEVUtrk8_B4', title: 'John Wick: Chapter 4', category: 'Action', year: 2023, rating: 7.7, thumb: 'https://img.youtube.com/vi/qEVUtrk8_B4/mqdefault.jpg' },
    { videoId: 'v4yLeNt-kCU', title: 'Chainsaw Man — Official Feature', category: 'Anime', year: 2022, rating: 8.5, thumb: 'https://img.youtube.com/vi/v4yLeNt-kCU/mqdefault.jpg' },
    { videoId: 'Poo5lqoWSGw', title: 'One-Punch Man Opening Feature', category: 'Anime', year: 2015, rating: 8.7, thumb: 'https://img.youtube.com/vi/Poo5lqoWSGw/mqdefault.jpg' },
    { videoId: '1ZdlAg3j8nI', title: 'Bleach: Thousand-Year Blood War', category: 'Anime', year: 2022, rating: 9.0, thumb: 'https://img.youtube.com/vi/1ZdlAg3j8nI/mqdefault.jpg' },
    { videoId: 'Way9Dexny3w', title: 'Dune: Part Two', category: 'Sci-Fi', year: 2024, rating: 8.6, thumb: 'https://img.youtube.com/vi/Way9Dexny3w/mqdefault.jpg' },
    { videoId: '6ZfuNTqbHE8', title: 'Avengers: Infinity War', category: 'Action', year: 2018, rating: 8.4, thumb: 'https://img.youtube.com/vi/6ZfuNTqbHE8/mqdefault.jpg' },
    { videoId: '5xH0HfJHsaY', title: 'Parasite', category: 'Thriller', year: 2019, rating: 8.5, thumb: 'https://img.youtube.com/vi/5xH0HfJHsaY/mqdefault.jpg' },
    { videoId: 'sY1S34973zA', title: 'The Godfather', category: 'Thriller', year: 1972, rating: 9.2, thumb: 'https://img.youtube.com/vi/sY1S34973zA/mqdefault.jpg' },
    { videoId: 'pBk4NYhWNMM', title: 'The Grand Budapest Hotel', category: 'Comedy', year: 2014, rating: 8.1, thumb: 'https://img.youtube.com/vi/pBk4NYhWNMM/mqdefault.jpg' }
];

// Typo-tolerant Fuzzy Matching Score (Subsequence + Bigram Dice Coefficient)
function fuzzyScore(str, pattern) {
    if (!pattern) return 1;
    const s = str.toLowerCase();
    const p = pattern.toLowerCase();
    if (s.includes(p)) return 1.0;

    // Subsequence check
    let pIdx = 0;
    for (let i = 0; i < s.length && pIdx < p.length; i++) {
        if (s[i] === p[pIdx]) pIdx++;
    }
    if (pIdx === p.length) return 0.8;

    // Bigram overlap for transposed/misspelled letters
    const sBigrams = new Set();
    for (let i = 0; i < s.length - 1; i++) sBigrams.add(s.slice(i, i + 2));
    let matches = 0;
    for (let i = 0; i < p.length - 1; i++) {
        if (sBigrams.has(p.slice(i, i + 2))) matches++;
    }
    return p.length > 1 ? matches / (p.length - 1) : 0;
}

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

function pushToHistory(party) {
    if (!party || !party.videoId) return;
    if (!Array.isArray(party.history)) party.history = [];
    const top = party.history[party.history.length - 1];
    if (!top || top.videoId !== party.videoId) {
        party.history.push({
            videoSource: party.videoSource || 'youtube',
            videoId: party.videoId,
            title: party.videoTitle || 'Watched Video'
        });
        if (party.history.length > 50) party.history.shift();
    }
}

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
            myRole: roleMap[p.partyId] || (Number(p.ownerUserId) === Number(userId) ? 'owner' : null)
        };
    });

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
    const userList = Object.values(p.users);
    const callCount = userList.filter(u => u.inCall).length;
    io.to(partyId).emit('update_roster', { users: userList, callCount });
}

// ==========================================
// 1. REST API: AUTH, MOVIES, SEARCH, PROFILES & CHUNKED STREAMING
// ==========================================
app.post('/api/auth', async (req, res) => {
    try {
        const { username, password, mode } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const cleanUser = username.trim();
        const existing = await db.findUserByUsername(cleanUser);

        if (mode === 'register') {
            if (existing) return res.status(400).json({ error: 'Username already taken. Please Sign In.' });
            const hash = await bcrypt.hash(password, 10);
            const newUser = await db.createUser(cleanUser, hash, null);
            const token = jwt.sign({ userId: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token, userId: newUser.id, username: newUser.username });
        } else {
            if (!existing || !(await bcrypt.compare(password, existing.password_hash))) {
                return res.status(401).json({ error: 'Invalid credentials.' });
            }
            const token = jwt.sign({ userId: existing.id, username: existing.username }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token, userId: existing.id, username: existing.username });
        }
    } catch (err) {
        res.status(500).json({ error: 'Server error during authentication.' });
    }
});

// Movie Recommendations with Category, Rating Filter & Fuzzy Search
app.get('/api/movies', (req, res) => {
    const category = req.query.category || 'All';
    const minRating = parseFloat(req.query.minRating) || 0;
    const query = (req.query.q || '').trim();

    let results = CURATED_MOVIES.filter(m => {
        if (category !== 'All' && m.category.toLowerCase() !== category.toLowerCase()) return false;
        if (m.rating < minRating) return false;
        return true;
    });

    if (query) {
        results = results
            .map(m => ({ ...m, score: Math.max(fuzzyScore(m.title, query), fuzzyScore(m.category, query)) }))
            .filter(m => m.score >= 0.42)
            .sort((a, b) => b.score - a.score);
    }

    res.json(results);
});

app.post('/api/upload-local', (req, res) => {
    const rawName = req.headers['x-file-name'] || 'movie.mp4';
    const safeExt = path.extname(decodeURIComponent(rawName)).replace(/[^a-zA-Z0-9.]/g, '') || '.mp4';
    const filename = `local-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${safeExt}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);

    writeStream.on('finish', () => {
        res.json({
            streamUrl: `/api/stream/${filename}`,
            title: decodeURIComponent(rawName)
        });
    });

    writeStream.on('error', () => {
        res.status(500).json({ error: 'Failed to stream local file to server' });
    });
});

app.get('/api/stream/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(UPLOADS_DIR, safeName);

    if (!fs.existsSync(filePath)) return res.status(404).send('Video file not found');

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(safeName).toLowerCase();
    const mimeTypes = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.mkv': 'video/x-matroska' };
    const contentType = mimeTypes[ext] || 'video/mp4';

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const CHUNK_SIZE = 2 * 1024 * 1024;
        const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + CHUNK_SIZE, fileSize - 1);
        const contentLength = (end - start) + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': contentLength,
            'Content-Type': contentType
        });

        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim().toLowerCase();
        if (!q) return res.json({ parties: [], users: [] });

        const matchedParties = Object.values(parties)
            .filter(p => fuzzyScore(p.partyName, q) >= 0.5 || p.partyId.toLowerCase().includes(q))
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
// 2. AUTHORITATIVE ELASTIC SYNC HEARTBEAT (Every 2.5 Seconds)
// ==========================================
setInterval(() => {
    for (const [partyId, party] of Object.entries(parties)) {
        if (Object.keys(party.users).length > 0 && party.state === 'playing') {
            io.to(partyId).emit('sync_heartbeat', {
                state: party.state,
                time: getCurrentPartyTime(party),
                serverTimestamp: Date.now()
            });
        }
    }
}, 2500);

// ==========================================
// 3. SOCKET.IO REAL-TIME ENGINE
// ==========================================
async function admitUserToParty(targetSocket, partyId, defaultRole = ROLES.MEMBER) {
    const party = parties[partyId];
    if (!party) return;

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

    const userList = Object.values(party.users);
    const callCount = userList.filter(u => u.inCall).length;

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
        history: party.history || [],
        chatHistory: party.chatHistory,
        activePoll: party.activePoll || null,
        callCount
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

    party.time = getCurrentPartyTime(party);
    party.lastUpdate = Date.now();

    delete party.users[socket.id];
    socket.leave(partyId);
    socket.partyId = null;

    const remainingUsers = Object.values(party.users);

    if (remainingUsers.length === 0) {
        party.state = 'paused';
        await persistParty(partyId);
    } else {
        const hasOnlineOwner = remainingUsers.some(u => u.role === ROLES.OWNER);
        if (!hasOnlineOwner) {
            remainingUsers.sort((a, b) => ROLE_LEVEL[b.role] - ROLE_LEVEL[a.role]);
            const nextInLine = remainingUsers[0];
            nextInLine.role = ROLES.OWNER;
            party.ownerUserId = nextInLine.userId;
            await db.setUserRole(partyId, nextInLine.userId, ROLES.OWNER);
            io.to(nextInLine.id).emit('role_updated', ROLES.OWNER);
        }
        broadcastRoster(partyId);
        await persistParty(partyId);
    }

    await broadcastDashboardUpdate();
}

io.on('connection', (socket) => {

    // High-Precision Latency & Telemetry Ping
    socket.on('latency_ping', (clientSentTime) => {
        socket.emit('latency_pong', clientSentTime);
    });

    socket.on('authenticate', async (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const userInDb = await db.findUserByUsername(decoded.username);
            if (!userInDb || userInDb.id !== decoded.userId) {
                return socket.emit('auth_error', 'Account not found. Please sign in again.');
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
                createdAt: userInDb.created_at,
                parties: dashboardParties,
                friends
            });
        } catch (err) {
            socket.emit('auth_error', 'Session expired. Please sign in again.');
        }
    });

    socket.on('request_dashboard', async () => {
        if (!socket.userId) return;
        const payload = await buildDashboardPayload(socket.userId);
        socket.emit('dashboard_data', payload);
    });

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
            history: [],
            chatHistory: [],
            activePoll: null,
            lastQueuePop: 0,
            users: {}
        };

        await persistParty(partyId);
        await db.setUserRole(partyId, socket.userId, ROLES.OWNER);
        await admitUserToParty(socket, partyId, ROLES.OWNER);

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

    socket.on('join_party', async ({ partyId }) => {
        if (!socket.userId) return;
        const cleanId = (partyId || '').trim().toUpperCase();
        const party = parties[cleanId];
        if (!party) return socket.emit('party_error', `Party "${cleanId}" does not exist.`);

        const isOwner = Number(party.ownerUserId) === Number(socket.userId);
        const savedRole = await db.getUserRole(cleanId, socket.userId);

        if (party.isPublic || isOwner || savedRole) {
            await admitUserToParty(socket, cleanId, ROLES.MEMBER);
        } else {
            const activeUsers = Object.values(party.users);
            const moderators = activeUsers.filter(u => ROLE_LEVEL[u.role] >= ROLE_LEVEL.ADMIN);

            if (moderators.length === 0) {
                return socket.emit('party_error', 'This Private Party currently has no Owner/Admin inside to approve your request.');
            }
            moderators.sort((a, b) => ROLE_LEVEL[b.role] - ROLE_LEVEL[a.role]);
            const approver = moderators[0];

            socket.emit('party_notice', `Access request sent to ${approver.username}...`);
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

    // RBAC Moderation + Explicit Manual Host Transfer
    socket.on('moderate_user', async ({ targetId, action, newRole }) => {
        const party = parties[socket.partyId];
        if (!party) return;

        const actor = party.users[socket.id];
        const target = party.users[targetId];
        if (!actor || !target || socket.id === targetId) return;

        const targetSocket = io.sockets.sockets.get(targetId);

        // Explicit Host Transfer (Owner Only)
        if (action === 'transfer_ownership') {
            if (actor.role !== ROLES.OWNER) return;
            actor.role = ROLES.ADMIN;
            target.role = ROLES.OWNER;
            party.ownerUserId = target.userId;

            await db.setUserRole(socket.partyId, actor.userId, ROLES.ADMIN);
            await db.setUserRole(socket.partyId, target.userId, ROLES.OWNER);
            await persistParty(socket.partyId);

            socket.emit('role_updated', ROLES.ADMIN);
            if (targetSocket) targetSocket.emit('role_updated', ROLES.OWNER);
            io.to(socket.partyId).emit('chat_message', {
                sender: 'System',
                text: `${actor.username} transferred party ownership to ${target.username}.`,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            broadcastRoster(socket.partyId);
            return;
        }

        if (ROLE_LEVEL[actor.role] < ROLE_LEVEL.ADMIN || ROLE_LEVEL[actor.role] <= ROLE_LEVEL[target.role]) return;

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

    // VIDEO SYNCING (With Propagation Latency Timestamp)
    socket.on('play_video', async ( payload ) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        const time = typeof payload === 'object' ? Number(payload.time) : Number(payload);
        const sentAt = typeof payload === 'object' ? payload.sentAt : Date.now();

        party.state = 'playing';
        party.time = time || 0;
        party.lastUpdate = Date.now();
        socket.to(socket.partyId).emit('sync_play', { time: party.time, sentAt });
        await persistParty(socket.partyId);
    });

    socket.on('pause_video', async ( payload ) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;

        const time = typeof payload === 'object' ? Number(payload.time) : Number(payload);
        const sentAt = typeof payload === 'object' ? payload.sentAt : Date.now();

        party.state = 'paused';
        party.time = time || 0;
        party.lastUpdate = Date.now();
        socket.to(socket.partyId).emit('sync_pause', { time: party.time, sentAt });
        await persistParty(socket.partyId);
    });

    socket.on('change_media_source', async ({ videoSource, videoId, videoTitle }) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.CURATOR) return;

        pushToHistory(party);

        party.videoSource = videoSource;
        party.videoId = videoId;
        party.videoTitle = videoTitle || 'Media Stream';
        party.time = 0;
        party.state = 'playing';
        party.lastUpdate = Date.now();

        await persistParty(socket.partyId);
        io.to(socket.partyId).emit('load_new_media', {
            videoSource: party.videoSource,
            videoId: party.videoId,
            videoTitle: party.videoTitle
        });
        io.to(socket.partyId).emit('update_history', party.history);
    });

    socket.on('previous_video', async (targetHistoryIndex = null) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;
        if (!party.history || party.history.length === 0) return;

        if (party.videoId) {
            party.queue = party.queue.filter(q => q.videoId !== party.videoId);
            party.queue.unshift({
                videoSource: party.videoSource || 'youtube',
                videoId: party.videoId,
                title: party.videoTitle || 'Video'
            });
        }

        let prevVideo;
        if (typeof targetHistoryIndex === 'number' && party.history[targetHistoryIndex]) {
            prevVideo = party.history.splice(targetHistoryIndex, 1)[0];
        } else {
            prevVideo = party.history.pop();
        }

        party.queue = party.queue.filter(q => q.videoId !== prevVideo.videoId);

        party.videoSource = prevVideo.videoSource || 'youtube';
        party.videoId = prevVideo.videoId;
        party.videoTitle = prevVideo.title;
        party.time = 0;
        party.state = 'playing';
        party.lastUpdate = Date.now();

        await persistParty(socket.partyId);

        io.to(socket.partyId).emit('load_new_media', {
            videoSource: party.videoSource,
            videoId: party.videoId,
            videoTitle: party.videoTitle
        });
        io.to(socket.partyId).emit('update_queue', party.queue);
        io.to(socket.partyId).emit('update_history', party.history);
    });

    socket.on('search_media', async ({ query, source }) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.CURATOR) return;

        try {
            let searchQuery = query;
            let isTmdb = (source === 'tmdb');

            if (isTmdb && process.env.TMDB_API_KEY) {
                const tmdbUrl = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(query)}`;
                const tmdbRes = await fetch(tmdbUrl);
                const tmdbData = await tmdbRes.json();
                if (tmdbData.results && tmdbData.results.length > 0) {
                    const topMovies = tmdbData.results.slice(0, 5);
                    const results = [];
                    for (const m of topMovies) {
                        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=1&q=${encodeURIComponent(m.title + ' ' + (m.release_date || '').slice(0, 4) + ' trailer')}&type=video&key=${process.env.YOUTUBE_API_KEY}`;
                        const ytRes = await fetch(ytUrl);
                        const ytData = await ytRes.json();
                        const vidId = ytData.items?.[0]?.id?.videoId || '8hP9D6kZseM';
                        results.push({
                            videoId: vidId,
                            title: `${m.title} (${(m.release_date || 'N/A').slice(0, 4)}) • ★ ${m.vote_average || 'N/A'}`,
                            thumb: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : (ytData.items?.[0]?.snippet?.thumbnails?.default?.url || '')
                        });
                    }
                    return socket.emit('search_results', results);
                }
            }

            if (isTmdb) searchQuery = `${query} official movie trailer`;
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(searchQuery)}&type=video&key=${process.env.YOUTUBE_API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            if (data.items) {
                const formatted = data.items.map(item => ({
                    videoId: item.id.videoId,
                    title: item.snippet.title,
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
            pushToHistory(party);

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
            io.to(socket.partyId).emit('update_history', party.history);
        }
    });

    socket.on('video_ended', async () => {
        const party = parties[socket.partyId];
        if (!party || Date.now() - party.lastQueuePop < 5000) return;

        if (party.queue.length > 0) {
            pushToHistory(party);

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
            io.to(socket.partyId).emit('update_history', party.history);
        }
    });

    // LIVE FLOATING REACTIONS
    socket.on('send_reaction', (reactionType) => {
        const party = parties[socket.partyId];
        if (!party) return;
        io.to(socket.partyId).emit('party_reaction', {
            reaction: reactionType,
            sender: socket.username
        });
    });

    // LIVE GROUP POLLS
    socket.on('create_poll', ({ question, options }) => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || !question || !Array.isArray(options) || options.length < 2) return;

        party.activePoll = {
            id: crypto.randomBytes(4).toString('hex'),
            creator: user.username,
            question: String(question).slice(0, 140),
            options: options.slice(0, 4).map(opt => ({ text: String(opt).slice(0, 80), votes: 0 })),
            voters: {}
        };
        io.to(socket.partyId).emit('poll_updated', party.activePoll);
    });

    socket.on('vote_poll', (optionIndex) => {
        const party = parties[socket.partyId];
        const poll = party?.activePoll;
        if (!party || !poll || !socket.userId) return;

        const prevVote = poll.voters[socket.userId];
        if (typeof prevVote === 'number' && poll.options[prevVote]) {
            poll.options[prevVote].votes = Math.max(0, poll.options[prevVote].votes - 1);
        }

        if (poll.options[optionIndex]) {
            poll.options[optionIndex].votes += 1;
            poll.voters[socket.userId] = optionIndex;
            io.to(socket.partyId).emit('poll_updated', poll);
        }
    });

    socket.on('close_poll', () => {
        const party = parties[socket.partyId];
        const user = party?.users[socket.id];
        if (!party || !user || ROLE_LEVEL[user.role] < ROLE_LEVEL.ADMIN) return;
        party.activePoll = null;
        io.to(socket.partyId).emit('poll_updated', null);
    });

    // LIVE CHAT
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

    // WEBRTC VIDEO CALL SIGNALING
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

    socket.on('disconnect', async () => {
        if (socket.userId && onlineUsers[socket.userId]) {
            onlineUsers[socket.userId].delete(socket.id);
        }
        await handleLeaveParty(socket);
    });
});

// ==========================================
// 4. BOOT & HYDRATE FROM POSTGRESQL
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
                history: Array.isArray(p.history_json) ? p.history_json : [],
                chatHistory: Array.isArray(p.chat_json) ? p.chat_json : [],
                activePoll: null,
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