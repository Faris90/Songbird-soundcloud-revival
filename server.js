const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3636;
const SOUNDCLOUD_CLIENT_ID = 'Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo';

// Ensure local audio cache directory exists
const CACHE_DIR = path.join(__dirname, 'audio_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

/**
 * 1. Tracks & Search Route
 * Fetches modern SoundCloud API v2 search results and returns them to Songbird.
 */
app.get('/tracks.json', async (req, res) => {
    try {
        const searchQuery = req.query.q || 'trending';
        const response = await axios.get(`https://api-v2.soundcloud.com/search/tracks`, {
            params: {
                q: searchQuery,
                client_id: SOUNDCLOUD_CLIENT_ID,
                limit: 50
            }
        });

        const tracks = response.data.collection || response.data || [];
        res.json(tracks);
    } catch (error) {
        console.error("[Search Error]:", error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 2. Audio Stream Route (Full Play, Pause & Scrubbing Support)
 * Transcodes and saves the track locally first, then serves it as a static file 
 * with HTTP Range Request support for GStreamer.
 */
app.get('/api/stream', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        if (!targetUrl) {
            return res.status(400).send('Missing target URL');
        }

        targetUrl = targetUrl.replace(/consumer_key=[^&]+/, `client_id=${SOUNDCLOUD_CLIENT_ID}`);
        if (!targetUrl.includes('client_id=')) {
            const separator = targetUrl.includes('?') ? '&' : '?';
            targetUrl = `${targetUrl}${separator}client_id=${SOUNDCLOUD_CLIENT_ID}`;
        }

        const fileHash = crypto.createHash('md5').update(targetUrl).digest('hex');
        const filePath = path.join(CACHE_DIR, `${fileHash}.mp3`);

        // Helper function to safely serve the file with range support
        const serveFile = () => {
            if (fs.existsSync(filePath)) {
                return res.sendFile(filePath);
            } else {
                res.status(500).send('Audio file missing after processing');
            }
        };

        // If already cached, serve it instantly
        if (fs.existsSync(filePath)) {
            console.log("[Cache Hit] Serving cached track to Songbird.");
            return serveFile();
        }

        console.log("[Cache Miss] Transcoding track before playback for full play/pause support...");
        const scResponse = await axios.get(targetUrl, {
            validateStatus: function (status) { return status < 500; }
        });

        if (scResponse.data && scResponse.data.url) {
            const hlsPlaylistUrl = scResponse.data.url;

            // Spawn FFmpeg to fully convert and save the MP3 file locally
            const ffmpegProcess = spawn('ffmpeg', [
                '-i', hlsPlaylistUrl,
                '-f', 'mp3',
                '-ab', '128k',
                '-acodec', 'libmp3lame',
                filePath
            ]);

            ffmpegProcess.on('close', (code, signal) => {
    // If we killed it because the client disconnected, treat it as a clean exit
    if (signal === 'SIGKILL' || code === null) {
        console.log("[Stream] FFmpeg successfully terminated due to client disconnect.");
        return;
    }

    if (code === 0) {
        console.log("[Transcode Complete] Serving track to Songbird.");
        serveFile();
    } else {
        console.error(`[FFmpeg Error] Process exited with code ${code}`);
        if (!res.headersSent) {
            res.status(500).send('Transcoding failed');
        }
    }
});

            // Handle client aborting the request early
            req.on('close', () => {
                if (ffmpegProcess.exitCode === null) {
                    console.log("[Stream] Client disconnected during transcode. Terminating FFmpeg.");
                    ffmpegProcess.kill('SIGKILL');
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                }
            });

        } else {
            res.status(404).json({ error: 'Could not resolve HLS stream URL from SoundCloud' });
        }
    } catch (error) {
        console.error("[Stream Proxy Error]:", error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

/**
 * 3. Image Proxy Route
 * Downloads album artwork securely via Node.js (bypassing outdated TLS/SSL 
 * limitations in Songbird) and forwards the binary buffer locally.
 */
app.get('/api/image', async (req, res) => {
    try {
        let imageUrl = req.query.url;
        if (!imageUrl) {
            return res.status(400).send('Missing image URL');
        }

        if (imageUrl.startsWith('http://')) {
            imageUrl = imageUrl.replace('http://', 'https://');
        }

        const imageResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            validateStatus: function (status) { return status < 500; }
        });

        res.setHeader('Content-Type', imageResponse.headers['content-type'] || 'image/jpeg');
        res.send(imageResponse.data);
    } catch (error) {
        console.error("[Image Proxy Error]:", error.message);
        res.status(500).send('Failed to fetch image');
    }
});

/**
 * 4. Download Route
 * Transcodes and triggers a file attachment download for offline saving.
 */
app.get('/api/download', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        let trackTitle = req.query.title || 'soundcloud_track';
        
        if (!targetUrl) {
            return res.status(400).send('Missing target URL');
        }

        trackTitle = trackTitle.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();

        targetUrl = targetUrl.replace(/consumer_key=[^&]+/, `client_id=${SOUNDCLOUD_CLIENT_ID}`);
        if (!targetUrl.includes('client_id=')) {
            const separator = targetUrl.includes('?') ? '&' : '?';
            targetUrl = `${targetUrl}${separator}client_id=${SOUNDCLOUD_CLIENT_ID}`;
        }

        const fileHash = crypto.createHash('md5').update(targetUrl).digest('hex');
        const filePath = path.join(CACHE_DIR, `${fileHash}.mp3`);

        const sendDownload = () => {
            res.download(filePath, `${trackTitle}.mp3`, (err) => {
                if (err && !res.headersSent) {
                    console.error("[Download Error]:", err.message);
                }
            });
        };

        if (fs.existsSync(filePath)) {
            return sendDownload();
        }

        console.log("[Download] Transcoding track for download...");
        const scResponse = await axios.get(targetUrl, {
            validateStatus: function (status) { return status < 500; }
        });

        if (scResponse.data && scResponse.data.url) {
            const hlsPlaylistUrl = scResponse.data.url;

            const ffmpegProcess = spawn('ffmpeg', [
                '-i', hlsPlaylistUrl,
                '-f', 'mp3',
                '-ab', '192k',
                '-acodec', 'libmp3lame',
                filePath
            ]);

            ffmpegProcess.on('close', (code) => {
                if (code === 0) {
                    sendDownload();
                } else {
                    if (!res.headersSent) {
                        res.status(500).send('Download transcoding failed');
                    }
                }
            });
        } else {
            res.status(404).json({ error: 'Could not resolve stream URL for download' });
        }
    } catch (error) {
        console.error("[Download Route Error]:", error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.listen(PORT, () => {
    console.log(`SoundCloud proxy server running on http://localhost:${PORT}`);
});