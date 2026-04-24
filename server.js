/**
 * CRICKERR → FACEBOOK LIVE RELAY SERVER (v2 — BINARY PIPELINE)
 *
 * Browser MediaRecorder (WebM) → Binary WebSocket frames → FFmpeg stdin
 *                              → H264/AAC FLV → RTMPS → Facebook Live
 *
 * KEY IMPROVEMENTS vs v1:
 *   ✓ Binary WebSocket frames for video (no base64, no JSON parse per chunk)
 *     → ~33% less bandwidth, zero per-chunk CPU overhead, no JSON size-limit risk
 *   ✓ Proper FFmpeg streaming-input flags for live WebM fragments
 *     → -f matroska + genpts + wallclock timestamps = FFmpeg actually starts
 *   ✓ FFmpeg stderr mined for errors and relayed to client
 *     → UI sees the real failure instead of silent hangs
 *   ✓ WebSocket heartbeat (Railway closes idle sockets after ~5min)
 *   ✓ Bounded pre-ready buffer (byte-capped, not count-capped)
 *   ✓ Backwards-compatible with legacy base64 JSON video frames
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const cors      = require('cors');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, maxPayload: 16 * 1024 * 1024 }); // 16MB max frame

app.use(cors());
app.use(express.json());

const sessions = new Map();

// ── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'Crickerr Relay Server v2 running ✅',
        pipeline: 'binary-websocket → ffmpeg → rtmps',
        sessions: sessions.size
    });
});

// ── WebSocket heartbeat (keeps Railway from killing idle sockets) ───────────
function heartbeat() { this.isAlive = true; }
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) { try { ws.terminate(); } catch {} ; return; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    });
}, 30000);
wss.on('close', () => clearInterval(pingInterval));

wss.on('connection', (ws) => {
    console.log('[WS] New broadcaster connected');
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    let ffmpeg          = null;
    let matchId         = null;
    let streaming       = false;
    let preReadyBuffer  = [];
    let preReadyBytes   = 0;
    let lastFfmpegError = '';

    const send = (obj) => {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify(obj)); } catch {}
        }
    };

    const writeChunkToFfmpeg = (chunk) => {
        if (streaming && ffmpeg && ffmpeg.stdin.writable) {
            try { ffmpeg.stdin.write(chunk); }
            catch (e) { console.error(`[${matchId}] stdin write error:`, e.message); }
        } else {
            // Buffer while FFmpeg boots (cap 8 MB — first WebM init + a few chunks)
            if (preReadyBytes < 8 * 1024 * 1024) {
                preReadyBuffer.push(chunk);
                preReadyBytes += chunk.length;
            }
        }
    };

    ws.on('message', (data, isBinary) => {
        // ── BINARY FRAME: raw WebM fragment from browser MediaRecorder ──────
        if (isBinary) {
            writeChunkToFfmpeg(data);
            return;
        }

        // ── TEXT FRAME: JSON control message ────────────────────────────────
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        // ── START ───────────────────────────────────────────────────────────
        if (msg.type === 'start') {
            matchId = (msg.matchId || 'unknown').toString();

            const serverUrl = (msg.fbServerUrl || 'rtmps://live-api-s.facebook.com:443/rtmp').replace(/\/$/, '');
            const streamKey = (msg.fbStreamKey || '').trim();

            if (!streamKey) {
                send({ type: 'error', message: 'Missing Facebook Stream Key.' });
                return;
            }

            const rtmpsTarget = `${serverUrl}/${streamKey}`;
            console.log(`[${matchId}] Starting relay → Facebook RTMPS`);

            // Kill any existing FFmpeg for this match
            if (sessions.has(matchId)) {
                try { sessions.get(matchId).kill('SIGKILL'); } catch {}
                sessions.delete(matchId);
            }

            /**
             * FFmpeg v2 pipeline — professional streaming config
             *
             * INPUT (critical — this is what was broken in v1):
             *   -f matroska                     Auto-handles WebM (subset of Matroska)
             *                                   and any codec inside (VP8/VP9/H264 + Opus)
             *   -fflags +genpts+nobuffer        Synthesize PTS for MediaRecorder fragments
             *                                   that don't carry proper timestamps
             *   -use_wallclock_as_timestamps 1  Use server clock — MediaRecorder PTS drifts
             *                                   badly and FFmpeg will stall otherwise
             *   -thread_queue_size 1024         Absorb bursty WebSocket writes without dropping
             *   -analyzeduration / -probesize   Short probe so FFmpeg starts fast (live)
             *
             * VIDEO:
             *   libx264 baseline 3.1 yuv420p — Facebook FLV requirement
             *   CBR (minrate=maxrate=bitrate) — stable RTMP bitrate, no pumping
             *   g=60 keyint_min=60 sc_threshold=0 — 2s GOP, required by FB
             *
             * AUDIO:
             *   AAC LC 128k 44.1kHz stereo — FB requirement
             *
             * OUTPUT:
             *   -f flv + -flvflags no_duration_filesize  (live-safe FLV)
             *   -rtmp_live live                           (signal RTMP server this is live)
             *   -rw_timeout 15000000                      (15s socket timeout)
             */
            const ffmpegArgs = [
                '-hide_banner',
                '-loglevel', 'warning',

                // Input handling
                '-fflags', '+genpts+nobuffer+discardcorrupt',
                '-flags', 'low_delay',
                '-use_wallclock_as_timestamps', '1',
                '-thread_queue_size', '1024',
                '-analyzeduration', '1000000',
                '-probesize', '1000000',
                '-f', 'matroska',
                '-i', 'pipe:0',

                // Video re-encode
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-tune', 'zerolatency',
                '-profile:v', 'baseline',
                '-level', '3.1',
                '-pix_fmt', 'yuv420p',
                '-r', '30',
                '-b:v', '2500k',
                '-maxrate', '2500k',
                '-minrate', '2500k',
                '-bufsize', '5000k',
                '-g', '60',
                '-keyint_min', '60',
                '-sc_threshold', '0',

                // Audio re-encode
                '-c:a', 'aac',
                '-profile:a', 'aac_low',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',

                // Output to Facebook RTMPS
                '-f', 'flv',
                '-flvflags', 'no_duration_filesize',
                '-rtmp_live', 'live',
                '-rw_timeout', '15000000',
                rtmpsTarget
            ];

            ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            sessions.set(matchId, ffmpeg);
            streaming = true;

            ffmpeg.stdin.on('error', (err) => {
                // EPIPE when FFmpeg exits — don't crash
                if (err.code !== 'EPIPE') console.error(`[${matchId}] stdin error:`, err.message);
            });

            ffmpeg.stderr.on('data', (d) => {
                const line = d.toString().trim();
                if (!line) return;
                console.log(`[FFmpeg][${matchId}]`, line);
                // Capture meaningful errors for reporting back to client
                if (/error|failed|unable|invalid|refused|denied|unauthori[sz]ed|connection/i.test(line)) {
                    lastFfmpegError = line.slice(0, 500);
                }
            });

            ffmpeg.on('close', (code) => {
                console.log(`[${matchId}] FFmpeg exited with code ${code}`);
                sessions.delete(matchId);
                streaming = false;
                if (code !== 0 && code !== 255 && lastFfmpegError) {
                    send({ type: 'error', message: `FFmpeg: ${lastFfmpegError}` });
                }
                send({ type: 'stopped', code });
            });

            ffmpeg.on('error', (err) => {
                console.error(`[${matchId}] FFmpeg spawn error:`, err.message);
                send({ type: 'error', message: 'FFmpeg failed to start: ' + err.message });
            });

            // Flush any chunks that arrived before FFmpeg was ready
            if (preReadyBuffer.length > 0) {
                console.log(`[${matchId}] Flushing ${preReadyBuffer.length} pre-ready chunks (${preReadyBytes} bytes)`);
                for (const chunk of preReadyBuffer) {
                    if (ffmpeg.stdin.writable) {
                        try { ffmpeg.stdin.write(chunk); } catch {}
                    }
                }
                preReadyBuffer = [];
                preReadyBytes  = 0;
            }

            send({ type: 'ready' });
            console.log(`[${matchId}] Sent ready signal to broadcaster`);
            return;
        }

        // ── LEGACY base64 video frame (backward-compat with old clients) ────
        if (msg.type === 'video' && msg.data) {
            try {
                const chunk = Buffer.from(msg.data, 'base64');
                writeChunkToFfmpeg(chunk);
            } catch (e) {
                console.error(`[${matchId}] base64 decode error:`, e.message);
            }
            return;
        }

        // ── STOP ────────────────────────────────────────────────────────────
        if (msg.type === 'stop') {
            console.log(`[${matchId}] Stop requested by broadcaster`);
            if (ffmpeg) {
                try { ffmpeg.stdin.end(); } catch {}
                setTimeout(() => { try { ffmpeg.kill('SIGTERM'); } catch {} }, 2000);
            }
            streaming = false;
            sessions.delete(matchId);
            send({ type: 'stopped' });
            return;
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
    console.log(`✅ Crickerr Relay Server v2 (binary pipeline) listening on port ${PORT}`);
});
