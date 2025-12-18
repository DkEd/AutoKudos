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

// KEYS
const QUEUE_KEY = 'strava:queue';
const START_TIME_KEY = 'strava:queue_start';
const PROCESSED_KEY = 'strava:processed';
let lastPollTime = Date.now();

// --- TOKEN LOGIC (The "Sign In" part) ---
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

// 1. WEBHOOK RECEIVER
app.post('/webhook', async (req, res) => {
    res.status(200).send('FORWARD_RECEIVED');
    const { object_type, aspect_type, object_id, owner_id } = req.body;

    if (object_type === 'activity' && aspect_type === 'create') {
        if (owner_id == MY_STRAVA_ID) {
            const token = await getAccessToken();
            try {
                const rel = await axios.get(`https://www.strava.com/api/v3/activities/${object_id}/related`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const ids = rel.data.map(a => a.id);
                if (ids.length > 0) await addToQueue(ids);
            } catch (e) { console.error("Related fetch failed"); }
        } else {
            await addToQueue([object_id]);
        }
    }
});

// 2. POLLING & MANUAL ACTIONS
async function poll() {
    lastPollTime = Date.now();
    const hour = moment().tz(MY_TZ).hour();
    if (hour >= 23 || hour < 6) return; 

    const token = await getAccessToken();
    if (!token) return;

    try {
        const res = await axios.get('https://www.strava.com/api/v3/activities/following', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const newIds = [];
        for (const act of res.data) {
            if (act.athlete.id == MY_STRAVA_ID) continue;
            const isNew = await redis.sadd(PROCESSED_KEY, act.id);
            if (isNew) newIds.push(act.id);
        }
        if (newIds.length > 0) await addToQueue(newIds);
    } catch (e) { console.error("Poll error"); }
}

app.post('/trawl', async (req, res) => { await poll(); res.redirect('/stats'); });
app.post('/fire', async (req, res) => { await fireKudos(); res.redirect('/stats'); });

// 3. QUEUE & KUDOS LOGIC
async function addToQueue(ids) {
    await redis.sadd(QUEUE_KEY, ...ids);
    let startTime = await redis.get(START_TIME_KEY);
    if (!startTime) {
        startTime = Date.now();
        await redis.set(START_TIME_KEY, startTime);
    }
    const count = await redis.scard(QUEUE_KEY);
    const timeInQueue = Date.now() - parseInt(startTime);
    if (count >= 25 || timeInQueue > 3600000) await fireKudos();
}

async function fireKudos() {
    const items = await redis.spop(QUEUE_KEY, 100);
    if (items.length === 0) return;

    const token = await getAccessToken();
    if (!token) return;

    const today = moment().tz(MY_TZ).format('YYYY-MM-DD');
    const lastDay = await redis.get('stats:last_day');
    if (lastDay !== today) {
        await redis.incr('stats:days_active');
        await redis.set('stats:last_day', today);
    }

    for (const id of items) {
        try {
            await axios.post(`https://www.strava.com/api/v3/activities/${id}/kudos`, {}, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            await redis.incr('stats:total_sent');
            await new Promise(r => setTimeout(r, 1500)); 
        } catch (e) { console.error(`Kudos failed: ${id}`); }
    }
    await redis.set('stats:last_fired_at', Date.now());
    await redis.del(START_TIME_KEY);
}

// 4. DASHBOARD
app.get('/stats', async (req, res) => {
    const total = parseInt(await redis.get('stats:total_sent')) || 0;
    const days = parseInt(await redis.get('stats:days_active')) || 1;
    const queueCount = await redis.scard(QUEUE_KEY);
    const lastFired = await redis.get('stats:last_fired_at');

    const nextPollInMs = Math.max(0, (lastPollTime + POLL_INTERVAL_MS) - Date.now());
    const nextPollMinutes = Math.floor(nextPollInMs / 60000);
    const nextPollSeconds = Math.floor((nextPollInMs % 60000) / 1000);
    const progressPercent = Math.round(((POLL_INTERVAL_MS - nextPollInMs) / POLL_INTERVAL_MS) * 100);

    const lastFiredFormatted = lastFired 
        ? moment(parseInt(lastFired)).tz(MY_TZ).format('HH:mm:ss (DD MMM)') 
        : "Pending...";

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>AutoKudos</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: -apple-system, sans-serif; background: #121212; color: white; text-align: center; padding: 20px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; max-width: 500px; margin: 20px auto; }
            .card { background: #1e1e1e; padding: 15px; border-radius: 12px; border: 1px solid #333; }
            .label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 5px; }
            .value { font-size: 22px; font-weight: bold; color: #fc4c02; }
            .bar-container { background: #333; border-radius: 10px; height: 8px; margin: 15px 0; }
            .bar { background: #fc4c02; height: 100%; border-radius: 10px; width: ${progressPercent}%; transition: width 1s linear; }
            button { background: transparent; color: #fc4c02; border: 1px solid #fc4c02; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 11px; font-weight: bold; }
            button:hover { background: #fc4c02; color: white; }
            .section { max-width: 500px; margin: 20px auto; text-align: left; background: #1e1e1e; padding: 20px; border-radius: 12px; border: 1px solid #333; }
        </style>
        <meta http-equiv="refresh" content="30">
    </head>
    <body>
        <h2 style="color: #fc4c02; margin-bottom: 5px;">🧡 AutoKudos Dashboard</h2>
        <div class="grid">
            <div class="card"><div class="label">Total Sent</div><div class="value">${total}</div></div>
            <div class="card"><div class="label">Daily Avg</div><div class="value">${(total / days).toFixed(1)}</div></div>
            <div class="card"><div class="label">Queue</div><div class="value">${queueCount}</div></div>
        </div>
        <div class="section">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div class="label">Next Trawl: ${nextPollMinutes}m ${nextPollSeconds}s</div>
                <form action="/trawl" method="POST"><button type="submit">TRAWL NOW</button></form>
            </div>
            <div class="bar-container"><div class="bar"></div></div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 20px;">
                <div class="label">Last Fire: <span style="color:white; text-transform:none;">${lastFiredFormatted}</span></div>
                <form action="/fire" method="POST"><button type="submit">FIRE QUEUE</button></form>
            </div>
        </div>
    </body>
    </html>
    `);
});

// 5. START & KEEP ALIVE
setInterval(poll, POLL_INTERVAL_MS);
setInterval(() => { axios.get('https://autokudos.onrender.com/stats').catch(() => {}); }, 10 * 60 * 1000);
app.listen(process.env.PORT || 3000, () => console.log("AutoKudos Online"));
