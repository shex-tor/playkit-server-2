// =============================================================================
// server.js — PLAYKIT AI-Powered Server v4.0
// Keys hardcoded · TMDB + YouTube proxied · Gemini AI endpoints
// =============================================================================

'use strict';

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
// API KEYS — hardcoded directly
// =============================================================================
const TMDB_KEY   = '480f73d92f9395eb2140f092c746b3bc';
const YT_KEY     = 'AIzaSyB3YRLnHIsJyzcktFLBROO-UkfW5wKwD-Q';
const GEMINI_KEY = 'AIzaSyDXNFjIu50Gr7VOn8_dpI6RYp0_V6KrhKI';

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
const TMDB_BASE  = 'https://api.themoviedb.org/3';
const YT_BASE    = 'https://www.googleapis.com/youtube/v3';

// =============================================================================
// DIRECTORIES
// =============================================================================
['cache', 'logs'].forEach(d => {
    const p = path.join(__dirname, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// =============================================================================
// LOGGING
// =============================================================================
const log = {
    info:  (ctx, msg) => console.log(`[INFO]  [${ctx}] ${msg}`),
    warn:  (ctx, msg) => console.warn(`[WARN]  [${ctx}] ${msg}`),
    error: (ctx, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ERROR] [${ctx}] ${msg}`);
        const line = JSON.stringify({ ts: new Date().toISOString(), ctx, msg }) + '\n';
        fs.appendFile(
            path.join(__dirname, 'logs', `error-${new Date().toISOString().split('T')[0]}.log`),
            line, () => {}
        );
    },
};

// =============================================================================
// CACHE
// =============================================================================
const tmdbCache   = new NodeCache({ stdTTL: 3600,  useClones: false }); // 1h
const ytCache     = new NodeCache({ stdTTL: 1800,  useClones: false }); // 30m
const aiCache     = new NodeCache({ stdTTL: 86400, useClones: false }); // 24h
const searchCache = new NodeCache({ stdTTL: 600,   useClones: false }); // 10m

// =============================================================================
// HTTP CLIENT
// =============================================================================
const http = axios.create({ timeout: 25000, maxRedirects: 5 });
axiosRetry(http, {
    retries: 2,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: e => axiosRetry.isNetworkOrIdempotentRequestError(e),
});

// =============================================================================
// MIDDLEWARE
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Range');
    res.setHeader('Access-Control-Expose-Headers',
        'Content-Length, Content-Disposition, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));
app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Rate limit exceeded. Try again later.' }
}));

// =============================================================================
// GEMINI AI HELPERS
// =============================================================================
async function askGemini(prompt, systemInstruction = '') {
    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        ...(systemInstruction && {
            systemInstruction: { parts: [{ text: systemInstruction }] }
        }),
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
    };
    const res  = await http.post(GEMINI_URL, body);
    return (res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

async function askGeminiJSON(prompt, systemInstruction = '') {
    const text  = await askGemini(prompt, systemInstruction);
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);
}

const AI_SYSTEM = `You are PLAYKIT AI — a friendly, knowledgeable movie and music expert for a streaming app.
Be concise, enthusiastic and helpful. For movie lists always include valid TMDB IDs.`;

// =============================================================================
// TMDB HELPER
// =============================================================================
async function tmdb(endpoint, params = {}) {
    const cacheKey = `tmdb_${endpoint}_${JSON.stringify(params)}`;
    const hit = tmdbCache.get(cacheKey);
    if (hit) return hit;
    const res = await http.get(`${TMDB_BASE}${endpoint}`, {
        params: { api_key: TMDB_KEY, ...params }
    });
    tmdbCache.set(cacheKey, res.data);
    return res.data;
}

// =============================================================================
// YOUTUBE HELPERS
// =============================================================================
async function ytSearch(q, maxResults = 12, extra = {}) {
    const cacheKey = `yts_${q}_${maxResults}_${JSON.stringify(extra)}`;
    const hit = ytCache.get(cacheKey);
    if (hit) return hit;
    const res = await http.get(`${YT_BASE}/search`, {
        params: { part: 'snippet', type: 'video', q, maxResults, key: YT_KEY, ...extra }
    });
    ytCache.set(cacheKey, res.data);
    return res.data;
}

async function ytVideos(ids, part = 'contentDetails,statistics') {
    const cacheKey = `ytv_${ids}_${part}`;
    const hit = ytCache.get(cacheKey);
    if (hit) return hit;
    const res = await http.get(`${YT_BASE}/videos`, {
        params: { part, id: ids, key: YT_KEY }
    });
    ytCache.set(cacheKey, res.data);
    return res.data;
}

// =============================================================================
// ── PROXY: TMDB ───────────────────────────────────────────────────────────────
// Frontend: fetch(`${SERVER}/api/tmdb/movie/popular`)
// =============================================================================
app.get('/api/tmdb/*', async (req, res) => {
    try {
        const endpoint = '/' + req.params[0];
        const data = await tmdb(endpoint, req.query);
        res.json(data);
    } catch (err) {
        log.error('TMDB_PROXY', err);
        res.status(502).json({ error: 'TMDB request failed', details: err.message });
    }
});

// =============================================================================
// ── PROXY: YOUTUBE ────────────────────────────────────────────────────────────
// =============================================================================
app.get('/api/yt/search', async (req, res) => {
    try {
        const { q, maxResults = 12, videoCategoryId, order = 'relevance', pageToken } = req.query;
        if (!q) return res.status(400).json({ error: 'Missing q' });
        const extra = {};
        if (videoCategoryId) extra.videoCategoryId = videoCategoryId;
        if (pageToken)       extra.pageToken       = pageToken;
        if (order)           extra.order           = order;
        const data = await ytSearch(q, maxResults, extra);
        res.json(data);
    } catch (err) {
        log.error('YT_SEARCH', err);
        res.status(502).json({ error: 'YouTube search failed', details: err.message });
    }
});

app.get('/api/yt/videos', async (req, res) => {
    try {
        const { id, part = 'contentDetails,statistics' } = req.query;
        if (!id) return res.status(400).json({ error: 'Missing id' });
        const data = await ytVideos(id, part);
        res.json(data);
    } catch (err) {
        log.error('YT_VIDEOS', err);
        res.status(502).json({ error: 'YouTube details failed', details: err.message });
    }
});

// =============================================================================
// ── AI: OPEN CHAT ─────────────────────────────────────────────────────────────
// POST /api/ai/chat  { message: "...", history: [{role, content}] }
// =============================================================================
app.post('/api/ai/chat', async (req, res) => {
    try {
        const { message, history = [] } = req.body;
        if (!message) return res.status(400).json({ error: 'Missing message' });

        const context = history.slice(-6).map(h => `${h.role}: ${h.content}`).join('\n');
        const prompt  = context
            ? `Conversation so far:\n${context}\n\nUser: ${message}`
            : `User: ${message}`;

        const reply = await askGemini(prompt, AI_SYSTEM);
        res.json({ reply });
    } catch (err) {
        log.error('AI_CHAT', err);
        res.status(500).json({ error: 'AI chat failed', details: err.message });
    }
});

// =============================================================================
// ── AI: MOOD RECOMMENDATIONS ──────────────────────────────────────────────────
// POST /api/ai/recommend  { mood, genres?, watchedIds? }
// =============================================================================
app.post('/api/ai/recommend', async (req, res) => {
    try {
        const { mood, genres = [], watchedIds = [] } = req.body;
        if (!mood) return res.status(400).json({ error: 'Missing mood' });

        const cacheKey = `rec_${mood}_${genres.sort().join('')}`;
        const cached   = aiCache.get(cacheKey);
        if (cached) return res.json(cached);

        const prompt = `A user wants movies matching this vibe: "${mood}"
Preferred genres: ${genres.length ? genres.join(', ') : 'any'}
Avoid TMDB IDs: ${watchedIds.slice(0, 10).join(', ') || 'none'}

Return ONLY a JSON array of 6 movies — no markdown, no extra text:
[{"tmdbId":12345,"title":"Movie Title","year":2023,"reason":"one sentence why it fits"}]`;

        const movies = await askGeminiJSON(prompt, AI_SYSTEM);

        const enriched = await Promise.allSettled(movies.map(async m => {
            try {
                const d = await tmdb(`/movie/${m.tmdbId}`);
                return {
                    ...m,
                    tmdbId:   d.id,
                    title:    d.title,
                    year:     d.release_date?.slice(0, 4),
                    rating:   d.vote_average,
                    poster:   d.poster_path   ? `https://image.tmdb.org/t/p/w342${d.poster_path}`   : null,
                    backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w780${d.backdrop_path}` : null,
                };
            } catch { return m; }
        }));

        const result = { movies: enriched.map(r => r.value).filter(Boolean) };
        aiCache.set(cacheKey, result, 3600);
        res.json(result);
    } catch (err) {
        log.error('AI_RECOMMEND', err);
        res.status(500).json({ error: 'Recommendations failed', details: err.message });
    }
});

// =============================================================================
// ── AI: MOVIE SUMMARY — "why you'd love this" ────────────────────────────────
// GET /api/ai/summary/:tmdbId
// =============================================================================
app.get('/api/ai/summary/:tmdbId', async (req, res) => {
    try {
        const cacheKey = `sum_${req.params.tmdbId}`;
        const cached   = aiCache.get(cacheKey);
        if (cached) return res.json(cached);

        const movie = await tmdb(`/movie/${req.params.tmdbId}`, {
            append_to_response: 'credits,keywords'
        });
        const cast = (movie.credits?.cast || []).slice(0, 5).map(c => c.name).join(', ');
        const kw   = (movie.keywords?.keywords || []).slice(0, 8).map(k => k.name).join(', ');

        const prompt = `Movie: "${movie.title}" (${movie.release_date?.slice(0, 4)})
Overview: ${movie.overview}
Cast: ${cast}
Keywords: ${kw}
Rating: ${movie.vote_average}/10

Write a punchy 2-sentence "why you'd love this" blurb for a streaming app.
Be specific and enthusiastic. No spoilers. Don't start with "If you".`;

        const summary = await askGemini(prompt, AI_SYSTEM);
        const result  = { summary, title: movie.title };
        aiCache.set(cacheKey, result);
        res.json(result);
    } catch (err) {
        log.error('AI_SUMMARY', err);
        res.status(500).json({ error: 'Summary failed', details: err.message });
    }
});

// =============================================================================
// ── AI: NATURAL LANGUAGE SEARCH ───────────────────────────────────────────────
// POST /api/ai/search  { query: "sci-fi movies with time travel" }
// =============================================================================
app.post('/api/ai/search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Missing query' });

        const cacheKey = `ais_${query.toLowerCase().trim()}`;
        const cached   = searchCache.get(cacheKey);
        if (cached) return res.json(cached);

        const prompt = `User search query: "${query}"
Convert this to the best TMDB search. Return ONLY JSON:
{"searchTerm":"...","type":"movie","year":null,"minRating":null,"explanation":"brief note"}`;

        const params     = await askGeminiJSON(prompt);
        const searchData = await tmdb(`/search/${params.type || 'multi'}`, {
            query: params.searchTerm || query,
            ...(params.year && { year: params.year }),
        });

        let results = (searchData.results || []).filter(r =>
            params.type === 'movie' || r.media_type === 'movie' || r.media_type === 'tv'
        );
        if (params.minRating) {
            results = results.filter(r => (r.vote_average || 0) >= params.minRating);
        }

        const result = { results: results.slice(0, 10), explanation: params.explanation };
        searchCache.set(cacheKey, result);
        res.json(result);
    } catch (err) {
        log.error('AI_SEARCH', err);
        res.status(500).json({ error: 'AI search failed', details: err.message });
    }
});

