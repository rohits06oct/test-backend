require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Redis = require('ioredis');
const { Pool } = require('pg');
const crypto = require('crypto');
const stringSimilarity = require('string-similarity');
const path = require('path');
const compression = require("compression");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());

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
const memoryErrorLimit = new Map();

app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self' https: data:;");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    next();
});

app.use(cors({
    origin: [
        'https://www.tinybigtalks.online', 'https://tinybigtalks.online',
        'https://www.racenews.online', 'https://racenews.online',
        'https://www.golfreport.online', 'https://golfreport.online',
        'https://www.cricketreport.online', 'https://cricketreport.online',
        'https://www.footballreport.online', 'https://footballreport.online',
        'https://www.techreport.online', 'https://techreport.online',
        'https://www.eodreport.online', 'https://eodreport.online',
        'https://www.financereport.online', 'https://financereport.online',
        'https://rohits06oct.github.io',
        'http://localhost:5500', 'http://127.0.0.1:5500',
        'http://localhost:8000', 'http://127.0.0.1:8000',
        'http://localhost:3000', 'http://127.0.0.1:3000'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Utility: Normalize and Hash
const normalizeComment = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const generateHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Utility: Refresh Comments Cache
const refreshCommentsCache = async (id_article) => {
    const cacheKey = `cache:${id_article}`;
    try {
        const { rows } = await pool.query(
            `SELECT comment, created_at, status 
             FROM public.comments 
             WHERE id_article = $1 AND status = 'approved' 
             ORDER BY created_at DESC`,
            [id_article]
        );

        const comments = rows.map(r => ({
            comment: r.comment,
            created_at: Math.floor(new Date(r.created_at).getTime() / 1000),
            status: r.status
        }));

        const cacheData = JSON.stringify(comments);
        const expiry = 3600; // 1 hour

        if (isRedisAvailable) {
            await redis.set(cacheKey, cacheData, 'EX', expiry);
        } else {
            memoryCache.set(cacheKey, { value: cacheData, expires: Date.now() + (expiry * 1000) });
        }
        return comments;
    } catch (error) {
        console.error(`[CACHE] Error refreshing cache for ${id_article}:`, error);
        return null;
    }
};

// POST: Add Comment
app.post('/api/comments', async (req, res) => {
    const {
        id_article, comment, user_ip, session_id,
        user_agent, browser_lang, device_type, referrer, screen_res
    } = req.body;

    if (!id_article || !comment || !user_ip) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const errorLimitKey = `error:limit:${user_ip}`;
    const blockKey = `error:block:${user_ip}`;

    // Incrementor and Blocker Utility
    const handleFailure = async () => {
        let count;
        if (isRedisAvailable) {
            count = await redis.incr(errorLimitKey);
            if (count === 1) await redis.expire(errorLimitKey, 1800);
            if (count >= 10) {
                await redis.set(blockKey, '1', 'EX', 1800);
            }
        } else {
            const entry = memoryErrorLimit.get(errorLimitKey) || { value: 0, expires: Date.now() + 1800000 };
            entry.value += 1;
            memoryErrorLimit.set(errorLimitKey, entry);
            if (entry.value >= 10) {
                memoryErrorLimit.set(blockKey, { value: '1', expires: Date.now() + 1800000 });
            }
        }
    };

    try {
        // Phase 1: Block Check
        let isBlocked;
        if (isRedisAvailable) {
            isBlocked = await redis.get(blockKey);
        } else {
            const entry = memoryErrorLimit.get(blockKey);
            if (entry && entry.expires > Date.now()) isBlocked = '1';
        }

        if (isBlocked) {
            return res.status(403).json({ error: "You have blocked for 1 month" });
        }

        // Phase 2: Security Checks
        // 1. Length Check
        if (comment.length > 700) {
            await handleFailure();
            return res.status(400).json({ error: "Comment length cannot exceed 700 characters" });
        }

        // 2. Keyword Filter
        const lowerComment = comment.toLowerCase();
        const forbiddenWords = ['sex', 'xxx', 'adult', 'www'];
        if (forbiddenWords.some(word => lowerComment.includes(word))) {
            await handleFailure();
            return res.status(400).json({ error: "You are tyring to provide adult and wrong words" });
        }

        // 3. Character Validation
        // Allowed: alphabets, numbers, ., | and spaces/newlines
        const allowedRegex = /^[a-zA-Z0-9.,| \n\r]+$/;
        if (!allowedRegex.test(comment)) {
            await handleFailure();
            return res.status(400).json({ error: "Only allowed alphabets, numbers and special charchters like .,|" });
        }

        // Phase 3: Existing Rate Limiting & Logic
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
                id_article, comment, status, user_ip, session_id, 
                user_agent, browser_lang, device_type, referrer, 
                screen_res
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                id_article, comment, 'approved', user_ip,
                session_id, user_agent || 'unknown', browser_lang || 'unknown',
                device_type || 'unknown', referrer || 'none',
                screen_res || 'unknown'
            ]
        );

        // 4. Update Redis/Memory State & Proactive Cache Refresh
        const tenMins = 600 * 1000;
        const fiveMins = 300 * 1000;

        if (isRedisAvailable) {
            if (!currentCount) {
                await redis.set(rateLimitKey, 1, 'EX', 600);
            } else {
                await redis.incr(rateLimitKey);
            }
            await redis.set(dupKey, '1', 'EX', 300);
        } else {
            const newCount = (parseInt(currentCount) || 0) + 1;
            memoryRateLimit.set(rateLimitKey, { value: newCount, expires: Date.now() + tenMins });
            memoryDuplicates.set(dupKey, { value: '1', expires: Date.now() + fiveMins });
        }

        // Proactively refresh the comments cache
        await refreshCommentsCache(id_article);

        return res.json({ message: 'Comment posted successfully', status: 'approved' });

    } catch (error) {
        console.error('Error processing comment:', error);
        await handleFailure();
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

        // 2. Cache Miss: Fetch and Refresh
        const comments = await refreshCommentsCache(id_article);

        if (comments === null) {
            throw new Error('Failed to fetch/cache comments');
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
