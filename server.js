// =============================================================================
// server.js — PLAYKIT Movie Download Server
// Complete system with real link extraction, validation, and caching
// =============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cheerio = require('cheerio');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// ADVANCED CORS & SECURITY
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Exact-Size, X-Movie-Title, X-Cache-Hit');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

const TEMP_DIR = path.join(os.tmpdir(), 'playkit-downloads');
const CACHE_DIR = path.join(__dirname, 'cache');
const LOG_DIR = path.join(__dirname, 'logs');

// Create directories
[TEMP_DIR, CACHE_DIR, LOG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =============================================================================
// CACHE SYSTEM
// =============================================================================
const linkCache = new NodeCache({
    stdTTL: 86400, // 24 hours default TTL
    checkperiod: 3600,
    useClones: false
});

// Persistent cache file
const CACHE_FILE = path.join(CACHE_DIR, 'links-cache.json');

// Load cache from disk on startup
function loadCacheFromDisk() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            Object.entries(data).forEach(([key, value]) => {
                linkCache.set(key, value);
            });
            console.log(`✅ Loaded ${Object.keys(data).length} cached links`);
        }
    } catch (error) {
        console.error('Failed to load cache:', error.message);
    }
}

// Save cache to disk periodically
function saveCacheToDisk() {
    try {
        const keys = linkCache.keys();
        const cacheData = {};
        keys.forEach(key => {
            cacheData[key] = linkCache.get(key);
        });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`💾 Saved ${keys.length} links to disk cache`);
    } catch (error) {
        console.error('Failed to save cache:', error.message);
    }
}

// Save cache every 5 minutes
setInterval(saveCacheToDisk, 5 * 60 * 1000);
loadCacheFromDisk();

