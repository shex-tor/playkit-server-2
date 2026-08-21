// =============================================================================
// server.js — STREAMNET Movie Download Server
// Complete system with real link extraction, validation, and caching
// Integrated with Netnaija and Fzmovies.net indexers
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
const { URL } = require('url');

// ytdl-core handles YouTube video extraction — `npm install ytdl-core`
let ytdl;
try {
    ytdl = require('ytdl-core');
} catch {
    console.warn('⚠️  ytdl-core not installed — trailer downloads will use redirect fallback. Run: npm install ytdl-core');
}

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
// CONFIGURATION — API keys live here only, never in the frontend
// =============================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const YT_KEY   = 'AIzaSyB3YRLnHIsJyzcktFLBROO-UkfW5wKwD-Q';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const YT_BASE   = 'https://www.googleapis.com/youtube/v3';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

// Save cache to disk periodically.
// Strip per-link `validated` / `checkedAt` stamps before writing — those are
// only valid for the current server session.  When the server restarts and
// reloads the disk cache, links will be re-validated before being served.
function saveCacheToDisk() {
    try {
        const keys = linkCache.keys();
        const cacheData = {};
        keys.forEach(key => {
            const entry = linkCache.get(key);
            if (!entry) return;
            const cleaned = {
                ...entry,
                sources: (entry.sources || []).map(src => ({
                    ...src,
                    links: (src.links || []).map(({ validated: _v, checkedAt: _c, ...rest }) => rest)
                }))
            };
            cacheData[key] = cleaned;
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
    try {
        fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    } catch (e) {
        // Ignore logging errors
    }
    console.error(`❌ [${context}]`, error.message);
}

function logInfo(context, message, data = {}) {
    console.log(`📌 [${context}]`, message, Object.keys(data).length ? JSON.stringify(data) : '');
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
// NETNAIJA EXTRACTOR
// =============================================================================
class NetnaijaExtractor {
    constructor() {
        this.name = 'netnaija';
        this.baseUrl = 'https://www.netnaija.com';
        this.searchUrl = 'https://www.netnaija.com/search';
    }

    async extract(movieId, title, year) {
        try {
            const searchQuery = `${title} ${year || ''}`.trim();
            const searchResponse = await axiosWithProxy.get(this.searchUrl, {
                params: { q: searchQuery },
                headers: {
                    'Referer': this.baseUrl,
                    'Origin': this.baseUrl
                }
            });

            const $ = cheerio.load(searchResponse.data);
            const links = [];
            
            // Find movie links in search results
            $('.movie-item a, .film-item a, .post-item a, .content-item a, .movie-link a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().toLowerCase();
                if (href && (text.includes(title.toLowerCase()) || text.includes(year))) {
                    const fullUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
                    if (!links.some(l => l.url === fullUrl)) {
                        links.push({
                            url: fullUrl,
                            type: 'page',
                            source: 'netnaija'
                        });
                    }
                }
            });

            // Also try direct search
            if (links.length === 0) {
                const directUrl = `${this.baseUrl}/movies/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
                try {
                    await axiosWithProxy.head(directUrl);
                    links.push({
                        url: directUrl,
                        type: 'page',
                        source: 'netnaija'
                    });
                } catch (e) {
                    // Not found, continue
                }
            }

            // Extract download links from each found page
            const downloadLinks = [];
            for (const link of links.slice(0, 3)) {
                try {
                    const pageLinks = await this.extractDownloadLinks(link.url);
                    downloadLinks.push(...pageLinks);
                } catch (error) {
                    logError('NETNAIJA_PAGE', error, { url: link.url });
                }
            }

            return {
                links: this.deduplicateLinks(downloadLinks),
                quality: this.getBestQuality(downloadLinks),
                source: 'netnaija'
            };

        } catch (error) {
            logError('NETNAIJA_SEARCH', error, { title, year });
            return { links: [], quality: 'unknown', source: 'netnaija' };
        }
    }

    async extractDownloadLinks(pageUrl) {
        try {
            const response = await axiosWithProxy.get(pageUrl, {
                headers: {
                    'Referer': this.baseUrl
                }
            });

            const $ = cheerio.load(response.data);
            const links = [];

            // Look for download links
            const downloadPatterns = [
                'a[href*="download"]',
                'a[href*="dl"]',
                'a[href*="file"]',
                'a[href*="get"]',
                'a[href*="media"]',
                '.download-btn a',
                '.download-link a',
                '.download a',
                '.dl-btn a',
                'a.download',
                'a.btn-download'
            ];

            downloadPatterns.forEach(pattern => {
                $(pattern).each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().toLowerCase();
                    
                    if (href && (href.includes('http') || href.startsWith('/'))) {
                        let fullUrl = href;
                        if (href.startsWith('/')) {
                            fullUrl = `${this.baseUrl}${href}`;
                        }
                        
                        // Filter for video files or download links
                        if (fullUrl.match(/\.(mp4|mkv|avi|mov|webm|m3u8)/i) || 
                            text.includes('download') || 
                            text.includes('mp4') ||
                            text.includes('video')) {
                            
                            const quality = this.detectQuality(fullUrl);
                            links.push({
                                url: fullUrl,
                                quality: quality,
                                type: fullUrl.match(/\.(m3u8)/i) ? 'hls' : 'mp4',
                                source: 'netnaija',
                                filename: path.basename(fullUrl).split('?')[0]
                            });
                        }
                    }
                });
            });

            // Look for direct video links in source
            $('source, video[src]').each((i, el) => {
                const src = $(el).attr('src') || $(el).parent().attr('src');
                if (src && src.includes('http')) {
                    const quality = this.detectQuality(src);
                    links.push({
                        url: src,
                        quality: quality,
                        type: 'mp4',
                        source: 'netnaija',
                        filename: path.basename(src).split('?')[0]
                    });
                }
            });

            // Extract from scripts
            const scripts = $('script').map((i, el) => $(el).html()).get();
            scripts.forEach(script => {
                if (script) {
                    const videoMatches = script.match(/https?:\/\/[^"'\s]+\.(mp4|mkv|avi|mov)[^"'\s]*/gi);
                    if (videoMatches) {
                        videoMatches.forEach(url => {
                            const quality = this.detectQuality(url);
                            links.push({
                                url: url,
                                quality: quality,
                                type: 'mp4',
                                source: 'netnaija',
                                filename: path.basename(url).split('?')[0]
                            });
                        });
                    }
                }
            });

            return this.deduplicateLinks(links);
        } catch (error) {
            throw new Error(`Failed to extract from ${pageUrl}: ${error.message}`);
        }
    }

    detectQuality(url) {
        const urlLower = url.toLowerCase();
        if (urlLower.includes('1080') || urlLower.includes('1080p')) return '1080p';
        if (urlLower.includes('720') || urlLower.includes('720p')) return '720p';
        if (urlLower.includes('480') || urlLower.includes('480p')) return '480p';
        if (urlLower.includes('360') || urlLower.includes('360p')) return '360p';
        return 'auto';
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    getBestQuality(links) {
        const qualityOrder = ['1080p', '720p', '480p', '360p', 'auto'];
        for (const q of qualityOrder) {
            if (links.some(l => l.quality === q)) return q;
        }
        return 'auto';
    }
}

// =============================================================================
// FZMOVIES EXTRACTOR
// =============================================================================
class FzmoviesExtractor {
    constructor() {
        this.name = 'fzmovies';
        this.baseUrl = 'https://www.fzmovies.net';
        this.searchUrl = 'https://www.fzmovies.net/search';
    }

    async extract(movieId, title, year) {
        try {
            const searchQuery = `${title} ${year || ''}`.trim();
            const searchResponse = await axiosWithProxy.get(this.searchUrl, {
                params: { q: searchQuery },
                headers: {
                    'Referer': this.baseUrl,
                    'Origin': this.baseUrl
                }
            });

            const $ = cheerio.load(searchResponse.data);
            const links = [];

            // Find movie links in search results
            $('.movie-item a, .film-item a, .video-item a, .post-item a, .entry-title a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().toLowerCase();
                if (href && (text.includes(title.toLowerCase()) || text.includes(year))) {
                    const fullUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
                    if (!links.some(l => l.url === fullUrl)) {
                        links.push({
                            url: fullUrl,
                            type: 'page',
                            source: 'fzmovies'
                        });
                    }
                }
            });

            // Also try direct category browsing
            if (links.length === 0) {
                const categoryUrls = [
                    `${this.baseUrl}/category/movies`,
                    `${this.baseUrl}/category/movie`,
                    `${this.baseUrl}/movies`
                ];

                for (const catUrl of categoryUrls) {
                    try {
                        const catResponse = await axiosWithProxy.get(catUrl);
                        const cat$ = cheerio.load(catResponse.data);
                        cat$('a').each((i, el) => {
                            const href = $(el).attr('href');
                            const text = $(el).text().toLowerCase();
                            if (href && (text.includes(title.toLowerCase()) || text.includes(year))) {
                                const fullUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
                                if (!links.some(l => l.url === fullUrl)) {
                                    links.push({
                                        url: fullUrl,
                                        type: 'page',
                                        source: 'fzmovies'
                                    });
                                }
                            }
                        });
                    } catch (e) {
                        continue;
                    }
                }
            }

            // Extract download links from each found page
            const downloadLinks = [];
            for (const link of links.slice(0, 3)) {
                try {
                    const pageLinks = await this.extractDownloadLinks(link.url);
                    downloadLinks.push(...pageLinks);
                } catch (error) {
                    logError('FZMOVIES_PAGE', error, { url: link.url });
                }
            }

            return {
                links: this.deduplicateLinks(downloadLinks),
                quality: this.getBestQuality(downloadLinks),
                source: 'fzmovies'
            };

        } catch (error) {
            logError('FZMOVIES_SEARCH', error, { title, year });
            return { links: [], quality: 'unknown', source: 'fzmovies' };
        }
    }

    async extractDownloadLinks(pageUrl) {
        try {
            const response = await axiosWithProxy.get(pageUrl, {
                headers: {
                    'Referer': this.baseUrl
                }
            });

            const $ = cheerio.load(response.data);
            const links = [];

            // Fzmovies specific download patterns
            const downloadPatterns = [
                'a[href*="download"]',
                'a[href*="dl"]',
                'a[href*="file"]',
                'a[href*="get"]',
                'a[href*="media"]',
                'a[href*="movie"]',
                '.download-btn a',
                '.download-link a',
                '.download a',
                '.dl-btn a',
                'a.download',
                'a.btn-download',
                'a[href*=".mp4"]',
                'a[href*=".mkv"]'
            ];

            downloadPatterns.forEach(pattern => {
                $(pattern).each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().toLowerCase();
                    
                    if (href && (href.includes('http') || href.startsWith('/'))) {
                        let fullUrl = href;
                        if (href.startsWith('/')) {
                            fullUrl = `${this.baseUrl}${href}`;
                        }
                        
                        if (fullUrl.match(/\.(mp4|mkv|avi|mov|webm|m3u8)/i) || 
                            text.includes('download') || 
                            text.includes('mp4') ||
                            text.includes('video')) {
                            
                            const quality = this.detectQuality(fullUrl);
                            links.push({
                                url: fullUrl,
                                quality: quality,
                                type: fullUrl.match(/\.(m3u8)/i) ? 'hls' : 'mp4',
                                source: 'fzmovies',
                                filename: path.basename(fullUrl).split('?')[0]
                            });
                        }
                    }
                });
            });

            // Look for direct video links
            $('video source, video[src]').each((i, el) => {
                const src = $(el).attr('src') || $(el).parent().attr('src');
                if (src && src.includes('http')) {
                    const quality = this.detectQuality(src);
                    links.push({
                        url: src,
                        quality: quality,
                        type: 'mp4',
                        source: 'fzmovies',
                        filename: path.basename(src).split('?')[0]
                    });
                }
            });

            // Extract from scripts
            const scripts = $('script').map((i, el) => $(el).html()).get();
            scripts.forEach(script => {
                if (script) {
                    const videoMatches = script.match(/https?:\/\/[^"'\s]+\.(mp4|mkv|avi|mov)[^"'\s]*/gi);
                    if (videoMatches) {
                        videoMatches.forEach(url => {
                            const quality = this.detectQuality(url);
                            links.push({
                                url: url,
                                quality: quality,
                                type: 'mp4',
                                source: 'fzmovies',
                                filename: path.basename(url).split('?')[0]
                            });
                        });
                    }
                }
            });

            return this.deduplicateLinks(links);
        } catch (error) {
            throw new Error(`Failed to extract from ${pageUrl}: ${error.message}`);
        }
    }

    detectQuality(url) {
        const urlLower = url.toLowerCase();
        if (urlLower.includes('1080') || urlLower.includes('1080p')) return '1080p';
        if (urlLower.includes('720') || urlLower.includes('720p')) return '720p';
        if (urlLower.includes('480') || urlLower.includes('480p')) return '480p';
        if (urlLower.includes('360') || urlLower.includes('360p')) return '360p';
        return 'auto';
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    getBestQuality(links) {
        const qualityOrder = ['1080p', '720p', '480p', '360p', 'auto'];
        for (const q of qualityOrder) {
            if (links.some(l => l.quality === q)) return q;
        }
        return 'auto';
    }
}

// =============================================================================
// LINK EXTRACTORS FOR DIFFERENT SOURCES (Legacy/Backup)
// =============================================================================

class VidsrcExtractor {
    constructor() {
        this.name = 'vidsrc';
    }

    async extract(movieId, title, year) {
        const embedUrl = `https://vidsrc.to/embed/movie/${movieId}`;
        
        try {
            const response = await axiosWithProxy.get(embedUrl);
            const $ = cheerio.load(response.data);
            
            const links = [];
            
            // Extract video sources from various locations
            $('source').each((i, el) => {
                const src = $(el).attr('src');
                const type = $(el).attr('type');
                if (src && src.includes('.mp4')) {
                    links.push({
                        url: src,
                        quality: this.detectQuality(src),
                        type: 'mp4',
                        source: 'vidsrc'
                    });
                }
            });

            // Look for iframe sources
            $('iframe').each((i, el) => {
                const src = $(el).attr('src');
                if (src && (src.includes('embed') || src.includes('play'))) {
                    links.push({
                        url: src,
                        type: 'embed',
                        source: 'vidsrc'
                    });
                }
            });

            // Extract from data attributes
            $('[data-src], [data-url], [data-video]').each((i, el) => {
                const dataSrc = $(el).attr('data-src') || $(el).attr('data-url') || $(el).attr('data-video');
                if (dataSrc && dataSrc.includes('http')) {
                    links.push({
                        url: dataSrc,
                        quality: this.detectQuality(dataSrc),
                        type: 'mp4',
                        source: 'vidsrc'
                    });
                }
            });

            return {
                links: this.deduplicateLinks(links),
                quality: this.getBestQuality(links),
                source: 'vidsrc'
            };
        } catch (error) {
            throw new Error(`Vidsrc extraction failed: ${error.message}`);
        }
    }

    detectQuality(url) {
        const urlLower = url.toLowerCase();
        if (urlLower.includes('1080') || urlLower.includes('1080p')) return '1080p';
        if (urlLower.includes('720') || urlLower.includes('720p')) return '720p';
        if (urlLower.includes('480') || urlLower.includes('480p')) return '480p';
        if (urlLower.includes('360') || urlLower.includes('360p')) return '360p';
        return 'unknown';
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    getBestQuality(links) {
        const qualityOrder = ['1080p', '720p', '480p', '360p', 'unknown'];
        for (const q of qualityOrder) {
            if (links.some(l => l.quality === q)) return q;
        }
        return 'unknown';
    }
}

// =============================================================================
// MAIN LINK EXTRACTOR
// =============================================================================

class LinkExtractor {
    constructor() {
        this.sources = [
            new NetnaijaExtractor(),
            new FzmoviesExtractor(),
            new VidsrcExtractor()
        ];
    }

    async extractLinks(movieId, title, year) {
        // Use the same key prefix as DownloadManager so both layers share one
        // cache slot — previously movie_${id}_${year} vs links_${id} meant two
        // separate entries and refreshCache never matched the live data.
        const cacheKey = `links_${movieId}`;
        const cached = linkCache.get(cacheKey);
        
        if (cached) {
            logInfo('CACHE', `Cache hit for ${title}`, { movieId });
            return { ...cached, cached: true };
        }

        logInfo('EXTRACT', `Extracting links for ${title} (${year})`);
        
        const results = [];
        const errors = [];

        // Try each source in parallel with timeout
        const extractPromises = this.sources.map(async (source) => {
            try {
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Source timeout')), 20000);
                });

                const sourcePromise = source.extract(movieId, title, year);
                const result = await Promise.race([sourcePromise, timeoutPromise]);
                
                if (result && result.links && result.links.length > 0) {
                    results.push({
                        source: source.name,
                        ...result
                    });
                }
            } catch (error) {
                errors.push({ source: source.name, error: error.message });
                logError('EXTRACTOR', error, { source: source.name, movieId });
            }
        });

        await Promise.allSettled(extractPromises);

        if (results.length === 0) {
            logError('EXTRACT', new Error('No links found'), { movieId, title, errors });
            return { error: 'No working links found', errors };
        }

        // Validate and clean links
        const validatedLinks = await this.validateLinks(results);
        
        const output = {
            movieId,
            title,
            year,
            timestamp: Date.now(),
            sources: validatedLinks,
            primary: validatedLinks[0]?.links[0] || null
        };

        // Cache the results under the unified key
        linkCache.set(cacheKey, output);
        
        return output;
    }

    async validateLinks(results) {
        const validated = [];
        const CONCURRENCY = 4; // check up to 4 links at once per source

        for (const sourceResult of results) {
            const allLinks = sourceResult.links;
            const validLinks = [];

            // Process in batches of CONCURRENCY instead of one-by-one with a
            // hardcoded 500ms delay — cuts validation time from O(n*0.5s) to
            // O(ceil(n/CONCURRENCY) * avg_check_time)
            for (let i = 0; i < allLinks.length; i += CONCURRENCY) {
                const batch = allLinks.slice(i, i + CONCURRENCY);
                const batchResults = await Promise.allSettled(
                    batch.map(link => this.checkLink(link.url))
                );
                batchResults.forEach((result, j) => {
                    if (result.status === 'fulfilled' && result.value.valid) {
                        validLinks.push({
                            ...batch[j],
                            validated: true,
                            checkedAt: Date.now(),
                            size: result.value.size,
                            contentType: result.value.contentType
                        });
                    }
                });
            }

            if (validLinks.length > 0) {
                validated.push({
                    source: sourceResult.source,
                    links: validLinks
                });
            }
        }

        return validated;
    }

    async checkLink(url) {
        try {
            const response = await axios.head(url, {
                timeout: 10000,
                maxRedirects: 5,          // axios handles redirects natively
                validateStatus: s => s < 500, // treat 4xx as invalid, not throw
                headers: {
                    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
                }
            });

            if (response.status >= 400) return { valid: false, status: response.status };

            const contentType = response.headers['content-type'] || '';
            const contentLength = response.headers['content-length'];

            const isValid = contentType.includes('video/') ||
                           url.match(/\.(mp4|mkv|avi|mov|webm)$/i) ||
                           (contentLength && parseInt(contentLength) > 1024 * 1024);

            return {
                valid: !!isValid,
                contentType,
                size: contentLength ? parseInt(contentLength) : null,
                status: response.status
            };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }
}

// =============================================================================
// TITLE MATCHING & SCORING SYSTEM
// =============================================================================
class TitleMatcher {
    constructor() {
        this.minScore = 0.5; // Reduced threshold for better matching
    }

    calculateSimilarity(title1, title2) {
        const normalize = (str) => str.toLowerCase()
            .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

        const a = normalize(title1);
        const b = normalize(title2);

        if (a === b) return 1.0;
        if (a.includes(b) || b.includes(a)) {
            const longer = a.length > b.length ? a : b;
            const shorter = a.length > b.length ? b : a;
            return shorter.length / longer.length;
        }

        const distance = this.levenshteinDistance(a, b);
        const maxLength = Math.max(a.length, b.length);
        return 1 - (distance / maxLength);
    }

    levenshteinDistance(a, b) {
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    scoreMatch(sourceTitle, targetTitle, sourceYear, targetYear) {
        let score = this.calculateSimilarity(sourceTitle, targetTitle);
        if (sourceYear && targetYear && Math.abs(sourceYear - targetYear) <= 1) score += 0.15;
        if (sourceYear && targetYear && Math.abs(sourceYear - targetYear) > 2) score -= 0.3;
        return Math.min(1, Math.max(0, score));
    }

    isMatch(sourceTitle, sourceYear, targetTitle, targetYear) {
        return this.scoreMatch(sourceTitle, targetTitle, sourceYear, targetYear) >= this.minScore;
    }
}

// =============================================================================
// DOWNLOAD MANAGER
// =============================================================================
class DownloadManager {
    constructor() {
        this.extractor = new LinkExtractor();
        this.matcher = new TitleMatcher();
        this.activeDownloads = new Map();
    }

    async getDownloadLinks(movieId, title, year) {
        try {
            // Try to get TMDB info first
            let movieTitle = title;
            let movieYear = year;
            
            try {
                const tmdbResponse = await axios.get(
                    `${TMDB_BASE}/movie/${movieId}?api_key=${TMDB_KEY}`
                );
                const movie = tmdbResponse.data;
                movieTitle = movie.title;
                movieYear = new Date(movie.release_date).getFullYear();
            } catch (e) {
                // Use provided title/year if TMDB fails
                logInfo('DOWNLOAD_MANAGER', 'Using provided title/year', { title, year });
            }

            const cacheKey = `links_${movieId}`;
            const cached = linkCache.get(cacheKey);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                if (age < 12 * 60 * 60 * 1000) {
                    logInfo('CACHE', `Returning cached links for ${movieTitle}`);
                    return { ...cached, cached: true, cacheAge: Math.floor(age / 1000 / 60) + ' minutes' };
                }
            }

            const links = await this.extractor.extractLinks(movieId, movieTitle, movieYear);
            if (links.error) throw new Error(links.error);

            const processed = this.processLinks(links, movieTitle, movieYear);
            linkCache.set(cacheKey, { ...processed, timestamp: Date.now() });
            return processed;

        } catch (error) {
            logError('DOWNLOAD_MANAGER', error, { movieId, title });
            throw error;
        }
    }

    processLinks(links, targetTitle, targetYear) {
        const processed = {
            movieId: links.movieId,
            title: targetTitle,
            year: targetYear,
            timestamp: Date.now(),
            sources: []
        };

        for (const source of links.sources) {
            const sourceLinks = source.links.map(link => ({
                ...link,
                quality: this.normalizeQuality(link.quality),
                verified: link.validated || false
            }));
            sourceLinks.sort((a, b) => this.qualityRank(b.quality) - this.qualityRank(a.quality));
            processed.sources.push({
                source: source.source,
                links: sourceLinks,
                bestQuality: sourceLinks[0]?.quality || 'unknown'
            });
        }

        processed.sources.sort((a, b) =>
            this.qualityRank(b.bestQuality) - this.qualityRank(a.bestQuality)
        );
        processed.qualityOptions = this.generateQualityOptions(processed.sources);
        return processed;
    }

    normalizeQuality(quality) {
        if (!quality || quality === 'auto' || quality === 'unknown') return '720p';
        quality = quality.toString().toLowerCase();
        if (quality.includes('1080')) return '1080p';
        if (quality.includes('720'))  return '720p';
        if (quality.includes('480'))  return '480p';
        if (quality.includes('360'))  return '360p';
        return '720p';
    }

    qualityRank(quality) {
        const ranks = { '1080p': 5, '720p': 4, '480p': 3, '360p': 2, 'unknown': 1 };
        return ranks[quality] || 1;
    }

    generateQualityOptions(sources) {
        const options = {};
        for (const source of sources) {
            for (const link of source.links) {
                if (!options[link.quality]) options[link.quality] = [];
                options[link.quality].push({ 
                    source: source.source, 
                    url: link.url, 
                    type: link.type,
                    filename: link.filename || null
                });
            }
        }
        const sorted = {};
        for (const q of ['1080p', '720p', '480p', '360p']) {
            if (options[q]) sorted[q] = options[q];
        }
        return sorted;
    }

    async initiateDownload(movieId, quality, title, year = null) {
        try {
            // Pass year so getDownloadLinks can form a cache key that matches
            // the one LinkExtractor already wrote — previously always null here.
            const links = await this.getDownloadLinks(movieId, title, year);
            
            // Try the requested quality first
            if (links.qualityOptions && links.qualityOptions[quality]) {
                for (const source of links.qualityOptions[quality]) {
                    try {
                        const response = await axios.head(source.url, {
                            timeout: 10000, 
                            maxRedirects: 5,
                            validateStatus: status => status < 400
                        });
                        if (response.status === 200 || response.status === 302 || response.status === 301) {
                            return {
                                url: source.url,
                                size: response.headers['content-length'] ? parseInt(response.headers['content-length']) : null,
                                type: source.type || 'mp4',
                                quality,
                                source: source.source,
                                filename: source.filename || `${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4`
                            };
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

            // Fallback: try any quality
            const qualities = ['1080p', '720p', '480p', '360p'];
            for (const q of qualities) {
                if (links.qualityOptions && links.qualityOptions[q]) {
                    for (const source of links.qualityOptions[q]) {
                        try {
                            const response = await axios.head(source.url, {
                                timeout: 10000, 
                                maxRedirects: 5,
                                validateStatus: status => status < 400
                            });
                            if (response.status === 200 || response.status === 302 || response.status === 301) {
                                return {
                                    url: source.url,
                                    size: response.headers['content-length'] ? parseInt(response.headers['content-length']) : null,
                                    type: source.type || 'mp4',
                                    quality: q,
                                    source: source.source,
                                    filename: source.filename || `${title.replace(/[^a-z0-9]/gi, '_')}_${q}.mp4`
                                };
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                }
            }

            throw new Error('No working download sources found');
        } catch (error) {
            logError('DOWNLOAD_INIT', error, { movieId, quality });
            throw error;
        }
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: Date.now(), 
        uptime: process.uptime(), 
        cacheSize: linkCache.keys().length,
        sources: ['netnaija', 'fzmovies', 'vidsrc']
    });
});

// TMDB Proxy — key is injected here; frontend must never pass api_key directly.
// Path is validated to avoid this endpoint being used as a general HTTP proxy.
const TMDB_PATH_RE = /^[\w\-/]+$/; // only word chars, hyphens, slashes

app.get('/api/tmdb/*', async (req, res) => {
    try {
        const tmdbPath = req.params[0];

        // Reject paths that look like external URLs or path traversal
        if (!tmdbPath || !TMDB_PATH_RE.test(tmdbPath)) {
            return res.status(400).json({ error: 'Invalid TMDB path' });
        }

        // Strip any api_key the client passed — we always inject ours
        const { api_key: _dropped, ...safeQuery } = req.query;
        const query = { ...safeQuery, api_key: TMDB_KEY };
        const qs    = new URLSearchParams(query).toString();
        const url   = `${TMDB_BASE}/${tmdbPath}?${qs}`;

        const response = await axios.get(url, { timeout: 10000 });
        res.json(response.data);
    } catch (error) {
        logError('TMDB_PROXY', error);
        res.status(error.response?.status || 500).json({ error: error.message });
    }
});

// YouTube Proxy
app.get('/api/youtube/*', async (req, res) => {
    try {
        const ytPath = req.params[0];
        const query  = { ...req.query, key: YT_KEY };
        const qs     = new URLSearchParams(query).toString();
        const url    = `${YT_BASE}/${ytPath}?${qs}`;

        const response = await axios.get(url, { timeout: 10000 });
        res.json(response.data);
    } catch (error) {
        logError('YT_PROXY', error);
        res.status(error.response?.status || 500).json({ error: error.message });
    }
});

// =============================================================================
// YOUTUBE TRAILER DOWNLOAD
// Streams the highest-quality mp4 directly to the browser when ytdl-core is
// available, or falls back to a cobalt.tools redirect (no server dependency).
// =============================================================================
app.get('/api/youtube/download', async (req, res) => {
    const { videoId } = req.query;
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid or missing videoId' });
    }

    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // --- Path A: ytdl-core is installed → stream the file directly ----------
    if (ytdl) {
        try {
            const info = await ytdl.getInfo(ytUrl);
            const title = info.videoDetails.title.replace(/[^\w\s-]/g, '').trim() || `trailer_${videoId}`;

            // Pick the best mp4 format that has both video + audio
            const format = ytdl.chooseFormat(info.formats, {
                quality: 'highestvideo',
                filter: f => f.container === 'mp4' && f.hasVideo && f.hasAudio
            }) || ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });

            if (!format) throw new Error('No suitable mp4 format found');

            const safeTitle = encodeURIComponent(`${title}.mp4`);
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}"`);
            if (format.contentLength) {
                res.setHeader('Content-Length', format.contentLength);
            }

            logInfo('YT_DOWNLOAD', `Streaming: ${title}`, { videoId, quality: format.qualityLabel });
            ytdl(ytUrl, { format }).pipe(res);
            return;
        } catch (err) {
            logError('YT_DOWNLOAD', err, { videoId });
            // Fall through to redirect
        }
    }

    // --- Path B: no ytdl-core or extraction failed → redirect to cobalt.tools
    // cobalt.tools is an open-source, privacy-respecting download tool that the
    // user controls in their own browser — no API key, no ads, always up to date.
    const cobaltUrl = `https://cobalt.tools/#${encodeURIComponent(ytUrl)}`;
    res.json({
        redirect: true,
        url: cobaltUrl,
        message: 'Open this link to download the trailer'
    });
});

// Movie download search — returns a search URL on a reliable public index.
// We don't scrape or host anything; we point the user to the right search.
app.get('/api/movie/download-search', async (req, res) => {
    const { title, year, quality } = req.query;
    if (!title) return res.status(400).json({ error: 'Missing title' });

    const q = encodeURIComponent(`${title} ${year || ''} ${quality || ''}`.trim());
    res.json({
        sources: [
            { label: 'YTS (HD movies)', url: `https://yts.mx/browse-movies/${encodeURIComponent(title)}/all/${quality || 'all'}/0/latest` },
            { label: '1337x Search',    url: `https://1337x.to/search/${q}/1/` },
            { label: 'RARBG Mirror',    url: `https://rargb.to/search/?search=${q}` }
        ]
    });
});

// Get movie details
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [movieRes, videosRes] = await Promise.all([
            axios.get(`${TMDB_BASE}/movie/${id}?api_key=${TMDB_KEY}`),
            axios.get(`${TMDB_BASE}/movie/${id}/videos?api_key=${TMDB_KEY}`)
        ]);

        const movie = movieRes.data;
        const trailer = videosRes.data.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');
        res.json({ ...movie, trailerKey: trailer?.key || null });
    } catch (error) {
        logError('API_MOVIE', error);
        res.status(500).json({ error: error.message });
    }
});

// Media Metadata
app.get('/api/media/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const type = req.query.type === 'tv' ? 'tv' : 'movie';

        const [detailsRes, videosRes] = await Promise.all([
            axios.get(`${TMDB_BASE}/${type}/${id}?api_key=${TMDB_KEY}`),
            axios.get(`${TMDB_BASE}/${type}/${id}/videos?api_key=${TMDB_KEY}`)
        ]);

        const d = detailsRes.data;
        const title = d.title || d.name || 'Unknown';
        const releaseDate = d.release_date || d.first_air_date || null;
        const year = releaseDate ? new Date(releaseDate).getFullYear() : null;

        const vids = videosRes.data.results || [];
        const trailer = vids.find(v => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
                        vids.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                        vids.find(v => v.site === 'YouTube' && v.type === 'Teaser') ||
                        null;

        res.json({
            id: d.id,
            type,
            title,
            year,
            overview: d.overview || '',
            poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
            backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null,
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
    } catch (error) {
        logError('API_MEDIA', error);
        res.status(error.response?.status || 500).json({ error: 'Failed to fetch media metadata' });
    }
});

// Get download options
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, year } = req.query;
        
        if (!title) {
            return res.status(400).json({ error: 'Missing title parameter' });
        }

        const links = await downloadManager.getDownloadLinks(id, title, year);

        const qualityOptions = Object.entries(links.qualityOptions || {}).map(([quality, sources]) => {
            const runtime = 120; // Default runtime
            const sizePerMin = quality === '1080p' ? 25 : quality === '720p' ? 12 : quality === '480p' ? 8 : 5;
            const sizeMB = Math.round(runtime * sizePerMin);
            return {
                quality,
                label: `${quality} - H.264`,
                size: sizeMB,
                sizeText: sizeMB >= 1024 ? `${(sizeMB/1024).toFixed(2)} GB` : `${sizeMB} MB`,
                sources: sources.map(s => ({
                    url: s.url,
                    source: s.source,
                    type: s.type || 'mp4',
                    filename: s.filename || null
                })),
                available: true
            };
        });

        res.json({
            movie: {
                id: links.movieId || id,
                title: links.title || title,
                year: links.year || year,
                runtime: 120
            },
            options: qualityOptions,
            cached: links.cached || false,
            timestamp: links.timestamp,
            sources: links.sources ? links.sources.map(s => s.source) : []
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
        const { movieId, quality, title, year } = req.query;
        if (!movieId || !quality || !title) {
            return res.status(400).json({ error: 'Missing required parameters: movieId, quality, title' });
        }

        const downloadInfo = await downloadManager.initiateDownload(movieId, quality, title, year || null);
        if (!downloadInfo || !downloadInfo.url) {
            return res.status(404).json({ error: 'No working download link found for this quality' });
        }

        // Set response headers
        res.setHeader('X-Download-URL', downloadInfo.url);
        res.setHeader('X-Download-Size', downloadInfo.size || 'unknown');
        res.setHeader('X-Download-Source', downloadInfo.source);
        res.setHeader('X-Download-Quality', downloadInfo.quality);
        res.setHeader('X-Download-Filename', downloadInfo.filename || '');

        res.json({
            success: true,
            url: downloadInfo.url,
            size: downloadInfo.size,
            quality: downloadInfo.quality,
            source: downloadInfo.source,
            filename: downloadInfo.filename || `${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4`
        });
    } catch (error) {
        logError('API_DOWNLOAD', error);
        res.status(500).json({ 
            error: 'Download initiation failed', 
            details: error.message 
        });
    }
});

// Allowed CDN hostnames for the download proxy — prevents SSRF.
// Extend this list as you add legitimate sources; never use a wildcard.
const PROXY_ALLOWED_HOSTS = new Set([
    'netnaija.com', 'www.netnaija.com',
    'fzmovies.net', 'www.fzmovies.net',
    'vidsrc.to', 'vidsrc.me',
    'image.tmdb.org',
    'images.weserv.nl',
]);

// Private/loopback CIDR blocks — requests to these are always rejected
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc00:|fe80:)/i;

function isProxyUrlAllowed(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return false; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (PRIVATE_IP_RE.test(host)) return false;
    // Allow exact match or subdomain of any allowed host
    return [...PROXY_ALLOWED_HOSTS].some(h => host === h || host.endsWith('.' + h));
}

// Proxy download (for CORS issues)
app.get('/api/download/proxy', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'Missing URL parameter' });

        const decodedUrl = decodeURIComponent(url);

        if (!isProxyUrlAllowed(decodedUrl)) {
            return res.status(403).json({ error: 'URL not permitted by proxy allowlist' });
        }

        const response = await axios({
            method: 'GET',
            url: decodedUrl,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Referer': 'https://www.google.com/'
            }
        });

        // Forward relevant headers
        Object.entries(response.headers).forEach(([key, value]) => {
            if (key.toLowerCase().startsWith('content-')) {
                res.setHeader(key, value);
            }
        });
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

        // Pipe the response
        response.data.pipe(res);
        response.data.on('end', () => logInfo('PROXY', 'Download completed'));
        response.data.on('error', (error) => {
            logError('PROXY_STREAM', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Stream error' });
            }
        });
    } catch (error) {
        logError('PROXY_DOWNLOAD', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy download failed', details: error.message });
        }
    }
});

