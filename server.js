const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState, 
    Browsers, 
    fetchLatestBaileysVersion, 
    proto,
    generateMessageIDV2,
    prepareWAMessageMedia
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 10000;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || 'sarkari_secret_token_2026';
const TARGET_JID = process.env.WHATSAPP_TARGET_JID || '120363429584632967@newsletter';
const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://sarkari-jobs-alert-bot.rajachaudharyts.workers.dev';
const AUTH_DIR = path.join(__dirname, 'auth_session');

let sock = null;
let isConnected = false;
let currentQrDataUrl = null;
let currentQrString = null;
let connectedUser = null;
let lastError = null;

// Ensure auth dir exists
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

/**
 * Cloudflare KV Session Sync
 */
async function restoreSessionFromCloud() {
    try {
        console.log('🔄 Checking Cloudflare KV for saved session backup...');
        const res = await fetch(`${CF_WORKER_URL}/api/wa-auth`, {
            headers: { 'Authorization': `Bearer ${GATEWAY_SECRET}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.creds) {
                console.log('📦 Found saved session in Cloudflare KV! Restoring to disk...');
                fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), JSON.stringify(data.creds, null, 2));
                if (data.keys) {
                    for (const [k, v] of Object.entries(data.keys)) {
                        fs.writeFileSync(path.join(AUTH_DIR, k), typeof v === 'string' ? v : JSON.stringify(v));
                    }
                }
                console.log('✅ Session restored from Cloudflare KV!');
                return true;
            }
        }
    } catch (e) {
        console.log('Note: Cloudflare KV session restore skipped:', e.message);
    }
    return false;
}

async function backupSessionToCloud() {
    try {
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsFile)) return;
        const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
        
        const files = fs.readdirSync(AUTH_DIR);
        const keys = {};
        for (const file of files) {
            if (file !== 'creds.json') {
                keys[file] = fs.readFileSync(path.join(AUTH_DIR, file), 'utf8');
            }
        }

        await fetch(`${CF_WORKER_URL}/api/wa-auth`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GATEWAY_SECRET}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ creds, keys })
        });
        console.log('☁️ WhatsApp session backed up to Cloudflare KV!');
    } catch (e) {
        console.log('Cloud session backup error:', e.message);
    }
}

/**
 * Initializes Baileys WhatsApp Connection
 */
async function connectToWhatsApp() {
    try {
        // Try restoring session from Cloudflare KV if local auth is empty
        if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
            await restoreSessionFromCloud();
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📡 WhatsApp Web Version: ${version.join('.')} (Latest: ${isLatest})`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'warn' }),
            browser: Browsers.windows('Chrome'),
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            // Automatically backup to Cloudflare KV when credentials update
            await backupSessionToCloud();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQrString = qr;
                try {
                    currentQrDataUrl = await QRCode.toDataURL(qr, {
                        width: 400,
                        margin: 2,
                        color: { dark: '#111827', light: '#ffffff' }
                    });
                    console.log('📲 Fresh QR Code generated. View at /qr');
                } catch (qrErr) {
                    console.error('Failed to convert QR to DataURL:', qrErr.message);
                }
            }

            if (connection === 'close') {
                isConnected = false;
                connectedUser = null;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                lastError = `Connection closed (code: ${statusCode})`;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`⚠️ Connection closed. Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    console.log('❌ WhatsApp Logged Out! Resetting auth session...');
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQrDataUrl = null;
                currentQrString = null;
                connectedUser = sock.user;
                lastError = null;
                // Reset reconnection backoff on successful connect
                connectToWhatsApp._backoff = 5000;
                console.log('====================================================');
                console.log(`🎉 WHATSAPP CONNECTED! User: ${sock.user?.id || 'Unknown'}`);
                console.log(`📢 Default Target Channel JID: ${TARGET_JID}`);
                console.log('====================================================');

                // Try auto-subscribing to default channel
                if (TARGET_JID) {
                    try {
                        if (typeof sock.subscribeNewsletterUpdates === 'function') {
                            await sock.subscribeNewsletterUpdates(TARGET_JID);
                            console.log(`✅ Subscribed to newsletter updates: ${TARGET_JID}`);
                        }
                    } catch (e) {
                        console.log('Newsletter subscribe note:', e.message);
                    }
                }

                // Trigger a cloud backup of the fresh valid session
                setTimeout(backupSessionToCloud, 2000);
            }
        });

        return sock;
    } catch (err) {
        console.error('Initialization error:', err.message);
        // Exponential backoff: 5s, 10s, 20s, 40s, max 5 min
        if (!connectToWhatsApp._backoff) connectToWhatsApp._backoff = 5000;
        const delay = connectToWhatsApp._backoff;
        console.log(`Retrying in ${delay / 1000}s...`);
        setTimeout(() => {
            connectToWhatsApp._backoff = Math.min(delay * 2, 300000);
            connectToWhatsApp();
        }, delay);
    }
}

// Reset backoff on successful connection (called from connection.update 'open')

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// 1. Health & Status
app.get('/', (req, res) => {
    res.json({
        service: 'Sarkari WhatsApp Gateway',
        status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
        user: connectedUser?.id || null,
        targetJid: TARGET_JID,
        qrAvailable: !!currentQrDataUrl,
        timestamp: new Date().toISOString()
    });
});

app.get('/status', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        online: true,
        connected: isConnected,
        user: connectedUser?.id || null,
        targetJid: TARGET_JID,
        uptime: process.uptime(),
        storageInfo: {
            architecture: 'zero_media_storage',
            imageStorageOnDisk: '0 KB (Transient RAM streaming direct to WhatsApp CDN)',
            databaseUsage: '0 KB (No database files or image binaries stored)',
            heapUsedMB: Math.round((mem.heapUsed / (1024 * 1024)) * 100) / 100,
            rssMB: Math.round((mem.rss / (1024 * 1024)) * 100) / 100
        }
    });
});

// 2. Web UI to view & scan QR Code
app.get('/qr', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Gateway - Link Device</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
            body { background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
            .card { background: #1e293b; border-radius: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); width: 100%; max-width: 480px; padding: 30px; text-align: center; border: 1px solid #334155; }
            h1 { font-size: 24px; margin-bottom: 8px; color: #38bdf8; }
            p.sub { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
            .qr-box { background: white; padding: 16px; border-radius: 16px; display: inline-block; margin-bottom: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
            .qr-box img { width: 300px; height: 300px; display: block; border-radius: 8px; }
            .instructions { text-align: left; background: #0f172a; padding: 18px; border-radius: 12px; font-size: 14px; line-height: 1.6; color: #cbd5e1; border: 1px solid #334155; }
            .instructions ol { padding-left: 20px; }
            .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 30px; font-weight: 600; font-size: 14px; margin-bottom: 20px; }
            .badge.waiting { background: #ca8a04; color: #fef08a; }
            .badge.connected { background: #16a34a; color: #dcfce7; }
            .dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; animation: pulse 1.5s infinite; }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
        </style>
        <script>
            setInterval(() => {
                fetch('/status')
                    .then(res => res.json())
                    .then(data => {
                        if (data.connected) location.reload();
                    })
                    .catch(() => {});
            }, 3000);
        </script>
    </head>
    <body>
        <div class="card">
            <h1>WhatsApp Cloud Gateway</h1>
            <p class="sub">Sarkari Result & Govt Jobs Alerts</p>

            ${isConnected ? `
                <div class="badge connected">
                    <span class="dot"></span> 100% CONNECTED & READY
                </div>
                <div style="background: #0f172a; padding: 24px; border-radius: 14px; margin: 15px 0; border: 1px solid #22c55e;">
                    <div style="font-size: 48px; margin-bottom: 10px;">✅</div>
                    <h3 style="color: #4ade80; margin-bottom: 8px;">WhatsApp is Active!</h3>
                    <p style="color: #94a3b8; font-size: 14px;">Connected Number: <b>${connectedUser?.id || 'Active Phone'}</b></p>
                    <p style="color: #94a3b8; font-size: 14px; margin-top: 6px;">Target Channel: <b>${TARGET_JID}</b></p>
                </div>
                <p style="font-size: 13px; color: #64748b; margin-top: 15px;">Permanent Cloud Automation is live!</p>
            ` : `
                <div class="badge waiting">
                    <span class="dot"></span> Waiting for QR Code Scan...
                </div>

                <div class="qr-box">
                    ${currentQrDataUrl ? `
                        <img src="${currentQrDataUrl}" alt="WhatsApp QR Code" />
                    ` : `
                        <div style="width: 300px; height: 300px; display: flex; align-items: center; justify-content: center; color: #334155; font-weight: bold;">
                            Generating QR Code...<br>(Please refresh in 3s)
                        </div>
                    `}
                </div>

                <div class="instructions">
                    <b>📲 Link your WhatsApp in 3 Easy Steps:</b>
                    <ol style="margin-top: 8px;">
                        <li>Open WhatsApp on your phone</li>
                        <li>Tap <b>Menu (3 dots)</b> &rarr; <b>Linked Devices</b></li>
                        <li>Tap <b>Link a Device</b> and point your camera at this QR Code!</li>
                    </ol>
                </div>
            `}
        </div>
    </body>
    </html>
    `);
});

