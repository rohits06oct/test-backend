require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Redis = require('ioredis');
const { Pool } = require('pg');
const crypto = require('crypto');
const stringSimilarity = require('string-similarity');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Pool setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Redis setup with graceful fallback
let redis;
let isRedisAvailable = false;

const initRedis = () => {
    // Only connect if REDIS_URL is provided
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    redis = new Redis(redisUrl, {
        lazyConnect: true,
        retryStrategy: (times) => {
            if (times > 3) {
                console.warn('[REDIS] Could not connect. Falling back to in-memory storage.');
                isRedisAvailable = false;
                return null;
            }
            return Math.min(times * 100, 2000);
        },
    });

    redis.on('error', (err) => { isRedisAvailable = false; });
    redis.on('connect', () => {
        console.log('[REDIS] Connected successfully.');
        isRedisAvailable = true;
    });

    redis.connect().catch(() => { isRedisAvailable = false; });
};

initRedis();

// In-memory fallback stores
const memoryCache = new Map();
const memoryRateLimit = new Map();
const memoryDuplicates = new Map();

app.use(cors({
    origin: ['https://tinybigtalks.online', 'http://localhost:5500', 'http://127.0.0.1:5500'], // Allow production and common local dev ports
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(bodyParser.json());

// Utility: Normalize and Hash
const normalizeComment = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const generateHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

// POST: Add Comment
app.post('/api/comments', async (req, res) => {
    const { 
        id_article, comment, user_ip, session_id, user_city, cookie_id,
        user_agent, browser_lang, device_type, referrer, page_url, screen_res 
    } = req.body;
    
    if (!id_article || !comment || !user_ip) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // 1. Rate Limiting (4 comments / 10 mins)
        const rateLimitKey = `limit:${user_ip}`;
        let currentCount;
        
        if (isRedisAvailable) {
            currentCount = await redis.get(rateLimitKey);
        } else {
            const entry = memoryRateLimit.get(rateLimitKey);
            if (entry && entry.expires > Date.now()) currentCount = entry.value;
        }
        
        if (currentCount && parseInt(currentCount) >= 4) {
            let remainingSeconds = 600;
            if (isRedisAvailable) {
                remainingSeconds = await redis.ttl(rateLimitKey);
            } else {
                const entry = memoryRateLimit.get(rateLimitKey);
                if (entry) remainingSeconds = Math.max(0, Math.floor((entry.expires - Date.now()) / 1000));
            }
            return res.status(429).json({ error: 'Too many comments.', remainingSeconds });
        }

        // 2. Duplicate Detection (5-min window)
        const normalized = normalizeComment(comment);
        const hash = generateHash(normalized);
        const dupKey = `dup:${id_article}:${user_ip}:${hash}`;
        
        let isDuplicate;
        if (isRedisAvailable) {
            isDuplicate = await redis.get(dupKey);
        } else {
            const entry = memoryDuplicates.get(dupKey);
            if (entry && entry.expires > Date.now()) isDuplicate = '1';
        }

        if (isDuplicate) {
            return res.status(400).json({ error: 'Duplicate comment detected.' });
        }

        // 3. PostgreSQL Insertion
        await pool.query(
            `INSERT INTO public.comments (
                id_article, comment, status, user_ip, user_city, session_id, 
                cookie_id, user_agent, browser_lang, device_type, referrer, 
                page_url, screen_res
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
                id_article, comment, 'approved', user_ip, user_city || 'unknown',
                session_id, cookie_id, user_agent || 'unknown', browser_lang || 'unknown',
                device_type || 'unknown', referrer || 'none', page_url || 'unknown',
                screen_res || 'unknown'
            ]
        );

        // 4. Update Redis/Memory State
        const tenMins = 600 * 1000;
        const fiveMins = 300 * 1000;

        if (isRedisAvailable) {
            if (!currentCount) {
                await redis.set(rateLimitKey, 1, 'EX', 600);
            } else {
                await redis.incr(rateLimitKey);
            }
            await redis.set(dupKey, '1', 'EX', 300);
            await redis.del(`cache:${id_article}`);
        } else {
            const newCount = (parseInt(currentCount) || 0) + 1;
            memoryRateLimit.set(rateLimitKey, { value: newCount, expires: Date.now() + tenMins });
            memoryDuplicates.set(dupKey, { value: '1', expires: Date.now() + fiveMins });
            memoryCache.delete(`cache:${id_article}`);
        }

        return res.json({ message: 'Comment posted successfully', status: 'approved' });

    } catch (error) {
        console.error('Error processing comment:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// GET: Get Comments
app.get('/api/comments/:id_article', async (req, res) => {
    const { id_article } = req.params;
    const cacheKey = `cache:${id_article}`;

    try {
        // 1. Check Cache
        let cachedData;
        if (isRedisAvailable) {
            cachedData = await redis.get(cacheKey);
        } else {
            const entry = memoryCache.get(cacheKey);
            if (entry && entry.expires > Date.now()) cachedData = entry.value;
        }

        if (cachedData) {
            return res.json({ id_article, comments: JSON.parse(cachedData) });
        }
        
        // 2. Fetch from Neon
        const { rows } = await pool.query(
            `SELECT comment, created_at, status 
             FROM public.comments 
             WHERE id_article = $1 AND status = 'approved' 
             ORDER BY created_at DESC`,
            [id_article]
        );

        const comments = rows.map(r => ({
            comment: r.comment,
            created_at: Math.floor(new Date(r.created_at).getTime() / 1000), // Convert to unix seconds for frontend compatibility
            status: r.status
        }));

        // 3. Cache results
        if (isRedisAvailable) {
            await redis.set(cacheKey, JSON.stringify(comments), 'EX', 3600);
        } else {
            memoryCache.set(cacheKey, { value: JSON.stringify(comments), expires: Date.now() + 3600000 });
        }

        return res.json({ id_article, comments });

    } catch (error) {
        console.error('Error fetching comments:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