// Cache status
app.get('/api/cache/status', (req, res) => {
    res.json({
        totalEntries: linkCache.keys().length,
        keys: linkCache.keys().slice(0, 20),
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

// Clear cache
app.post('/api/cache/clear', (req, res) => {
    linkCache.flushAll();
    saveCacheToDisk();
    res.json({ success: true, message: 'Cache cleared' });
});

// =============================================================================
// BACKGROUND TASKS
// =============================================================================
async function refreshCache() {
    const keys = linkCache.keys();
    const refreshKeys = keys.filter(key => {
        if (!key.startsWith('links_')) return false; // only process unified-key entries
        const value = linkCache.get(key);
        return Date.now() - (value?.timestamp || 0) > 6 * 60 * 60 * 1000;
    });

    for (const key of refreshKeys.slice(0, 5)) {
        try {
            const movieId = key.replace('links_', '');
            logInfo('REFRESH', `Refreshing cache for ${movieId}`);

            let title, year;
            try {
                // Use axiosWithProxy (retry-enabled) not bare axios — bare axios
                // skips the retry config and stalls the background job on TMDB hiccups
                const movieRes = await axiosWithProxy.get(`${TMDB_BASE}/movie/${movieId}?api_key=${TMDB_KEY}`);
                const movie = movieRes.data;
                title = movie.title;
                year = new Date(movie.release_date).getFullYear();
            } catch (e) {
                const cached = linkCache.get(key);
                if (cached) {
                    title = cached.title;
                    year = cached.year;
                } else {
                    continue;
                }
            }
            
            const links = await extractor.extractLinks(movieId, title, year);
            if (!links.error) {
                const processed = downloadManager.processLinks(links, title, year);
                linkCache.set(key, { ...processed, timestamp: Date.now() });
            }
            await new Promise(r => setTimeout(r, 5000));
        } catch (error) {
            logError('REFRESH', error, { key });
        }
    }
}

setInterval(refreshCache, 60 * 60 * 1000);

// =============================================================================
// CLEANUP
// =============================================================================
process.on('SIGINT', async () => {
    logInfo('SHUTDOWN', 'Saving cache and cleaning up...');
    saveCacheToDisk();
    process.exit(0);
});

process.on('SIGTERM', async () => {
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
║              STREAMNET Download Server v3.0                ║
║   Netnaija + Fzmovies.net Indexers · Validation · Caching  ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://${HOST}:${PORT}                            ║
║  Cache: ${linkCache.keys().length} entries                 ║
║  Sources: netnaija, fzmovies, vidsrc                      ║
╚════════════════════════════════════════════════════════════╝
    `);
});