// =============================================================================
// ── AI: TRIVIA ────────────────────────────────────────────────────────────────
// GET /api/ai/trivia/:tmdbId
// =============================================================================
app.get('/api/ai/trivia/:tmdbId', async (req, res) => {
    try {
        const cacheKey = `tri_${req.params.tmdbId}`;
        const cached   = aiCache.get(cacheKey);
        if (cached) return res.json(cached);

        const movie  = await tmdb(`/movie/${req.params.tmdbId}`);
        const prompt = `Give 4 fascinating behind-the-scenes trivia facts about "${movie.title}" (${movie.release_date?.slice(0, 4)}).
Return ONLY a JSON array of strings — no markdown, no extra text:
["fact 1","fact 2","fact 3","fact 4"]`;

        const facts  = await askGeminiJSON(prompt, AI_SYSTEM);
        const result = { facts, title: movie.title };
        aiCache.set(cacheKey, result);
        res.json(result);
    } catch (err) {
        log.error('AI_TRIVIA', err);
        res.status(500).json({ error: 'Trivia failed', details: err.message });
    }
});

// =============================================================================
// ── AI: SMARTER SIMILAR MOVIES ────────────────────────────────────────────────
// GET /api/ai/similar/:tmdbId
// =============================================================================
app.get('/api/ai/similar/:tmdbId', async (req, res) => {
    try {
        const cacheKey = `sim_${req.params.tmdbId}`;
        const cached   = aiCache.get(cacheKey);
        if (cached) return res.json(cached);

        const movie = await tmdb(`/movie/${req.params.tmdbId}`, { append_to_response: 'keywords' });
        const kw    = (movie.keywords?.keywords || []).slice(0, 6).map(k => k.name).join(', ');

        const prompt = `Movie: "${movie.title}" | Genres: ${movie.genres?.map(g => g.name).join(', ')} | Themes: ${kw}
Suggest 5 similar movies the user would love. Return ONLY JSON:
[{"tmdbId":123,"title":"...","reason":"one sentence"}]`;

        const suggestions = await askGeminiJSON(prompt, AI_SYSTEM);
        const enriched    = await Promise.allSettled(suggestions.map(async s => {
            try {
                const d = await tmdb(`/movie/${s.tmdbId}`);
                return {
                    ...s, tmdbId: d.id, title: d.title, rating: d.vote_average,
                    poster: d.poster_path ? `https://image.tmdb.org/t/p/w342${d.poster_path}` : null,
                };
            } catch { return s; }
        }));

        const result = { movies: enriched.map(r => r.value).filter(Boolean) };
        aiCache.set(cacheKey, result, 3600 * 6);
        res.json(result);
    } catch (err) {
        log.error('AI_SIMILAR', err);
        res.status(500).json({ error: 'Similar failed', details: err.message });
    }
});

