const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/watchparty'
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash TEXT,
            oauth_id TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS parties (
            party_id VARCHAR(50) PRIMARY KEY,
            party_name VARCHAR(100) NOT NULL,
            owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            is_public BOOLEAN DEFAULT TRUE,
            video_source VARCHAR(20) DEFAULT 'youtube',
            video_id TEXT DEFAULT '8hP9D6kZseM',
            video_title TEXT DEFAULT 'Interstellar Official Trailer',
            last_time REAL DEFAULT 0,
            queue_json JSONB DEFAULT '[]'::jsonb,
            chat_json JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS party_roles (
            party_id VARCHAR(50) REFERENCES parties(party_id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL,
            PRIMARY KEY (party_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS friendships (
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            status VARCHAR(20) DEFAULT 'accepted',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, friend_id)
        );
    `);
    console.log("PostgreSQL WP-200 Social & Persistent Party tables initialized.");
}

module.exports = {
    pool,
    initDB,

    // User Queries
    async findUserByUsername(username) {
        const res = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        return res.rows[0];
    },
    async findUserById(id) {
        const res = await pool.query('SELECT id, username, created_at FROM users WHERE id = $1', [id]);
        return res.rows[0];
    },
    async createUser(username, passwordHash, oauthId = null) {
        const res = await pool.query(
            'INSERT INTO users (username, password_hash, oauth_id) VALUES ($1, $2, $3) RETURNING id, username, created_at',
            [username, passwordHash, oauthId]
        );
        return res.rows[0];
    },
    async searchUsers(query) {
        const res = await pool.query(
            'SELECT id, username, created_at FROM users WHERE username ILIKE $1 LIMIT 15',
            [`%${query}%`]
        );
        return res.rows;
    },

    // Friendship Queries
    async addFriend(userId, friendId) {
        if (Number(userId) === Number(friendId)) return;
        await pool.query(
            `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')
             ON CONFLICT DO NOTHING`,
            [userId, friendId]
        );
    },
    async removeFriend(userId, friendId) {
        await pool.query(
            `DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
            [userId, friendId]
        );
    },
    async getFriends(userId) {
        const res = await pool.query(
            `SELECT u.id, u.username FROM friendships f
             JOIN users u ON f.friend_id = u.id
             WHERE f.user_id = $1`,
            [userId]
        );
        return res.rows;
    },

    // Party Queries
    async getAllParties() {
        const res = await pool.query(`
            SELECT p.*, u.username AS owner_username
            FROM parties p
            LEFT JOIN users u ON p.owner_user_id = u.id
            ORDER BY p.created_at DESC
        `);
        return res.rows;
    },
    async saveParty(p) {
        await pool.query(
            `INSERT INTO parties (party_id, party_name, owner_user_id, is_public, video_source, video_id, video_title, last_time, queue_json, chat_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
             ON CONFLICT (party_id) DO UPDATE SET
                party_name = EXCLUDED.party_name,
                owner_user_id = EXCLUDED.owner_user_id,
                is_public = EXCLUDED.is_public,
                video_source = EXCLUDED.video_source,
                video_id = EXCLUDED.video_id,
                video_title = EXCLUDED.video_title,
                last_time = EXCLUDED.last_time,
                queue_json = EXCLUDED.queue_json,
                chat_json = EXCLUDED.chat_json`,
            [
                p.partyId,
                p.partyName,
                p.ownerUserId,
                Boolean(p.isPublic),
                p.videoSource || 'youtube',
                p.videoId || '8hP9D6kZseM',
                p.videoTitle || 'Default Video',
                Number(p.time) || 0,
                JSON.stringify(p.queue || []),
                JSON.stringify((p.chatHistory || []).slice(-100))
            ]
        );
    },
    async deleteParty(partyId) {
        await pool.query('DELETE FROM parties WHERE party_id = $1', [partyId]);
    },

    // Party Membership & RBAC Queries
    async getUserRole(partyId, userId) {
        const res = await pool.query(
            'SELECT role FROM party_roles WHERE party_id = $1 AND user_id = $2',
            [partyId, userId]
        );
        return res.rows[0];
    },
    async setUserRole(partyId, userId, role) {
        await pool.query(
            `INSERT INTO party_roles (party_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (party_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [partyId, userId, role]
        );
    },
    async getUserParties(userId) {
        const res = await pool.query(
            `SELECT p.party_id, p.party_name, p.is_public, p.owner_user_id, pr.role
             FROM party_roles pr
             JOIN parties p ON pr.party_id = p.party_id
             WHERE pr.user_id = $1`,
            [userId]
        );
        return res.rows;
    },
    async getAllMembershipsForUser(userId) {
        const res = await pool.query('SELECT party_id, role FROM party_roles WHERE user_id = $1', [userId]);
        return res.rows;
    }
};