// =============================================================================
// LOGGING SYSTEM
// =============================================================================
function logError(context, error, metadata = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        context,
        error: error.message,
        stack: error.stack,
        metadata
    };
    
    const logFile = path.join(LOG_DIR, `error-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    console.error(`❌ [${context}]`, error.message);
}

function logInfo(context, message, data = {}) {
    console.log(`📌 [${context}]`, message, Object.keys(data).length ? data : '');
}

// =============================================================================
// AXIOS CONFIGURATION WITH RETRY
// =============================================================================
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               error.response?.status >= 500;
    }
});

// Create axios instances with different configurations
const axiosWithProxy = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: status => status < 400,
    headers: {
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    }
});

// =============================================================================
// FZMOVIES EXTRACTOR (Primary Source)
// FZMovies flow: POST search → movie-about.php → moviesdownload.php → file links
// =============================================================================
class FZMoviesExtractor {
    constructor() {
        this.name = 'fzmovies';
        this.base = 'https://www.fzmovies.net';
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.fzmovies.net/'
        };
    }

    async extract(title, year) {
        try {
            // Step 1: POST search — FZMovies uses a form POST for search
            const params = new URLSearchParams();
            params.append('searchname', title);
            params.append('searchby', 'Name');
            params.append('submit', 'Search');

            const searchRes = await axiosWithProxy.post(
                `${this.base}/index.php`,
                params.toString(),
                {
                    headers: {
                        ...this.headers,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            const $ = cheerio.load(searchRes.data);
            const links = [];

            // Step 2: Find movie-about.php link from search results
            // Results appear as <a href="movie-about.php?fid=...">
            let moviePageUrl = null;
            $('a[href*="movie-about.php"]').each((i, el) => {
                if (moviePageUrl) return;
                const href = $(el).attr('href') || '';
                // Optionally match year if present in link text or nearby text
                const text = $(el).closest('li, div, td').text();
                const yearMatch = !year || text.includes(String(year)) || text.includes(String(year - 1));
                if (yearMatch || i === 0) {
                    moviePageUrl = href.startsWith('http') ? href : `${this.base}/${href.replace(/^\//, '')}`;
                }
            });

            // Fallback: just take first result
            if (!moviePageUrl) {
                const firstHref = $('a[href*="movie-about.php"]').first().attr('href');
                if (firstHref) moviePageUrl = firstHref.startsWith('http') ? firstHref : `${this.base}/${firstHref.replace(/^\//, '')}`;
            }

            if (!moviePageUrl) {
                logInfo('FZMOVIES', `No results found for "${title}"`);
                return { links: [] };
            }

            logInfo('FZMOVIES', `Found movie page: ${moviePageUrl}`);

            // Step 3: Open movie-about.php to get moviesdownload.php link
            const movieRes = await axiosWithProxy.get(moviePageUrl, { headers: this.headers });
            const $m = cheerio.load(movieRes.data);

            let downloadListUrl = null;
            $m('a[href*="moviesdownload.php"], a[href*="download.php"]').each((i, el) => {
                if (downloadListUrl) return;
                const href = $m(el).attr('href') || '';
                downloadListUrl = href.startsWith('http') ? href : `${this.base}/${href.replace(/^\//, '')}`;
            });

            if (!downloadListUrl) {
                logInfo('FZMOVIES', 'No download list link found on movie page');
                return { links: [] };
            }

            logInfo('FZMOVIES', `Download list URL: ${downloadListUrl}`);

            // Step 4: Open moviesdownload.php — shows quality rows
            const dlListRes = await axiosWithProxy.get(downloadListUrl, {
                headers: { ...this.headers, Referer: moviePageUrl }
            });
            const $dl = cheerio.load(dlListRes.data);

            // Step 5: Each quality row has a link to a file page (dcrypt.php or similar)
            // Collect those per-quality links first
            const qualityPageLinks = [];
            $dl('a[href*="dcrypt.php"], a[href*="download3.php"], a[href*="dlink"]').each((i, el) => {
                const href = $dl(el).attr('href') || '';
                const text = $dl(el).closest('tr, li, div').text().trim();
                const url = href.startsWith('http') ? href : `${this.base}/${href.replace(/^\//, '')}`;
                qualityPageLinks.push({ url, text });
            });

            // Also grab direct .mp4 links if present
            $dl('a[href$=".mp4"], a[href*=".mp4?"]').each((i, el) => {
                const href = $dl(el).attr('href') || '';
                const text = $dl(el).text().trim() || $dl(el).closest('tr').text().trim();
                const url = href.startsWith('http') ? href : `${this.base}/${href.replace(/^\//, '')}`;
                links.push({
                    url,
                    quality: this.detectQuality(text + ' ' + href),
                    type: 'mp4',
                    source: 'fzmovies',
                    label: text.slice(0, 80)
                });
            });

            // Step 6: For each quality page link, follow it to get the real download URL
            for (const { url: qUrl, text: qText } of qualityPageLinks.slice(0, 6)) {
                try {
                    const qRes = await axiosWithProxy.get(qUrl, {
                        headers: { ...this.headers, Referer: downloadListUrl }
                    });
                    const $q = cheerio.load(qRes.data);

                    // The final page usually has a direct download link or meta refresh
                    let finalUrl = null;

                    // Check meta refresh
                    const metaRefresh = $q('meta[http-equiv="refresh"]').attr('content') || '';
                    const metaMatch = metaRefresh.match(/url=([^"'\s]+)/i);
                    if (metaMatch) finalUrl = metaMatch[1];

                    // Check anchor tags for mp4 or download links
                    if (!finalUrl) {
                        $q('a[href*=".mp4"], a[href*="download"], a.downloadbtn, a[href*="mediafire"], a[href*="gofile"]').each((i, el) => {
                            if (!finalUrl) finalUrl = $q(el).attr('href');
                        });
                    }

                    // Check for script-embedded URLs
                    if (!finalUrl) {
                        $q('script').each((i, el) => {
                            const src = $q(el).html() || '';
                            const match = src.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/i);
                            if (match && !finalUrl) finalUrl = match[0];
                        });
                    }

                    if (finalUrl) {
                        links.push({
                            url: finalUrl.startsWith('http') ? finalUrl : `${this.base}/${finalUrl.replace(/^\//, '')}`,
                            quality: this.detectQuality(qText + ' ' + finalUrl),
                            type: 'mp4',
                            source: 'fzmovies',
                            label: qText.slice(0, 80)
                        });
                    }
                } catch (e) {
                    logError('FZMOVIES_STEP6', e, { url: qUrl });
                }
            }

            const deduped = this.deduplicateLinks(links);
            logInfo('FZMOVIES', `Found ${deduped.length} links for "${title}"`);
            return { links: deduped };

        } catch (err) {
            logError('FZMOVIES', err, { title, year });
            return { links: [] };
        }
    }

    detectQuality(text) {
        text = (text || '').toLowerCase();
        if (text.includes('1080')) return '1080p';
        if (text.includes('720')) return '720p';
        if (text.includes('480')) return '480p';
        if (text.includes('360')) return '360p';
        return '720p';
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(l => {
            const k = l.url.split('?')[0];
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }
}

// =============================================================================
// LINK EXTRACTORS
// =============================================================================

class LinkExtractor {
    constructor() {
        this.fzmovies = new FZMoviesExtractor();
    }

    async extractLinks(movieId, title, year) {
        const cacheKey = `movie_${movieId}_${year}`;
        const cached = linkCache.get(cacheKey);
        if (cached) {
            logInfo('CACHE', `Cache hit for ${title}`);
            return { ...cached, cached: true };
        }

        logInfo('EXTRACT', `Fetching links for ${title} (${year}) from FZMovies`);

        try {
            const result = await Promise.race([
                this.fzmovies.extract(title, year),
                new Promise((_, reject) => setTimeout(() => reject(new Error('FZMovies timeout')), 20000))
            ]);

            const links = result?.links || [];

            if (links.length === 0) {
                logError('EXTRACT', new Error('No links found on FZMovies'), { title, year });
                return { error: 'No download links found', sources: [] };
            }

            const output = {
                movieId,
                title,
                year,
                timestamp: Date.now(),
                sources: [{ source: 'fzmovies', links }],
                primary: links[0] || null
            };

            linkCache.set(cacheKey, output);
            return output;

        } catch (err) {
            logError('EXTRACT', err, { title, year });
            return { error: err.message, sources: [] };
        }
    }
}

// =============================================================================
// DOWNLOAD MANAGER
// =============================================================================
class DownloadManager {
    constructor() {
        this.extractor = new LinkExtractor();
    }

    qualityRank(q) {
        return { '1080p': 4, '720p': 3, '480p': 2, '360p': 1 }[q] || 0;
    }

    async getDownloadLinks(movieId, title, year) {
        // Check cache first
        const cacheKey = `links_${movieId}`;
        const cached = linkCache.get(cacheKey);
        if (cached) {
            const age = Date.now() - cached.timestamp;
            if (age < 12 * 60 * 60 * 1000) {
                logInfo('CACHE', `Returning cached links for ${title}`);
                return { ...cached, cached: true };
            }
        }

        // Get TMDB metadata if year not provided
        if (!year) {
            try {
                const tmdbRes = await axios.get(
                    `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`
                );
                title = tmdbRes.data.title || title;
                year = new Date(tmdbRes.data.release_date).getFullYear();
            } catch (e) { /* use provided title/year */ }
        }

        const links = await this.extractor.extractLinks(movieId, title, year);

        if (links.error || !links.sources?.length) {
            throw new Error(links.error || 'No download links found');
        }

        // Build qualityOptions map from sources
        const qualityOptions = {};
        for (const src of links.sources) {
            for (const link of src.links) {
                const q = link.quality || '720p';
                if (!qualityOptions[q]) qualityOptions[q] = [];
                qualityOptions[q].push({ url: link.url, source: src.source, type: link.type || 'mp4' });
            }
        }

        const result = { ...links, qualityOptions, timestamp: Date.now() };
        linkCache.set(cacheKey, result);
        return result;
    }

    async initiateDownload(movieId, quality, title) {
        const links = await this.getDownloadLinks(movieId, title, null);
        const sources = links.qualityOptions?.[quality];

        if (!sources?.length) {
            // Try closest available quality
            const available = Object.keys(links.qualityOptions || {});
            if (!available.length) throw new Error('No download links found');
            const closest = available.sort((a, b) => this.qualityRank(b) - this.qualityRank(a))[0];
            return this.initiateDownload(movieId, closest, title);
        }

        // Try each source URL until one responds
        for (const src of sources) {
            try {
                const resp = await axios.head(src.url, {
                    timeout: 10000,
                    maxRedirects: 5,
                    validateStatus: s => s < 400,
                    headers: { 'User-Agent': USER_AGENTS[0], 'Referer': 'https://www.fzmovies.net/' }
                });
                return {
                    url: src.url,
                    size: resp.headers['content-length'] ? parseInt(resp.headers['content-length']) : null,
                    quality,
                    source: src.source,
                    filename: `${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4`
                };
            } catch (_) { continue; }
        }

        // If HEAD checks fail, return the first URL anyway (let browser handle it)
        return {
            url: sources[0].url,
            quality,
            source: sources[0].source,
            filename: `${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4`
        };
    }
}

// =============================================================================
// INITIALIZE MANAGERS
// =============================================================================
const downloadManager = new DownloadManager();
const extractor = new LinkExtractor();

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Debug endpoint — test FZMovies scraping live (remove in production)
app.get('/api/debug/fzmovies', async (req, res) => {
    const title = req.query.title || 'Avengers';
    const year  = req.query.year  || '2012';
    const log   = [];
    try {
        const fz = new FZMoviesExtractor();

        // Step 1: POST search
        log.push('Step 1: POST search for: ' + title);
        const params = new URLSearchParams();
        params.append('searchname', title);
        params.append('searchby', 'Name');
        params.append('submit', 'Search');
        const searchRes = await axiosWithProxy.post(
            `${fz.base}/index.php`, params.toString(),
            { headers: { ...fz.headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        log.push('Search status: ' + searchRes.status);

        const $ = cheerio.load(searchRes.data);
        const movieLinks = [];
        $('a[href*="movie-about.php"]').each((i, el) => {
            movieLinks.push({ href: $(el).attr('href'), text: $(el).text().trim() });
        });
        log.push('Movie links found: ' + JSON.stringify(movieLinks.slice(0, 5)));

        const result = await fz.extract(title, year);
        log.push('Final links count: ' + result.links.length);
        log.push('Links: ' + JSON.stringify(result.links.slice(0, 5)));

        res.json({ success: true, log, links: result.links });
    } catch (e) {
        log.push('ERROR: ' + e.message);
        res.json({ success: false, log, error: e.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        cacheSize: linkCache.keys().length
    });
});

// Get movie details
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [movieRes, videosRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${id}/videos?api_key=${TMDB_KEY}`)
        ]);

        const movie = movieRes.data;
        const trailer = videosRes.data.results.find(
            v => v.type === 'Trailer' && v.site === 'YouTube'
        );

        res.json({
            ...movie,
            trailerKey: trailer?.key || null
        });
    } catch (error) {
        logError('API_MOVIE', error);
        res.status(500).json({ error: error.message });
    }
});

// Get download options
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Get movie details from TMDB
        const movieRes = await axios.get(
            `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`
        );
        const movie = movieRes.data;
        const year = new Date(movie.release_date).getFullYear();
        const runtime = movie.runtime || 120;

        // Get download links from FZMovies
        const links = await downloadManager.getDownloadLinks(id, movie.title, year);

        // Build quality options array for frontend
        const ORDER = ['1080p', '720p', '480p', '360p'];
        const qualityOptions = ORDER
            .filter(q => links.qualityOptions?.[q]?.length > 0)
            .map(quality => {
                const sources = links.qualityOptions[quality];
                const sizePerMin = quality === '1080p' ? 25 : quality === '720p' ? 12 : quality === '480p' ? 8 : 5;
                const sizeMB = Math.round(runtime * sizePerMin);
                return {
                    quality,
                    label: `${quality} - H.264`,
                    size: sizeMB,
                    sizeText: sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`,
                    sources: sources.map(s => s.url),
                    available: true
                };
            });

        res.json({
            movie: {
                id: movie.id,
                title: movie.title,
                year,
                runtime,
                poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                backdrop: `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`
            },
            options: qualityOptions,
            cached: links.cached || false,
            timestamp: links.timestamp
        });

    } catch (error) {
        logError('API_DOWNLOAD_OPTIONS', error);
        res.status(500).json({
            error: 'Failed to fetch download options',
            details: error.message
        });
    }
});

