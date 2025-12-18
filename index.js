const axios = require('axios');
const Redis = require('ioredis');
const moment = require('moment-timezone');
const express = require('express');

const app = express();
app.use(express.json());

// CONFIG
const MY_STRAVA_ID = process.env.MY_STRAVA_ID;
const MY_TZ = 'Europe/London'; 
const redis = new Redis(process.env.REDIS_URL);
const POLL_INTERVAL_MS = 34 * 60 * 1000;

// STATE
const QUEUE_KEY = 'strava:queue';
const START_TIME_KEY = 'strava:queue_start';
const PROCESSED_KEY = 'strava:processed';
let lastPollTime = Date.now();

// --- AUTH LOGIC ---
async function getAccessToken() {
    try {
        const res = await axios.post('https://www.strava.com/api/v3/oauth/token', {
            client_id: process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            refresh_token: process.env.STRAVA_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        });
        return res.data.access_token;
    } catch (e) {
        console.error("Auth Error:", e.response?.data || e.message);
        return null;
    }
}

// --- ROUTES ---
app.get('/login', (req, res) => {
    const client_id = process.env.STRAVA_CLIENT_ID;
    const redirect = `https://${req.get('host')}/token-callback`;
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${client_id}&response_type=code&redirect_uri=${redirect}&approval_prompt=force&scope=read,activity:read_all,activity:write`;
    res.send(`<body style="background:#121212;color:white;font-family:sans-serif;text-align:center;padding:50px;"><h2 style="color:#fc4c02;">Connect AutoKudos</h2><a href="${authUrl}" style="background:#fc4c02;color:white;padding:15px 30px;text-decoration:none;border-radius:5px;font-weight:bold;">AUTHORIZE BOT</a></body>`);
});

app.get('/token-callback', async (req, res) => {
    try {
        const response = await axios.post('https://www.strava.com/api/v3/oauth/token', {
            client_id: process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            code: req.query.code,
            grant_type: 'authorization_code'
        });
        res.send(`<body style="background:#121212;color:white;font-family:sans-serif;padding:20px;"><h2 style="color:#fc4c02;">Success! ✅</h2><p>Copy this into Render as <b>STRAVA_REFRESH_TOKEN</b>:</p><div style="background:#333;padding:20px;border-radius:10px;word-break:break-all;font-family:monospace;border:1px solid #fc4c02;">${response.data.refresh_token}</div><br><a href="/stats" style="color:#fc4c02;">Go to Dashboard</a></body>`);
    } catch (e) { res.send(`Error: ${e.message}`); }
});

app.post('/webhook', async (req, res) => {
    res.status(200).send('RECEIVED');
    const { object_type, aspect_type, object_id, owner_id } = req.body;
    if (object_type === 'activity' && aspect_type === 'create') {
        if (owner_id == MY_STRAVA_ID) {
            const token = await getAccessToken();
            const rel = await axios.get(`https://www.strava.com/api/v3/activities/${object_id}/related`, { headers: { 'Authorization': `Bearer ${token}` } }).catch(() => ({data:[]}));
            const ids = rel.data.map(a => a.id);
            if (ids.length > 0) await addToQueue(ids);
        } else { await addToQueue([object_id]); }
    }
});

// --- CORE FUNCTIONS ---
async function addToQueue(ids) {
    await redis.sadd(QUEUE_KEY, ...ids);
    if (!(await redis.get(START_TIME_KEY))) await redis.set(START_TIME_KEY, Date.now());
    if (await redis.scard(QUEUE_KEY) >= 25) await fireKudos();
}

async function poll() {
    lastPollTime = Date.now();
    const token = await getAccessToken();
    if (!token) return;
    try {
        const res = await axios.get('https://www.strava.com/api/v3/activities/following', { headers: { 'Authorization': `Bearer ${token}` } });
        const newIds = [];
        for (const act of res.data) {
            if (act.athlete.id == MY_STRAVA_ID) continue;
            if (await redis.sadd(PROCESSED_KEY, act.id)) newIds.push(act.id);
        }
        if (newIds.length > 0) await addToQueue(newIds);
    } catch (e) { console.error("Poll fail"); }
}

async function fireKudos() {
    const items = await redis.spop(QUEUE_KEY, 100);
    if (!items.length) return;
    const token = await getAccessToken();
    if (!token) return;

    for (const id of items) {
        await axios.post(`https://www.strava.com/api/v3/activities/${id}/kudos`, {}, { headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
        await redis.incr('stats:total_sent');
        await new Promise(r => setTimeout(r, 1200));
    }
    await redis.set('stats:last_fired_at', Date.now());
    await redis.del(START_TIME_KEY);
}

app.post('/trawl', async (req, res) => { await poll(); res.redirect('/stats'); });
app.post('/fire', async (req, res) => { await fireKudos(); res.redirect('/stats'); });

// --- DASHBOARD ---
app.get('/stats', async (req, res) => {
    const total = await redis.get('stats:total_sent') || 0;
    const qCount = await redis.scard(QUEUE_KEY);
    const lastF = await redis.get('stats:last_fired_at');
    const nextP = Math.max(0, (lastPollTime + POLL_INTERVAL_MS) - Date.now());
    const lastFmt = lastF ? moment(parseInt(lastF)).tz(MY_TZ).format('HH:mm:ss') : "None";

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;background:#121212;color:white;text-align:center;padding:20px;}.card{background:#1e1e1e;padding:15px;border-radius:12px;border:1px solid #333;margin:10px;display:inline-block;min-width:120px;}.value{font-size:24px;color:#fc4c02;font-weight:bold;}button{background:transparent;color:#fc4c02;border:1px solid #fc4c02;padding:8px;cursor:pointer;border-radius:5px;font-size:12px;}</style><meta http-equiv="refresh" content="30"></head><body><h2 style="color:#fc4c02;">🧡 AutoKudos</h2><div><div class="card">SENT<div class="value">${total}</div></div><div class="card">QUEUE<div class="value">${qCount}</div></div></div><div style="max-width:400px;margin:20px auto;text-align:left;background:#1e1e1e;padding:20px;border-radius:12px;"><div style="display:flex;justify-content:space-between;"><span>Trawl: ${Math.floor(nextP/60000)}m</span><form action="/trawl" method="POST"><button>TRAWL</button></form></div><hr style="border:#333 1px solid;"><div style="display:flex;justify-content:space-between;"><span>Last: ${lastFmt}</span><form action="/fire" method="POST"><button>FIRE</button></form></div></div></body></html>`);
});

setInterval(poll, POLL_INTERVAL_MS);
setInterval(() => axios.get(`https://${req.get('host')}/stats`).catch(()=>{}), 10*60*1000);
app.listen(process.env.PORT || 3000);