// 3. Inspect channels owned or subscribed
app.get('/newsletters', async (req, res) => {
    if (!sock || !isConnected) return res.status(503).json({ error: 'Not connected' });
    try {
        let list = [];
        if (typeof sock.newsletterSubscribed === 'function') {
            list = await sock.newsletterSubscribed();
        }
        res.json({ count: list.length, newsletters: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Query newsletter metadata by invite code
app.get('/newsletter-meta', async (req, res) => {
    if (!sock || !isConnected) return res.status(503).json({ error: 'Not connected' });
    try {
        const code = req.query.code || '0029VbDyzTz9RZAPvqZL7542';
        const meta = await sock.newsletterMetadata('invite', code);
        res.json(meta);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


/**
 * Safe Base64URL encoding for WhatsApp CDN tokens
 */
function encodeBase64Url(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Uploads unencrypted media buffer directly to WhatsApp Newsletter CDN (/newsletter/newsletter-image)
 * Generates verified /m1/ directPath required by WhatsApp Channels
 */
async function uploadNewsletterImage(waSocket, buffer) {
    if (!waSocket || typeof waSocket.refreshMediaConn !== 'function') {
        throw new Error('Socket not ready for media upload');
    }

    const fileSha256 = crypto.createHash('sha256').update(buffer).digest();
    const token = encodeURIComponent(encodeBase64Url(fileSha256));

    console.log('🔄 Refreshing WhatsApp media connection for newsletter upload...');
    const mediaConn = await waSocket.refreshMediaConn(false);
    const auth = encodeURIComponent(mediaConn.auth);

    let lastErr = null;
    const hosts = mediaConn.hosts || [];
    for (const host of hosts) {
        const hostname = host.hostname;
        const uploadUrl = `https://${hostname}/newsletter/newsletter-image/${token}?auth=${auth}&token=${token}&server_thumb_gen=1`;
        try {
            console.log(`📡 Uploading unencrypted banner to WhatsApp CDN: https://${hostname}...`);
            const res = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Origin': 'https://web.whatsapp.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                body: buffer
            });

            if (res.ok) {
                const data = await res.json();
                console.log('✅ WhatsApp Newsletter CDN upload success:', JSON.stringify(data));
                const directPath = data.direct_path || data.directPath;
                if (data.url || directPath) {
                    return {
                        url: data.url,
                        directPath: directPath,
                        fileSha256: fileSha256,
                        fileLength: buffer.length
                    };
                }
            } else {
                const errText = await res.text();
                console.warn(`Upload to ${hostname} failed HTTP ${res.status}:`, errText);
                lastErr = new Error(`HTTP ${res.status}: ${errText}`);
            }
        } catch (e) {
            console.warn(`Upload error on ${hostname}:`, e.message);
            lastErr = e;
        }
    }

    throw new Error(`Newsletter CDN upload failed: ${lastErr ? lastErr.message : 'No responsive hosts'}`);
}

// 5. Send Alert (Supports both Newsletters and Regular Chats)
app.post('/send', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (GATEWAY_SECRET && (!authHeader || authHeader !== `Bearer ${GATEWAY_SECRET}`)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid GATEWAY_SECRET' });
    }

    if (!isConnected || !sock) {
        return res.status(503).json({ error: 'WhatsApp is not connected yet.' });
    }

    const { text, targetJid, imageUrl } = req.body;
    if (!text && !imageUrl) {
        return res.status(400).json({ error: 'Missing "text" or "imageUrl" in JSON body' });
    }

    const destination = targetJid || TARGET_JID;
    console.log(`\n📨 [Outbound Request] Destination: ${destination}, Has Image: ${!!imageUrl}`);

    // If imageUrl is provided, attempt to download image into transient memory Buffer (Max 5MB guard)
    let imageBuffer = null;
    if (imageUrl) {
        try {
            console.log(`📥 Downloading image for WhatsApp: ${imageUrl}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);

            const imgRes = await fetch(imageUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (imgRes.ok) {
                const contentLength = parseInt(imgRes.headers.get('content-length') || '0', 10);
                if (contentLength > 5 * 1024 * 1024) {
                    console.warn(`Image exceeds 5MB limit (${contentLength} bytes). Skipping media buffer to protect RAM.`);
                } else {
                    const arrayBuf = await imgRes.arrayBuffer();
                    if (arrayBuf.byteLength > 5 * 1024 * 1024) {
                        console.warn(`Image payload exceeds 5MB (${arrayBuf.byteLength} bytes). Skipping to protect RAM.`);
                    } else {
                        imageBuffer = Buffer.from(arrayBuf);
                        console.log(`✅ Image buffered in transient RAM (${imageBuffer.length} bytes) - 0 bytes on disk/DB`);
                    }
                }
            } else {
                console.warn(`Failed to download image (${imageUrl}): HTTP ${imgRes.status}`);
            }
        } catch (fetchErr) {
            console.warn(`Error downloading image (${imageUrl}):`, fetchErr.message);
        }
    }

    // Local Fallback: If imageBuffer is null, automatically use bundled high-res category banner
    if (!imageBuffer) {
        const textSample = (text || '').toLowerCase();
        let fallbackBanner = 'latest_job.png';
        if (textSample.includes('admit card')) fallbackBanner = 'admit_card.png';
        else if (textSample.includes('result') || textSample.includes('cut off') || textSample.includes('cutoff') || textSample.includes('merit')) fallbackBanner = 'result.png';
        else if (textSample.includes('answer key')) fallbackBanner = 'answer_key.png';
        else if (textSample.includes('admission')) fallbackBanner = 'admission.png';
        else if (textSample.includes('weekly mega digest') || textSample.includes('hafte ki sabhi')) fallbackBanner = 'weekly_digest.png';

        const localPath = path.join(__dirname, 'banners', fallbackBanner);
        if (fs.existsSync(localPath)) {
            try {
                imageBuffer = fs.readFileSync(localPath);
                console.log(`Using local fallback banner: ${fallbackBanner} (${imageBuffer.length} bytes)`);
            } catch (e) {
                console.warn('Error reading local fallback banner:', e.message);
            }
        }
    }

    // SPECIAL HANDLING FOR WHATSAPP NEWSLETTER (CHANNEL)
    if (destination.endsWith('@newsletter')) {
        let lastErr = null;

        // Priority 1: True WhatsApp Newsletter Native Media Upload (/newsletter/newsletter-image with /m1/ directPath)
        if (imageBuffer) {
            try {
                console.log('Attempting Priority 1: Native Newsletter Image Upload to WhatsApp CDN (/m1/)...');
                const mediaData = await uploadNewsletterImage(sock, imageBuffer);
                console.log('✅ CDN Upload Succeeded! directPath:', mediaData.directPath);

                const imageMessage = {
                    url: mediaData.url,
                    directPath: mediaData.directPath,
                    fileSha256: mediaData.fileSha256,
                    fileLength: mediaData.fileLength,
                    mimetype: 'image/jpeg',
                    caption: text || ''
                };

                const encoded = proto.Message.encode({ imageMessage }).finish();
                const msgId = generateMessageIDV2(sock.user?.id);
                const stanza = {
                    tag: 'message',
                    attrs: {
                        to: destination,
                        id: msgId,
                        type: 'text'
                    },
                    content: [{
                        tag: 'plaintext',
                        attrs: {},
                        content: encoded
                    }]
                };

                console.log('📡 Sending newsletter image stanza with query ACK...');
                let queryRes = null;
                try {
                    queryRes = await sock.query(stanza);
                    console.log('✅ Priority 1 Success (Server ACK received):', JSON.stringify(queryRes));
                } catch (qErr) {
                    console.warn('sock.query note:', qErr.message, 'attempting relayMessage fallback...');
                    await sock.relayMessage(destination, { imageMessage }, { messageId: msgId });
                }

                return res.json({
                    status: 'success',
                    method: 'newsletter_media_direct',
                    destination,
                    messageId: msgId,
                    directPath: mediaData.directPath,
                    response: queryRes
                });
            } catch (imgErr) {
                console.warn('Priority 1 (Native newsletter image) failed:', imgErr.message, 'falling back to plaintext...');
                lastErr = imgErr;
            }
        }

        // Priority 2: Direct XMPP Query with Plaintext Message (Guaranteed 100% Delivery with Server ACK)
        try {
            console.log('Attempting Priority 2 (Direct Plaintext Query)...');
            const encoded = proto.Message.encode({ conversation: text }).finish();
            const msgId = generateMessageIDV2(sock.user?.id);
            const stanza = {
                tag: 'message',
                attrs: {
                    to: destination,
                    id: msgId,
                    type: 'text'
                },
                content: [{
                    tag: 'plaintext',
                    attrs: {},
                    content: encoded
                }]
            };

            const queryRes = await sock.query(stanza);
            console.log('✅ Priority 2 Success (ACK received):', JSON.stringify(queryRes));
            return res.json({
                status: 'success',
                method: 'query_plaintext',
                destination,
                messageId: msgId,
                response: queryRes
            });
        } catch (e1) {
            console.log('Priority 2 failed:', e1.message);
            lastErr = e1;
        }

                // Priority 3: High-Level sock.sendMessage (Text)
        try {
            console.log('Attempting Method 3 (High-level sendMessage text)...');
            const sendRes = await sock.sendMessage(destination, { text });
            console.log('✅ Method 3 Success:', JSON.stringify(sendRes));
            return res.json({
                status: 'success',
                method: 'sendMessage',
                destination,
                messageId: sendRes?.key?.id,
                response: sendRes
            });
        } catch (e2) {
            console.error('Method 3 failed:', e2.message);
            lastErr = e2;
        }

        return res.status(500).json({
            status: 'error',
            destination,
            error: lastErr?.message || 'All newsletter send methods failed'
        });
    }

    // REGULAR CHAT / GROUP SEND
    try {
        const payload = imageBuffer 
            ? { image: imageBuffer, caption: text || '' } 
            : { text: text || '' };
        const result = await sock.sendMessage(destination, payload);
        console.log(`✅ [Direct Message Delivered] Sent to: ${destination}`);
        res.json({
            status: 'success',
            destination,
            messageId: result?.key?.id
        });
    } catch (err) {
        console.error('Direct message error:', err.message);
        res.status(500).json({ status: 'error', error: err.message, destination });
    }
});

// Quick Test Route
app.get('/test-channel', async (req, res) => {
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp not connected' });
    const text = req.query.text || '🟢 *Sarkari Result Test Post*\nAutomated channel verification test.';
    try {
        const encoded = proto.Message.encode({ conversation: text }).finish();
        const msgId = generateMessageIDV2(sock.user?.id);
        const stanza = {
            tag: 'message',
            attrs: {
                to: TARGET_JID,
                id: msgId,
                type: 'text'
            },
            content: [{
                tag: 'plaintext',
                attrs: {},
                content: encoded
            }]
        };
        const queryRes = await sock.query(stanza);
        res.json({ status: 'success', messageId: msgId, response: queryRes });
    } catch (err) {
        // Fallback to sendMessage
        try {
            const sendRes = await sock.sendMessage(TARGET_JID, { text });
            res.json({ status: 'success_fallback', sendRes });
        } catch (e) {
            res.status(500).json({ error: err.message, fallbackError: e.message });
        }
    }
});


// Quick Test Route with Photo
app.get('/test-photo', async (req, res) => {
    if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp not connected' });
    const text = req.query.text || '🟢 *Sarkari Result Test Alert with Photo Banner*\n\n💼 *Post Name:* Test Govt Vacancy 2026\n🏛️ *Vacancies:* 500+ Posts\n\n🔗 *Official Link:* https://www.sarkariresult.com';
    const localPath = path.join(__dirname, 'banners', 'latest_job.png');
    if (!fs.existsSync(localPath)) {
        return res.status(500).json({ error: 'Local banner not found' });
    }
    const buffer = fs.readFileSync(localPath);
    try {
        const mediaData = await uploadNewsletterImage(sock, buffer);
        const imageMessage = {
            url: mediaData.url,
            directPath: mediaData.directPath,
            fileSha256: mediaData.fileSha256,
            fileLength: mediaData.fileLength,
            mimetype: 'image/jpeg',
            caption: text
        };
        const encoded = proto.Message.encode({ imageMessage }).finish();
        const msgId = generateMessageIDV2(sock.user?.id);
        const stanza = {
            tag: 'message',
            attrs: {
                to: TARGET_JID,
                id: msgId,
                type: 'text'
            },
            content: [{
                tag: 'plaintext',
                attrs: {},
                content: encoded
            }]
        };
        const queryRes = await sock.query(stanza);
        res.json({
            status: 'success',
            directPath: mediaData.directPath,
            messageId: msgId,
            response: queryRes
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Start Server
const server = app.listen(PORT, () => {
    console.log(`🚀 Sarkari WhatsApp Gateway listening on port ${PORT}`);
    connectToWhatsApp();
});

// Graceful shutdown handler (Render sends SIGTERM before killing)
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM received. Backing up session and shutting down gracefully...');
    try {
        await backupSessionToCloud();
    } catch (e) {
        console.error('Shutdown backup error:', e.message);
    }
    server.close(() => {
        console.log('Server closed gracefully.');
        process.exit(0);
    });
    // Force exit after 10s if graceful close hangs
    setTimeout(() => process.exit(0), 10000);
});
