// =============================================================================
// server.js: STREAMNET API server (v4, stability rewrite)
//
// What this server does:
//   - Serves your front-end (public/index.html, or index.html next to this file)
//   - Proxies TMDB and YouTube so your API keys never reach the browser
//   - Caches every upstream answer, and serves a stale copy if TMDB/YouTube
//     is down, slow or out of quota (stale data beats a blank page)
//   - Optionally proxies TMDB posters (/img/<size>/<file>) so they load reliably
//
// Setup:
//   npm install express axios compression express-rate-limit node-cache dotenv
//   Create a .env file next to this file (see the list of variables below).
//
// Environment variables:
//   TMDB_API_KEY      (required)  your TMDB v3 key
//   YOUTUBE_API_KEY   (optional)  only needed for /api/youtube/*
//   PORT              (optional)  default 3000
//   TRUST_PROXY       (optional)  set to 1 when behind a tunnel / reverse proxy,
//                                 so rate limiting sees real visitor IPs
//   USE_IMAGE_PROXY   (optional)  set to 1 to make /api/media return posters
//                                 and backdrops through /img/...
//   ALLOWED_ORIGIN    (optional)  CORS origin, default *
//   ADMIN_TOKEN       (optional)  enables POST /api/cache/clear (Bearer token)
// =============================================================================
'use strict';

try { require('dotenv').config(); } catch { /* dotenv is optional */ }

const express = require('express');
const axios = require('axios');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream');

// =============================================================================
// CONFIGURATION
// =============================================================================
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const USE_IMG_PROXY = process.env.USE_IMAGE_PROXY === '1';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const TMDB_IMG_HOST = 'https://image.tmdb.org';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const TMDB_FRESH_MS = 10 * MINUTE;      // serve from cache without asking TMDB
const YT_FRESH_MS = 6 * HOUR;           // YouTube search quota is tiny, so cache longer
const STALE_TTL_SECONDS = 7 * 24 * 3600; // how long we keep a copy as an emergency fallback
const MAX_CACHE_KEYS = 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_INDEX = path.join(__dirname, 'index.html');
const CACHE_DIR = path.join(__dirname, 'cache');
const LOG_DIR = path.join(__dirname, 'logs');
const CACHE_FILE = path.join(CACHE_DIR, 'api-cache.json');

for (const dir of [CACHE_DIR, LOG_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* handled when we try to write */ }
}

// =============================================================================
// LOGGING (never throws, never blocks the event loop)
// =============================================================================
function logError(context, error, metadata = {}) {
    const err = error instanceof Error ? error : new Error(String(error));
    const entry = {
        timestamp: new Date().toISOString(),
        context,
        error: err.message,
        stack: err.stack,
        metadata
    };
    const file = path.join(LOG_DIR, `error-${entry.timestamp.slice(0, 10)}.log`);
    fs.appendFile(file, JSON.stringify(entry) + '\n', () => { /* ignore log write errors */ });
    console.error(`[${context}] ${err.message}`);
}

function logInfo(context, message, data = {}) {
    const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    console.log(`[${context}] ${message}${extra}`);
}

if (!TMDB_KEY) logError('CONFIG', new Error('TMDB_API_KEY is not set, so movie data requests will fail'));
if (!YT_KEY) logInfo('CONFIG', 'YOUTUBE_API_KEY is not set, so /api/youtube/* is disabled');

// =============================================================================
// CACHE
// Each entry is { data, ts }. "ts" lets us decide between fresh and stale.
// =============================================================================
const apiCache = new NodeCache({
    stdTTL: STALE_TTL_SECONDS,
    checkperiod: 600,
    useClones: false,
    maxKeys: MAX_CACHE_KEYS
});

// NodeCache throws when maxKeys is exceeded. We drop the oldest entries instead.
function cacheSet(key, value) {
    try {
        apiCache.set(key, value);
    } catch {
        const oldest = apiCache.keys()
            .map(k => [k, apiCache.get(k)?.ts || 0])
            .sort((a, b) => a[1] - b[1])
            .slice(0, 500)
            .map(e => e[0]);
        apiCache.del(oldest);
        try { apiCache.set(key, value); } catch (e) { logError('CACHE_SET', e); }
    }
}

