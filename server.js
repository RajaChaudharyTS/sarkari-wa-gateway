const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || 'sarkari_secret_token_2026';
const TARGET_JID = process.env.WHATSAPP_TARGET_JID || '120363429584632967@newsletter';
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
 * Initializes Baileys WhatsApp Connection
 */
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📡 WhatsApp Web Version: ${version.join('.')} (Latest: ${isLatest})`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000
        });

        sock.ev.on('creds.update', saveCreds);

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
                    console.log('❌ WhatsApp Logged Out! Clearing auth session...');
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
                console.log('====================================================');
                console.log(`🎉 WHATSAPP CONNECTED! User: ${sock.user?.id || 'Unknown'}`);
                console.log(`📢 Default Target Channel JID: ${TARGET_JID}`);
                console.log('====================================================');
            }
        });

        return sock;
    } catch (err) {
        console.error('Initialization error:', err.message);
        setTimeout(connectToWhatsApp, 5000);
    }
}

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

// 2. Status API for Cloudflare Worker Heartbeat
app.get('/status', (req, res) => {
    res.json({
        online: true,
        connected: isConnected,
        user: connectedUser?.id || null,
        targetJid: TARGET_JID,
        uptime: process.uptime()
    });
});

// 3. Web UI to view & scan QR Code
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
            .btn { background: #38bdf8; color: #0f172a; border: none; padding: 12px 24px; border-radius: 10px; font-weight: bold; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 15px; }
            .btn:hover { background: #7dd3fc; }
        </style>
        <script>
            // Auto reload every 5 seconds until connected
            setInterval(() => {
                fetch('/status')
                    .then(res => res.json())
                    .then(data => {
                        if (data.connected) {
                            location.reload();
                        }
                    })
                    .catch(() => {});
            }, 4000);
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
                <p style="font-size: 13px; color: #64748b; margin-top: 15px;">Your Cloudflare Worker will now send all Sarkari Job alerts through this session for free!</p>
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
                        <li>Tap <b>Menu (3 dots)</b> or <b>Settings</b> &rarr; <b>Linked Devices</b></li>
                        <li>Tap <b>Link a Device</b> and point your camera at this QR Code!</li>
                    </ol>
                </div>
            `}
        </div>
    </body>
    </html>
    `);
});

// 4. Request Phone Pairing Code (Alternative to QR)
app.get('/pair', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) {
        return res.status(400).json({ error: 'Missing phone query parameter. Example: /pair?phone=919473128739' });
    }
    if (isConnected) {
        return res.json({ message: 'WhatsApp is already connected!', user: connectedUser?.id });
    }
    if (!sock) {
        return res.status(503).json({ error: 'Socket is not initialized yet. Try again in 3 seconds.' });
    }

    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanPhone);
        res.json({
            status: 'success',
            phone: cleanPhone,
            pairingCode: code,
            instructions: 'In WhatsApp: Settings -> Linked Devices -> Link a Device -> Link with phone number instead'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Send Alert to Channel (Target of Cloudflare Worker)
app.post('/send', async (req, res) => {
    // Check Authorization Secret
    const authHeader = req.headers.authorization;
    if (GATEWAY_SECRET && (!authHeader || authHeader !== `Bearer ${GATEWAY_SECRET}`)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid GATEWAY_SECRET' });
    }

    if (!isConnected || !sock) {
        return res.status(503).json({
            error: 'WhatsApp is not connected yet. Please visit /qr to scan QR code.',
            connected: false
        });
    }

    const { text, targetJid } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Missing "text" in JSON body' });
    }

    const destination = targetJid || TARGET_JID;

    try {
        const result = await sock.sendMessage(destination, { text });
        console.log(`✅ [Alert Delivered] Sent to: ${destination}`);
        res.json({
            status: 'success',
            destination,
            messageId: result?.key?.id,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Failed to send WhatsApp alert:', err);
        res.status(500).json({
            status: 'error',
            error: err.message,
            destination
        });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Sarkari WhatsApp Gateway listening on port ${PORT}`);
    console.log(`👉 Open http://localhost:${PORT}/qr to link WhatsApp`);
    connectToWhatsApp();
});
