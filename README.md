# ⚡ PulseParty

**A Distributed Real-Time Synchronized Cinema & Social Streaming Platform**

![Node.js](https://img.shields.io/badge/Node.js-v20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-WebSockets-010101?style=flat-square&logo=socketdotio&logoColor=white)
![WebRTC](https://img.shields.io/badge/WebRTC-PeerJS-333333?style=flat-square&logo=webrtc&logoColor=white)
![Latency](https://img.shields.io/badge/p95_Latency-21ms-10b981?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

**PulseParty** is a full-stack social watch-party engine designed to solve the core challenges of multi-user media synchronization: network jitter, abrupt frame-seeking stutters, ephemeral room loss, and local media buffering bottlenecks. 

Built on a hybrid **In-Memory Write-Through Cache + PostgreSQL (`JSONB`)** architecture, PulseParty unifies YouTube streams, TMDB movie discovery, direct web streams, and HTTP `206 Partial Content` local video chunking under a single low-latency control plane, paired with peer-to-peer WebRTC voice/video calls and a persistent social graph.

---

## ✨ Core Capabilities

* **Elastic Phase-Locked Synchronization:** Eliminates jarring `seekTo()` cuts during minor network fluctuations by dynamically scaling client playback rates (`0.95x`–`1.05x`) against a 2.5-second authoritative server heartbeat.
* **4-Pipeline Media Engine:** Seamlessly switches between **YouTube IFrame Streams**, **TMDB/Curated Movie Discovery** (with genre filtering and typo-tolerant bigram fuzzy search), **Direct Web Streams (`.mp4`/`.webm`)**, and **Chunked Local Video Files** served via HTTP byte-range requests.
* **Immortal Party State:** Parties survive emptiness and server reboots. When the last participant leaves, the exact playback timestamp, FIFO Up-Next queue, LIFO Watch History stack, and chat logs flush to PostgreSQL and hydrate on re-entry.
* **4-Tier Hierarchical RBAC & Auto-Succession:** Granular permissions across **Owner**, **Admin**, **Curator**, and **Member** ranks, featuring private room knock-to-join workflows, live moderation toolbars, manual host transfer, and automatic priority succession on host disconnect.
* **Social Graph & Interactive Lounge:** Universal search for users and parties, Discord-style full-page user profiles, instant `?party=PTY-XXXXXX` deep-link invitations, real-time group polls, floating emoji reactions, and a collapsible right-edge WebRTC video call drawer.
* **Adaptive Cinema UI:** Distraction-free dark obsidian interface with Theater & Fullscreen modes, a translucent Twitch-style live chat overlay, Lights-Out ambient dimming, and 3-second idle control auto-hiding.

---

## 🏗️ System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT BROWSER LAYER                             │
│  ┌──────────────────────┐  ┌─────────────────────┐  ┌───────────────────┐  │
│  │ Unified Media Player │  │  Social & Room UI   │  │ WebRTC Mesh (P2P) │  │
│  │ • YouTube IFrame API │  │ • Theater Chat HUD  │  │ • PeerJS Audio/   │  │
│  │ • HTML5 Range Player │  │ • Live Group Polls  │  │   Video Streams   │  │
│  │ • Elastic PLL Sync   │  │ • Telemetry Monitor │  │ • Server Mute/Kick│  │
│  └──────────┬───────────┘  └──────────┬──────────┘  └─────────┬─────────┘  │
└─────────────┼─────────────────────────┼───────────────────────┼────────────┘
              │ HTTP 206 (2MB Chunks)   │ WebSockets (Socket.io)│ WebRTC
              ▼                         ▼                       ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        NODE.JS / EXPRESS CORE ENGINE                       │
│  ┌──────────────────────┐  ┌────────────────────────────────────────────┐  │
│  │ Byte-Range Streamer  │  │
