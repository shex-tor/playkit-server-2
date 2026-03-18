// =============================================================================
// server.js — PLAYKIT Movie Download Server v3
// Strategy: vidsrc embed links (server) + FZMovies via browser proxy (client)
// =============================================================================

const express     = require('express');
const axios       = require('axios');
const axiosRetry  = require('axios-retry').default;
const NodeCache   = require('node-cache');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CORS & MIDDLEWARE
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
}));

// =============================================================================
// CONFIG
// =============================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

[path.join(__dirname, 'cache'), path.join(__dirname, 'logs'), path.join(os.tmpdir(), 'playkit')].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// =============================================================================
// CACHE
// =============================================================================
const cache = new NodeCache({ stdTTL: 43200, checkperiod: 3600 });

// =============================================================================
// LOGGING
// =============================================================================
const logInfo  = (ctx, msg) => console.log(`✅ [${ctx}] ${msg}`);
const logError = (ctx, err) => console.error(`❌ [${ctx}] ${err.message || err}`);

// =============================================================================
// AXIOS
// =============================================================================
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: e => axiosRetry.isNetworkOrIdempotentRequestError(e) || e.response?.status >= 500
});

const http = axios.create({
    timeout: 15000,
    maxRedirects: 5,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
});

// =============================================================================
// VIDSRC EMBED LINK BUILDER
// Returns embed page URLs per quality — these are publicly available endpoints
// that work without any scraping and are accessible from Render free tier.
// =============================================================================
function buildEmbedLinks(tmdbId) {
    return {
        '1080p': { url: `https://vidsrc.to/embed/movie/${tmdbId}`,                              source: 'vidsrc.to',    type: 'embed' },
        '720p':  { url: `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}`,                        source: 'vidsrc.xyz',   type: 'embed' },
        '480p':  { url: `https://embed.su/embed/movie/${tmdbId}`,                               source: 'embed.su',     type: 'embed' },
        '360p':  { url: `https://multiembed.mov/directstream.php?video_id=${tmdbId}&s=movie`,   source: 'multiembed',   type: 'embed' }
    };
}

// =============================================================================
// API ROUTES
// =============================================================================

// Health
app.get('/api/health', (req, res) => res.json({
    status: 'ok', uptime: Math.floor(process.uptime()),
    cache: cache.keys().length, timestamp: Date.now()
}));

// ------------------------------------------------------------------
// GET /api/download/options/:id
// ------------------------------------------------------------------
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cacheKey = `options_${id}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json({ ...cached, cached: true });

        const tmdbRes = await http.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
        const movie   = tmdbRes.data;
        const year    = new Date(movie.release_date).getFullYear();
        const runtime = movie.runtime || 120;

        const embedLinks = buildEmbedLinks(id);
        const sizeMap    = { '1080p': 25, '720p': 12, '480p': 8, '360p': 5 };

        const options = ['1080p', '720p', '480p', '360p'].map(quality => {
            const link    = embedLinks[quality];
            const sizeMB  = Math.round(runtime * sizeMap[quality]);
            return {
                quality,
                label:     `${quality} - H.264`,
                size:      sizeMB,
                sizeText:  sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`,
                url:       link.url,
                source:    link.source,
                type:      link.type,
                sources:   [link.url],
                available: true
            };
        });

        const payload = {
            movie: {
                id: movie.id, title: movie.title, year, runtime,
                poster:   `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                backdrop: `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`
            },
            options,
            fzmovies: { title: movie.title, year }
        };

        cache.set(cacheKey, payload);
        logInfo('OPTIONS', `"${movie.title}" (${year}) — ${options.length} options ready`);
        res.json(payload);

    } catch (err) {
        logError('OPTIONS', err);
        res.status(500).json({ error: 'Failed to fetch download options', details: err.message });
    }
});

// ------------------------------------------------------------------
// GET /api/download?movieId=&quality=&title=
// ------------------------------------------------------------------
app.get('/api/download', async (req, res) => {
    try {
        const { movieId, quality, title } = req.query;
        if (!movieId || !quality) return res.status(400).json({ error: 'Missing movieId or quality' });

        const link = buildEmbedLinks(movieId)[quality] || buildEmbedLinks(movieId)['720p'];
        const safe = (title || 'movie').replace(/[^a-z0-9]/gi, '_');

        logInfo('DOWNLOAD', `${title} (${quality}) → ${link.url}`);
        res.json({ success: true, url: link.url, quality, source: link.source, type: link.type, filename: `${safe}_${quality}.mp4` });

    } catch (err) {
        logError('DOWNLOAD', err);
        res.status(500).json({ error: 'Download failed', details: err.message });
    }
});

// ------------------------------------------------------------------
// GET /api/download/proxy?url=...
// Pipes any remote URL through the server to bypass CORS.
// Used by frontend for FZMovies direct .mp4 links.
// ------------------------------------------------------------------
app.get('/api/download/proxy', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'Missing url parameter' });

        const decoded = decodeURIComponent(url);
        logInfo('PROXY', decoded);

        const remote = await axios({
            method: 'GET', url: decoded, responseType: 'stream',
            timeout: 60000, maxRedirects: 10,
            headers: { 'User-Agent': UA, 'Referer': 'https://www.fzmovies.net/' }
        });

        const h = remote.headers;
        if (h['content-type'])        res.setHeader('Content-Type', h['content-type']);
        if (h['content-length'])      res.setHeader('Content-Length', h['content-length']);
        if (h['content-disposition']) res.setHeader('Content-Disposition', h['content-disposition']);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

        remote.data.pipe(res);
        remote.data.on('error', () => { if (!res.headersSent) res.status(500).end(); });

    } catch (err) {
        logError('PROXY', err);
        if (!res.headersSent) res.status(500).json({ error: 'Proxy failed', details: err.message });
    }
});

// ------------------------------------------------------------------
// GET /api/movie/:id
// ------------------------------------------------------------------
app.get('/api/movie/:id', async (req, res) => {
    try {
        const [mRes, vRes] = await Promise.all([
            http.get(`https://api.themoviedb.org/3/movie/${req.params.id}?api_key=${TMDB_KEY}`),
            http.get(`https://api.themoviedb.org/3/movie/${req.params.id}/videos?api_key=${TMDB_KEY}`)
        ]);
        const trailer = vRes.data.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');
        res.json({ ...mRes.data, trailerKey: trailer?.key || null });
    } catch (err) {
        logError('MOVIE', err);
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------------------------------
// Cache management
// ------------------------------------------------------------------
app.get('/api/cache/status', (req, res) => res.json({ entries: cache.keys().length, uptime: process.uptime() }));
app.post('/api/cache/clear', (req, res) => { cache.flushAll(); res.json({ success: true }); });
app.post('/api/downloads/history', (req, res) => res.json({ success: true }));

// =============================================================================
// START
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║          PLAYKIT Download Server v3.0                ║
║  vidsrc embeds · FZMovies client-side · TMDB meta    ║
╠══════════════════════════════════════════════════════╣
║  http://${HOST}:${PORT}                                    ║
╚══════════════════════════════════════════════════════╝
    `);
});