function loadCacheFromDisk() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        let loaded = 0;
        for (const [key, value] of Object.entries(raw)) {
            const valid = value && typeof value.ts === 'number' && 'data' in value &&
                          Date.now() - value.ts < STALE_TTL_SECONDS * 1000;
            if (valid) { cacheSet(key, value); loaded++; }
        }
        logInfo('CACHE', `Loaded ${loaded} entries from disk`);
    } catch (err) {
        logError('CACHE_LOAD', err);
    }
}

let saving = false;
async function saveCacheToDisk() {
    if (saving) return;
    saving = true;
    try {
        const snapshot = {};
        for (const key of apiCache.keys()) {
            const value = apiCache.get(key);
            if (value && typeof value.ts === 'number') snapshot[key] = value;
        }
        // Write to a temp file, then rename. A crash mid-write can't corrupt the real file.
        const tmp = CACHE_FILE + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(snapshot));
        await fsp.rename(tmp, CACHE_FILE);
    } catch (err) {
        logError('CACHE_SAVE', err);
    } finally {
        saving = false;
    }
}

loadCacheFromDisk();
setInterval(saveCacheToDisk, 5 * MINUTE).unref();

// =============================================================================
// UPSTREAM HTTP CLIENTS
// Timeouts everywhere (axios waits forever by default) and keep-alive
// connections so we don't pay for a new TLS handshake on every request.
// =============================================================================
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 30 });

const tmdbClient = axios.create({
    baseURL: TMDB_BASE,
    timeout: 8000,
    httpsAgent,
    headers: { Accept: 'application/json' }
});

const ytClient = axios.create({
    baseURL: YT_BASE,
    timeout: 8000,
    httpsAgent,
    headers: { Accept: 'application/json' }
});

const imageClient = axios.create({
    baseURL: TMDB_IMG_HOST,
    timeout: 10000,
    httpsAgent
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// GET with up to 2 retries on network errors, 5xx and 429 (never on other 4xx).
async function upstreamGet(client, url, params, retries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const { data } = await client.get(url, { params });
            return data;
        } catch (err) {
            lastError = err;
            const status = err.response?.status;
            const retryable = !status || status >= 500 || status === 429;
            if (!retryable || attempt === retries) break;
            await sleep(300 * 2 ** attempt + Math.random() * 200);
        }
    }
    throw lastError;
}

// Cache-first fetch with three protections:
//   1. fresh cache hit      -> no network call at all
//   2. identical requests already in flight share ONE upstream call
//   3. upstream failure     -> serve the stale copy if we have one
const inflight = new Map();

async function cachedFetch(key, freshMs, fetcher) {
    const entry = apiCache.get(key);
    if (entry && Date.now() - entry.ts < freshMs) {
        return { data: entry.data, source: 'cache' };
    }
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
        try {
            const data = await fetcher();
            cacheSet(key, { data, ts: Date.now() });
            return { data, source: 'network' };
        } catch (err) {
            if (entry) {
                logInfo('CACHE', 'Upstream failed, serving stale copy', { key });
                return { data: entry.data, source: 'stale' };
            }
            throw err;
        }
    })();

    inflight.set(key, promise);
    const release = () => inflight.delete(key);
    promise.then(release, release);
    return promise;
}

// Turns req.query into a plain { string: string } object and strips any
// api_key/key a client tries to smuggle in.
function cleanQuery(query) {
    const out = {};
    for (const [k, v] of Object.entries(query || {})) {
        if (k === 'api_key' || k === 'key') continue;
        if (Array.isArray(v)) out[k] = v.join(',');
        else if (typeof v === 'object') continue; // ignore nested objects (a[b]=c)
        else out[k] = String(v);
    }
    return out;
}

function cacheKey(prefix, pathname, query) {
    const qs = Object.keys(query).sort().map(k => `${k}=${query[k]}`).join('&');
    return `${prefix}:${pathname}?${qs}`;
}

function tmdbGet(pathname, query = {}) {
    return cachedFetch(
        cacheKey('tmdb', pathname, query),
        TMDB_FRESH_MS,
        () => upstreamGet(tmdbClient, `/${pathname}`, { ...query, api_key: TMDB_KEY })
    );
}

function ytGet(pathname, query = {}) {
    return cachedFetch(
        cacheKey('yt', pathname, query),
        YT_FRESH_MS,
        () => upstreamGet(ytClient, `/${pathname}`, { ...query, key: YT_KEY }, 1)
    );
}

// Never leak upstream error text (it can contain URLs or key hints).
function sendUpstreamError(res, err, label) {
    logError(label, err);
    const status = err.response?.status;
    if (status && status >= 400 && status < 500) {
        return res.status(status).json({ error: 'The data provider rejected this request', status });
    }
    return res.status(502).json({ error: 'The data provider is not responding, please retry' });
}