// =============================================================================
// ── AI: MUSIC MOOD PLAYLIST ───────────────────────────────────────────────────
// POST /api/ai/music-mood  { mood: "happy upbeat" }
// =============================================================================
app.post('/api/ai/music-mood', async (req, res) => {
    try {
        const { mood } = req.body;
        if (!mood) return res.status(400).json({ error: 'Missing mood' });

        const cacheKey = `mm_${mood.toLowerCase().trim()}`;
        const cached   = aiCache.get(cacheKey);
        if (cached) return res.json(cached);

        const prompt = `User mood: "${mood}"
Generate the best YouTube music search query for this mood.
Return ONLY JSON — no markdown: {"query":"...","label":"Playlist Name"}`;

        const data   = await askGeminiJSON(prompt, AI_SYSTEM);
        const ytData = await ytSearch(data.query, 10, { videoCategoryId: '10', order: 'relevance' });
        const result = { label: data.label, query: data.query, items: ytData.items || [] };
        aiCache.set(cacheKey, result, 3600);
        res.json(result);
    } catch (err) {
        log.error('AI_MUSIC_MOOD', err);
        res.status(500).json({ error: 'Music mood failed', details: err.message });
    }
});

// =============================================================================
// ── AI: WATCHLIST TASTE ANALYSIS ──────────────────────────────────────────────
// POST /api/ai/analyze-taste  { tmdbIds: [123, 456] }
// =============================================================================
app.post('/api/ai/analyze-taste', async (req, res) => {
    try {
        const { tmdbIds = [] } = req.body;
        if (!tmdbIds.length) return res.status(400).json({ error: 'No movies provided' });

        const movies = await Promise.allSettled(
            tmdbIds.slice(0, 10).map(id => tmdb(`/movie/${id}`))
        );
        const titles = movies
            .filter(r => r.status === 'fulfilled')
            .map(r => `${r.value.title} — ${r.value.genres?.map(g => g.name).join(', ')}`)
            .join('\n');

        const prompt = `Watchlist:\n${titles}\n
Analyse this user's taste. Return ONLY JSON:
{"taste":"2 sentences about their style","topGenres":["g1","g2","g3"],"mood":"overall vibe","nextWatch":"one specific rec with reason"}`;

        const analysis = await askGeminiJSON(prompt, AI_SYSTEM);
        res.json(analysis);
    } catch (err) {
        log.error('AI_TASTE', err);
        res.status(500).json({ error: 'Taste analysis failed', details: err.message });
    }
});

