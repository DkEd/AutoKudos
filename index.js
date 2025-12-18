const axios = require('axios');
const Redis = require('ioredis');
const moment = require('moment-timezone');
const express = require('express');

const app = express();
app.use(express.json());

// CONFIGURATION
const MY_STRAVA_ID = process.env.MY_STRAVA_ID;
const MY_TZ = 'Europe/London'; 
const redis = new Redis(process.env.REDIS_URL);

// KEYS
const QUEUE_KEY = 'strava:queue';
const START_TIME_KEY = 'strava:queue_start';
const PROCESSED_KEY = 'strava:processed';
const STATS_KEY = 'strava:stats';

// 1. WEBHOOKS
app.post('/webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    const { object_type, aspect_type, object_id, owner_id } = req.body;

    if (object_type === 'activity' && aspect_type === 'create') {
        if (owner_id == MY_STRAVA_ID) {
            // Your activity - fetch group
            const rel = await axios.get(`https://www.strava.com/api/v3/activities/${object_id}/related`, {
                headers: { 'Authorization': `Bearer ${process.env.STRAVA_ACCESS_TOKEN}` }
            });
            const ids = rel.data.map(a => a.id);
            if (ids.length > 0) await addToQueue(ids);
        } else {
            await addToQueue([object_id]);
        }
    }
});

// 2. POLLER (Every 34 mins)
async function poll() {
    const hour = moment().tz(MY_TZ).hour();
    if (hour >= 23 || hour < 6) return; // Sleep

    try {
        const res = await axios.get('https://www.strava.com/api/v3/activities/following', {
            headers: { 'Authorization': `Bearer ${process.env.STRAVA_ACCESS_TOKEN}` }
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

// 3. LOGIC ENGINE
async function addToQueue(ids) {
    await redis.sadd(QUEUE_KEY, ...ids);
    
    // Set timestamp if queue was empty
    const exists = await redis.get(START_TIME_KEY);
    if (!exists) await redis.set(START_TIME_KEY, Date.now());

    const count = await redis.scard(QUEUE_KEY);
    const timeInQueue = Date.now() - (parseInt(exists) || Date.now());

    // Fire if 25 items OR 1 hour has passed
    if (count >= 25 || timeInQueue > 3600000) {
        await fireKudos();
    }
}

async function fireKudos() {
    const items = await redis.spop(QUEUE_KEY, 82);
    
    // Day Tracking Logic
    const today = moment().tz(MY_TZ).format('YYYY-MM-DD');
    const lastDay = await redis.get('stats:last_day');
    if (lastDay !== today) {
        await redis.incr('stats:days_active');
        await redis.set('stats:last_day', today);
    }

    for (const id of items) {
        try {
            await axios.post(`https://www.strava.com/api/v3/activities/${id}/kudos`, {}, {
                headers: { 'Authorization': `Bearer ${process.env.STRAVA_ACCESS_TOKEN}` }
            });
            await redis.incr('stats:total_sent');
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {}
    }
    await redis.del(START_TIME_KEY);
}

// 4. STATS ENDPOINT
app.get('/stats', async (req, res) => {
    const total = parseInt(await redis.get('stats:total_sent')) || 0;
    const days = parseInt(await redis.get('stats:days_active')) || 1;
    res.json({ total, days, average: (total / days).toFixed(2) });
});

setInterval(poll, 34 * 60 * 1000);
app.listen(process.env.PORT || 3000);