const requireKey = (name, value) => (req, res, next) =>
    value ? next() : res.status(500).json({ error: `Server is missing ${name}` });

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// =============================================================================
// APP SETUP
// =============================================================================
const app = express();

if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v);
}

app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'X-Cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR));

// Falls back to ./index.html if you keep the front-end next to server.js.
// (If public/index.html exists, express.static has already answered by now.)
app.get('/', (req, res) => {
    if (fs.existsSync(ROOT_INDEX)) return res.sendFile(ROOT_INDEX);
    res.status(404).send('index.html not found. Put it in ./public/ or next to server.js.');
});

// 300 requests per minute per visitor. The old limit was 100 per 15 minutes,
// which a single home-page load plus a few searches could use up.
app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
    message: { error: 'Too many requests, please slow down a little.' }
}));

// =============================================================================
// ROUTES
// =============================================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        cacheEntries: apiCache.keys().length,
        tmdbConfigured: Boolean(TMDB_KEY),
        youtubeConfigured: Boolean(YT_KEY)
    });
});

// ---- TMDB proxy (/api/tmdb/movie/popular, /api/tmdb/search/multi, ...) --------
// Mounted with app.use + req.path instead of a '*' wildcard, so it works on
// both Express 4 and Express 5.
const SAFE_PATH = /^[A-Za-z0-9_\-/]+$/;

app.use('/api/tmdb', requireKey('TMDB_API_KEY', TMDB_KEY), async (req, res, next) => {
    if (req.method !== 'GET') return next();
    const p = req.path.replace(/^\/+|\/+$/g, '');
    if (!p || !SAFE_PATH.test(p)) return res.status(400).json({ error: 'Invalid TMDB path' });

    try {
        const { data, source } = await tmdbGet(p, cleanQuery(req.query));
        res.set('X-Cache', source);
        res.json(data);
    } catch (err) {
        sendUpstreamError(res, err, 'TMDB_PROXY');
    }
});

// ---- YouTube proxy (only the endpoints the site actually needs) ---------------
const YT_ALLOWED = new Set(['search', 'videos']);

app.use('/api/youtube', requireKey('YOUTUBE_API_KEY', YT_KEY), async (req, res, next) => {
    if (req.method !== 'GET') return next();
    const p = req.path.replace(/^\/+|\/+$/g, '');
    if (!YT_ALLOWED.has(p)) return res.status(404).json({ error: 'Unsupported YouTube endpoint' });

    try {
        const { data, source } = await ytGet(p, cleanQuery(req.query));
        res.set('X-Cache', source);
        res.json(data);
    } catch (err) {
        sendUpstreamError(res, err, 'YT_PROXY');
    }
});

// ---- Movie / TV details -------------------------------------------------------
const ID_RE = /^\d{1,10}$/;

// Details and videos load independently. If only the videos call fails, you
// still get the movie, just without a trailer.
async function loadDetailsAndVideos(type, id) {
    const [details, videos] = await Promise.allSettled([
        tmdbGet(`${type}/${id}`),
        tmdbGet(`${type}/${id}/videos`)
    ]);
    if (details.status === 'rejected') throw details.reason;
    if (videos.status === 'rejected') logError('TMDB_VIDEOS', videos.reason, { type, id });

    return {
        details: details.value.data,
        videos: videos.status === 'fulfilled' ? (videos.value.data.results || []) : []
    };
}

function pickTrailer(videos) {
    const yt = videos.filter(v => v.site === 'YouTube');
    return yt.find(v => v.type === 'Trailer' && v.official) ||
           yt.find(v => v.type === 'Trailer') ||
           yt.find(v => v.type === 'Teaser') ||
           null;
}

function imageUrl(size, filePath) {
    if (!filePath) return null;
    return USE_IMG_PROXY ? `/img/${size}${filePath}` : `${TMDB_IMG_HOST}/t/p/${size}${filePath}`;
}

app.get('/api/movie/:id', requireKey('TMDB_API_KEY', TMDB_KEY), async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid movie id' });

    try {
        const { details, videos } = await loadDetailsAndVideos('movie', id);
        const trailer = pickTrailer(videos);
        res.json({ ...details, trailerKey: trailer?.key || null });
    } catch (err) {
        sendUpstreamError(res, err, 'API_MOVIE');
    }
});