// Initiate download
app.get('/api/download', async (req, res) => {
    try {
        const { movieId, quality, title } = req.query;

        if (!movieId || !quality || !title) {
            return res.status(400).json({ 
                error: 'Missing required parameters: movieId, quality, title' 
            });
        }

        const downloadInfo = await downloadManager.initiateDownload(movieId, quality, title);

        if (!downloadInfo || !downloadInfo.url) {
            return res.status(404).json({ 
                error: 'No working download link found for this quality' 
            });
        }

        // Set response headers
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Download-URL', downloadInfo.url);
        res.setHeader('X-Download-Size', downloadInfo.size || 'unknown');
        res.setHeader('X-Download-Source', downloadInfo.source);
        res.setHeader('X-Download-Quality', downloadInfo.quality);

        // Return download info
        res.json({
            success: true,
            url: downloadInfo.url,
            size: downloadInfo.size,
            quality: downloadInfo.quality,
            source: downloadInfo.source,
            filename: `${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4`
        });

    } catch (error) {
        logError('API_DOWNLOAD', error);
        res.status(500).json({ 
            error: 'Download failed',
            details: error.message 
        });
    }
});

// Proxy download (for CORS issues)
app.get('/api/download/proxy', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'Missing URL parameter' });
        }

        const response = await axios({
            method: 'GET',
            url: decodeURIComponent(url),
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Referer': 'https://www.google.com/'
            }
        });

        // Forward headers
        Object.entries(response.headers).forEach(([key, value]) => {
            if (key.toLowerCase().startsWith('content-')) {
                res.setHeader(key, value);
            }
        });

        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

        // Pipe the response
        response.data.pipe(res);

        response.data.on('end', () => {
            logInfo('PROXY', 'Download completed');
        });

    } catch (error) {
        logError('PROXY_DOWNLOAD', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy download failed' });
        }
    }
});

