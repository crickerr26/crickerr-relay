/**
 * CRICKERR → FACEBOOK LIVE RELAY SERVER (FIXED)
 * Browser MediaRecorder (WebM) → FFmpeg → RTMPS → Facebook Live
 *
 * KEY FIX: Browser sends WebM via MediaRecorder, NOT raw H264.
 * FFmpeg now reads WebM from stdin and re-encodes to FLV for Facebook.
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const cors      = require('cors');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'Crickerr Relay Server running ✅', sessions: sessions.size });
});

const sessions = new Map();

wss.on('connection', (ws) => {
    console.log('[WS] New broadcaster connected');

    let ffmpeg    = null;
    let matchId   = null;
    let buffer    = [];
    let streaming = false;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ── START ────────────────────────────────────────────────────────────
        if (msg.type === 'start') {
            matchId = msg.matchId || 'unknown';

            const serverUrl   = (msg.fbServerUrl || 'rtmps://live-api-s.facebook.com:443/rtmp').replace(/\/$/, '');
            const streamKey   = (msg.fbStreamKey || '').trim();
            const rtmpsTarget = `${serverUrl}/${streamKey}`;

            console.log(`[${matchId}] Starting relay → Facebook RTMPS`);

            // Kill any existing FFmpeg for this match
            if (sessions.has(matchId)) {
                try { sessions.get(matchId).kill('SIGKILL'); } catch {}
                sessions.delete(matchId);
            }

            /**
             * FFmpeg pipeline (FIXED):
             *
             * Input:
             *   -f webm → read WebM container from stdin
             *   (Browser MediaRecorder sends WebM with VP8/VP9 or H264 video + Opus audio)
             *
             * Output:
             *   Video → re-encode to H264 (libx264) — required by Facebook FLV
             *   Audio → re-encode to AAC              — required by Facebook FLV
             *   Container → FLV                        — required by Facebook RTMP
             *
             * Why re-encode video:
             *   Facebook requires H264 Baseline/Main profile in FLV.
             *   Browser may send VP8/VP9 which Facebook cannot accept.
             *   libx264 ensures maximum compatibility.
             */
            ffmpeg = spawn('ffmpeg', [
                '-loglevel', 'info',

                // ── INPUT: WebM from browser MediaRecorder via stdin ──────────
                '-f',           'webm',
                '-i',           'pipe:0',

                // ── VIDEO: Re-encode to H264 for Facebook compatibility ───────
                '-c:v',         'libx264',
                '-preset',      'veryfast',    // Fast encode, low CPU on server
                '-tune',        'zerolatency', // Minimise encode latency
                '-profile:v',   'baseline',    // Maximum Facebook compatibility
                '-level',       '3.1',
                '-b:v',         '2500k',       // 2.5 Mbps video bitrate
                '-maxrate',     '2500k',
                '-bufsize',     '5000k',
                '-g',           '60',          // Keyframe every 2s at 30fps
                '-keyint_min',  '30',
                '-sc_threshold','0',           // No scene-cut keyframes (smoother)
                '-pix_fmt',     'yuv420p',     // Required for FB compatibility

                // ── AUDIO: Re-encode to AAC ───────────────────────────────────
                '-c:a',         'aac',
                '-b:a',         '128k',
                '-ar',          '44100',
                '-ac',          '2',

                // ── OUTPUT: FLV container → Facebook RTMPS ────────────────────
                '-f',           'flv',
                rtmpsTarget
            ]);

            sessions.set(matchId, ffmpeg);
            streaming = true;

            ffmpeg.stdout.on('data', (d) => {
                console.log(`[FFmpeg stdout][${matchId}]`, d.toString().trim());
            });

            ffmpeg.stderr.on('data', (d) => {
                const line = d.toString().trim();
                if (line) console.log(`[FFmpeg][${matchId}]`, line);
            });

            ffmpeg.on('close', (code) => {
                console.log(`[${matchId}] FFmpeg exited with code ${code}`);
                sessions.delete(matchId);
                streaming = false;
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'stopped', code }));
                }
            });

            ffmpeg.on('error', (err) => {
                console.error(`[${matchId}] FFmpeg spawn error:`, err.message);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: 'FFmpeg failed to start: ' + err.message }));
                }
            });

            // Flush buffered chunks that arrived before FFmpeg was ready
            if (buffer.length > 0) {
                console.log(`[${matchId}] Flushing ${buffer.length} buffered chunks`);
                buffer.forEach(chunk => {
                    if (ffmpeg.stdin.writable) ffmpeg.stdin.write(chunk);
                });
                buffer = [];
            }

            ws.send(JSON.stringify({ type: 'ready' }));
            console.log(`[${matchId}] Sent ready signal to broadcaster`);
        }

        // ── VIDEO chunk ──────────────────────────────────────────────────────
        else if (msg.type === 'video') {
            if (!msg.data) return;

            let chunk;
            try {
                chunk = Buffer.from(msg.data, 'base64');
            } catch (e) {
                console.error(`[${matchId}] Failed to decode video chunk:`, e.message);
                return;
            }

            if (streaming && ffmpeg && ffmpeg.stdin.writable) {
                try {
                    ffmpeg.stdin.write(chunk);
                } catch (e) {
                    console.error(`[${matchId}] stdin write error:`, e.message);
                }
            } else {
                // Buffer chunks while FFmpeg is starting (max 5 seconds worth)
                if (buffer.length < 100) {
                    buffer.push(chunk);
                }
            }
        }

        // ── STOP ─────────────────────────────────────────────────────────────
        else if (msg.type === 'stop') {
            console.log(`[${matchId}] Stop requested by broadcaster`);
            if (ffmpeg) {
                try { ffmpeg.stdin.end(); } catch {}
                setTimeout(() => {
                    try { ffmpeg.kill('SIGTERM'); } catch {}
                }, 2000);
            }
            streaming = false;
            sessions.delete(matchId);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'stopped' }));
            }
        }
    });

    ws.on('close', () => {
        console.log(`[WS][${matchId}] Broadcaster disconnected — cleaning up`);
        if (ffmpeg) {
            try { ffmpeg.stdin.end(); } catch {}
            try { ffmpeg.kill('SIGTERM'); } catch {}
        }
        sessions.delete(matchId);
    });

    ws.on('error', (err) => {
        console.error(`[WS][${matchId}] WebSocket error:`, err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Crickerr Relay Server listening on port ${PORT}`);
});