app.get('/api/media/:id', requireKey('TMDB_API_KEY', TMDB_KEY), async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
    const type = req.query.type === 'tv' ? 'tv' : 'movie';

    try {
        const { details: d, videos } = await loadDetailsAndVideos(type, id);
        const releaseDate = d.release_date || d.first_air_date || null;
        const year = releaseDate ? (parseInt(releaseDate.slice(0, 4), 10) || null) : null;
        const trailer = pickTrailer(videos);

        res.json({
            id: d.id,
            type,
            title: d.title || d.name || 'Unknown',
            year,
            overview: d.overview || '',
            poster: imageUrl('w500', d.poster_path),
            backdrop: imageUrl('w1280', d.backdrop_path),
            rating: d.vote_average ?? null,
            genres: (d.genres || []).map(g => g.name),
            runtime: d.runtime ?? null,
            trailer: trailer ? {
                key: trailer.key,
                name: trailer.name,
                embedUrl: `https://www.youtube.com/embed/${trailer.key}`,
                watchUrl: `https://www.youtube.com/watch?v=${trailer.key}`
            } : null
        });
    } catch (err) {
        sendUpstreamError(res, err, 'API_MEDIA');
    }
});

// ---- Poster / backdrop proxy ---------------------------------------------------
// Optional. Use it by loading images from /img/w500/<file>.jpg instead of
// image.tmdb.org. The browser caches them for a week.
const IMG_SIZES = new Set(['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280', 'h632', 'original']);
const IMG_FILE_RE = /^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i;

app.get('/img/:size/:file',
    rateLimit({ windowMs: 60 * 1000, max: 1200, standardHeaders: true, legacyHeaders: false }),
    async (req, res) => {
        const { size, file } = req.params;
        if (!IMG_SIZES.has(size) || !IMG_FILE_RE.test(file)) return res.status(400).end();

        try {
            const upstream = await imageClient.get(`/t/p/${size}/${file}`, { responseType: 'stream' });
            res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
            if (upstream.headers['content-length']) {
                res.setHeader('Content-Length', upstream.headers['content-length']);
            }
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
            // pipeline cleans up both streams if the visitor closes the page mid-load
            pipeline(upstream.data, res, (err) => {
                if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logError('IMG_PROXY', err);
            });
        } catch (err) {
            if (!res.headersSent) res.status(err.response?.status === 404 ? 404 : 502).end();
        }
    }
);

// ---- Admin: clear the cache (disabled unless ADMIN_TOKEN is set) --------------
app.post('/api/cache/clear', (req, res) => {
    if (!ADMIN_TOKEN) return res.status(404).json({ error: 'Not found' });
    if (!safeEqual(req.get('Authorization') || '', `Bearer ${ADMIN_TOKEN}`)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    apiCache.flushAll();
    saveCacheToDisk();
    res.json({ success: true, message: 'Cache cleared' });
});

// ---- Fallbacks ------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Last-resort error handler: always answers with JSON instead of hanging.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logError('EXPRESS', err, { url: req.originalUrl });
    if (res.headersSent) return next(err);
    const clientError = err.status && err.status < 500;
    res.status(clientError ? err.status : 500)
       .json({ error: clientError ? 'Bad request' : 'Internal server error' });
});

// =============================================================================
// PROCESS SAFETY NETS
// =============================================================================
process.on('unhandledRejection', (reason) => {
    logError('UNHANDLED_REJECTION', reason);
});

// After an uncaught exception Node's state is unreliable, so we log and exit.
// Run the server under pm2 / systemd / nodemon so it restarts straight away.
process.on('uncaughtException', (err) => {
    logError('UNCAUGHT_EXCEPTION', err);
    process.exit(1);
});

// =============================================================================
// START + GRACEFUL SHUTDOWN
// =============================================================================
const server = app.listen(PORT, HOST, () => {
    console.log(`STREAMNET server running on http://${HOST}:${PORT}  (cache: ${apiCache.keys().length} entries)`);
});

// Keep idle connections open a little longer than typical proxies do,
// which prevents random ECONNRESET errors behind tunnels and load balancers.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

server.on('error', (err) => {
    logError('LISTEN', err); // for example EADDRINUSE when the port is already taken
    process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo('SHUTDOWN', `${signal} received, saving cache`);
    await saveCacheToDisk();
    server.close(() => process.exit(0));
    if (server.closeIdleConnections) server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