// Get cache status
app.get('/api/cache/status', (req, res) => {
    const keys = linkCache.keys();
    const stats = {
        totalEntries: keys.length,
        keys: keys.slice(0, 20), // First 20 keys
        memory: process.memoryUsage(),
        uptime: process.uptime()
    };
    res.json(stats);
});

// Clear cache (admin only - add auth in production)
app.post('/api/cache/clear', (req, res) => {
    linkCache.flushAll();
    saveCacheToDisk();
    res.json({ success: true, message: 'Cache cleared' });
});

// =============================================================================
// BACKGROUND TASKS
// =============================================================================

// Refresh expired cache entries
async function refreshCache() {
    const keys = linkCache.keys();
    const refreshKeys = keys.filter(key => {
        const value = linkCache.get(key);
        const age = Date.now() - (value.timestamp || 0);
        return age > 6 * 60 * 60 * 1000; // Older than 6 hours
    });

    for (const key of refreshKeys.slice(0, 5)) { // Limit to 5 per run
        try {
            const movieId = key.replace('links_', '');
            logInfo('REFRESH', `Refreshing cache for ${movieId}`);
            
            // Get fresh data
            const movieRes = await axios.get(
                `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`
            );
            const movie = movieRes.data;
            const year = new Date(movie.release_date).getFullYear();
            
            const links = await extractor.extractLinks(movieId, movie.title, year);
            
            if (!links.error) {
                linkCache.set(key, {
                    ...links,
                    timestamp: Date.now()
                });
            }
            
            // Delay between requests
            await new Promise(r => setTimeout(r, 5000));
            
        } catch (error) {
            logError('REFRESH', error, { key });
        }
    }
}

// Run refresh every hour
setInterval(refreshCache, 60 * 60 * 1000);

// =============================================================================
// CLEANUP
// =============================================================================
process.on('SIGINT', async () => {
    logInfo('SHUTDOWN', 'Saving cache and cleaning up...');
    saveCacheToDisk();
    
    process.exit(0);
});

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║              PLAYKIT Download Server v2.0                  ║
║   Real link extraction · Validation · Caching · Fallback   ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://${HOST}:${PORT}                                ║
║  Cache: ${linkCache.keys().length} entries                         ║
║  Sources: vidsrc, embed, superembed, multisrc              ║
╚════════════════════════════════════════════════════════════╝
    `);
});