// =============================================================================
// HEALTH CHECK
// =============================================================================
app.get('/health',     (_, res) => res.json({ ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()) }));
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()) }));

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================
process.on('SIGINT',  () => { log.info('SHUTDOWN', 'Bye!'); process.exit(0); });
process.on('SIGTERM', () => { log.info('SHUTDOWN', 'Bye!'); process.exit(0); });

// =============================================================================
// START
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║         PLAYKIT AI Server v4.0  — http://${HOST}:${PORT}            ║
╠══════════════════════════════════════════════════════════════════╣
║  Keys   : TMDB ✅  YouTube ✅  Gemini ✅ (hardcoded)             ║
║                                                                  ║
║  PROXY  GET  /api/tmdb/*          → TMDB passthrough            ║
║         GET  /api/yt/search       → YouTube search              ║
║         GET  /api/yt/videos       → YouTube video details       ║
║                                                                  ║
║  AI     POST /api/ai/chat         → open conversation           ║
║         POST /api/ai/recommend    → mood-based recs             ║
║         GET  /api/ai/summary/:id  → "why you'd love this"       ║
║         POST /api/ai/search       → natural language search     ║
║         GET  /api/ai/trivia/:id   → fun movie facts             ║
║         GET  /api/ai/similar/:id  → smarter similar movies      ║
║         POST /api/ai/music-mood   → AI music playlist           ║
║         POST /api/ai/analyze-taste→ watchlist taste analysis    ║
╚══════════════════════════════════════════════════════════════════╝`);
});

module.exports = app;
