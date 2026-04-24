/**
 * CRICKERR → FACEBOOK LIVE RELAY SERVER
 * WebRTC (from browser) → FFmpeg → RTMPS → Facebook Live
 *
 * Stack: Node.js + Express + ws (WebSocket) + node-webrtc + FFmpeg
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const { spawn }  = require('child_process');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ── Health check (Railway uses this to confirm the server is alive) ──────────
app.get('/', (req, res) => {
    res.json({ status: 'Crickerr Relay Server running ✅', sessions: sessions.size });
});

// ── Active FFmpeg sessions keyed by matchId ──────────────────────────────────
const sessions = new Map();

/**
 * Each WebSocket connection from the broadcaster handles one relay session.
 *
 * Protocol (JSON messages over WebSocket):
 *
 *  Browser → Server:
 *    { type: 'start',  matchId, fbStreamKey, fbServerUrl }
 *    { type: 'video',  data: <base64 encoded raw H264 NAL or VP8 chunk> }
 *    { type: 'stop',   matchId }
 *
 *  Server → Browser:
 *    { type: 'ready' }
 *    { type: 'error',  message }
 *    { type: 'stopped' }
 */
wss.on('connection', (ws) => {
    console.log('[WS] New broadcaster connected');

    let ffmpeg    = null;
    let matchId   = null;
    let buffer    = [];
    let streaming = false;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ── START command ────────────────────────────────────────────────────
        if (msg.type === 'start') {
            matchId = msg.matchId || 'unknown';

            // Build the full RTMPS URL: serverUrl + streamKey
            // Facebook format: rtmps://live-api-s.facebook.com:443/rtmp/<STREAM_KEY>
            const serverUrl   = (msg.fbServerUrl || 'rtmps://live-api-s.facebook.com:443/rtmp/').replace(/\/$/, '');
            const streamKey   = msg.fbStreamKey  || '';
            const rtmpsTarget = `${serverUrl}/${streamKey}`;

            console.log(`[${matchId}] Starting relay → ${serverUrl}/****`);

            // Kill any existing session for this matchId
            if (sessions.has(matchId)) {
                try { sessions.get(matchId).kill('SIGKILL'); } catch {}
                sessions.delete(matchId);
            }

            /**
             * FFmpeg pipeline:
             *  - Input:  raw H264 Annex-B arriving on stdin (piped from browser via WS)
             *  - Output: RTMPS stream to Facebook
             *
             * Key flags:
             *  -re              → read input at native frame rate (prevents buffer overflow)
             *  -fflags nobuffer → minimise latency
             *  -vcodec copy     → pass through H264 without re-encoding (saves CPU)
             *  -acodec aac      → Facebook requires AAC audio
             *  -f flv           → Facebook RTMP requires FLV container
             */
            ffmpeg = spawn('ffmpeg', [
                '-loglevel', 'warning',

                // Video input (raw H264 from stdin)
                '-f',        'h264',
                '-i',        'pipe:0',

                // Silent audio source (browser canvas has no mic by default)
                '-f',        'lavfi',
                '-i',        'anullsrc=channel_layout=stereo:sample_rate=44100',

                // Video: pass-through
                '-vcodec',   'copy',

                // Audio: encode to AAC (required by Facebook)
                '-acodec',   'aac',
                '-b:a',      '128k',
                '-ar',       '44100',

                // Mux & output
                '-f',        'flv',
                '-flvflags', 'no_duration_filesize',
                rtmpsTarget
            ]);

            sessions.set(matchId, ffmpeg);
            streaming = true;

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

            // Flush any buffered chunks that arrived before FFmpeg was ready
            buffer.forEach(chunk => ffmpeg.stdin.write(chunk));
            buffer = [];

            ws.send(JSON.stringify({ type: 'ready' }));
        }

        // ── VIDEO chunk ──────────────────────────────────────────────────────
        else if (msg.type === 'video') {
            if (!msg.data) return;
            const chunk = Buffer.from(msg.data, 'base64');

            if (streaming && ffmpeg && ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(chunk);
            } else {
                // Buffer up to 200 chunks while FFmpeg is starting
                if (buffer.length < 200) buffer.push(chunk);
            }
        }

        // ── STOP command ─────────────────────────────────────────────────────
        else if (msg.type === 'stop') {
            console.log(`[${matchId}] Stop requested`);
            if (ffmpeg) {
                ffmpeg.stdin.end();
                setTimeout(() => {
                    try { ffmpeg.kill('SIGTERM'); } catch {}
                }, 2000);
            }
            streaming = false;
            sessions.delete(matchId);
            ws.send(JSON.stringify({ type: 'stopped' }));
        }
    });

    ws.on('close', () => {
        console.log(`[WS][${matchId}] Broadcaster disconnected`);
        if (ffmpeg) {
            try { ffmpeg.stdin.end(); ffmpeg.kill('SIGTERM'); } catch {}
        }
        sessions.delete(matchId);
    });

    ws.on('error', (err) => {
        console.error(`[WS][${matchId}] Error:`, err.message);
    });
});

// ── Start listening ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Crickerr Relay Server listening on port ${PORT}`);
});
