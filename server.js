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
// LINK EXTRACTORS FOR DIFFERENT SOURCES
// =============================================================================

class LinkExtractor {
    constructor() {
        this.sources = [
            new VidsrcExtractor(),
            new EmbedExtractor(),
            new SuperEmbedExtractor(),
            new MultiEmbedExtractor()
        ];
    }

    async extractLinks(movieId, title, year) {
        const cacheKey = `movie_${movieId}_${year}`;
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
                    setTimeout(() => reject(new Error('Source timeout')), 15000);
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

        // Cache the results
        linkCache.set(cacheKey, output);
        
        return output;
    }

    async validateLinks(results) {
        const validated = [];
        
        for (const sourceResult of results) {
            const validLinks = [];
            
            for (const link of sourceResult.links) {
                try {
                    const isValid = await this.checkLink(link.url);
                    if (isValid) {
                        validLinks.push({
                            ...link,
                            validated: true,
                            checkedAt: Date.now()
                        });
                    }
                } catch (error) {
                    logError('VALIDATE', error, { url: link.url });
                }
                
                // Small delay to avoid rate limiting
                await new Promise(r => setTimeout(r, 500));
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
                maxRedirects: 5,
                headers: {
                    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
                }
            });
            
            const contentType = response.headers['content-type'] || '';
            const contentLength = response.headers['content-length'];
            
            // Check if it's a video file
            const isValid = contentType.includes('video/') || 
                           url.match(/\.(mp4|mkv|avi|mov|webm)$/i) ||
                           (contentLength && parseInt(contentLength) > 1024 * 1024); // > 1MB
            
            return {
                valid: isValid,
                contentType,
                size: contentLength ? parseInt(contentLength) : null,
                status: response.status
            };
        } catch (error) {
            if (error.response?.status === 302 || error.response?.status === 301) {
                // Follow redirect
                return this.checkLink(error.response.headers.location);
            }
            return { valid: false, error: error.message };
        }
    }
}

// =============================================================================
// SOURCE 1: VIDSRC EXTRACTOR
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
                quality: this.getBestQuality(links)
            };
        } catch (error) {
            throw new Error(`Vidsrc extraction failed: ${error.message}`);
        }
    }

    detectQuality(url) {
        if (url.includes('1080') || url.includes('1080p')) return '1080p';
        if (url.includes('720') || url.includes('720p')) return '720p';
        if (url.includes('480') || url.includes('480p')) return '480p';
        if (url.includes('360') || url.includes('360p')) return '360p';
        return 'unknown';
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0]; // Remove query params for dedup
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    getBestQuality(links) {
        const qualityOrder = ['1080p', '720p', '480p', '360p', 'unknown'];
        for (const q of qualityOrder) {
            const hasQuality = links.some(l => l.quality === q);
            if (hasQuality) return q;
        }
        return 'unknown';
    }
}

// =============================================================================
// SOURCE 2: EMBED EXTRACTOR
// =============================================================================
class EmbedExtractor {
    constructor() {
        this.name = 'embed';
    }

    async extract(movieId, title, year) {
        const domains = [
            `https://multiembed.mov/directstream.php?video_id=${movieId}&s=movie`,
            `https://embed.su/embed/movie/${movieId}`,
            `https://moviesapi.club/movie/${movieId}`
        ];

        const links = [];

        for (const domain of domains) {
            try {
                const response = await axiosWithProxy.get(domain, {
                    headers: {
                        'Referer': 'https://www.google.com/',
                        'Origin': 'https://www.google.com'
                    }
                });
                
                // Extract from JSON responses
                if (typeof response.data === 'object') {
                    if (response.data.sources) {
                        response.data.sources.forEach(source => {
                            if (source.file || source.url) {
                                links.push({
                                    url: source.file || source.url,
                                    quality: source.label || source.quality || 'auto',
                                    type: 'mp4',
                                    source: 'embed'
                                });
                            }
                        });
                    }
                }
                
                // Extract from HTML
                const $ = cheerio.load(response.data);
                
                // Look for video players
                $('video source, video[src], .player source, .video-js source').each((i, el) => {
                    const src = $(el).attr('src') || $(el).parent().attr('src');
                    if (src && src.match(/\.(mp4|m3u8)/)) {
                        links.push({
                            url: src,
                            quality: $(el).attr('data-quality') || 'auto',
                            type: src.includes('.m3u8') ? 'hls' : 'mp4',
                            source: 'embed'
                        });
                    }
                });

                // Look for script variables containing video URLs
                const scripts = $('script').map((i, el) => $(el).html()).get();
                scripts.forEach(script => {
                    if (script) {
                        const urlMatches = script.match(/https?:\/\/[^"'\s]+\.(mp4|m3u8)[^"'\s]*/g);
                        if (urlMatches) {
                            urlMatches.forEach(url => {
                                links.push({
                                    url: url,
                                    quality: url.includes('1080') ? '1080p' : 
                                            url.includes('720') ? '720p' : 'auto',
                                    type: url.includes('.m3u8') ? 'hls' : 'mp4',
                                    source: 'embed'
                                });
                            });
                        }
                    }
                });

            } catch (error) {
                continue; // Try next domain
            }
        }

        return {
            links: this.deduplicateLinks(links),
            quality: this.getBestQuality(links)
        };
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
        if (links.some(l => l.quality === '1080p')) return '1080p';
        if (links.some(l => l.quality === '720p')) return '720p';
        return 'auto';
    }
}

// =============================================================================
// SOURCE 3: SUPER EMBED EXTRACTOR (axios/cheerio — no Puppeteer)
// =============================================================================
class SuperEmbedExtractor {
    constructor() {
        this.name = 'superembed';
    }

    async extract(movieId, title, year) {
        const urls = [
            `https://superembed.stream/movie/${movieId}`,
            `https://embedder.net/movie/${movieId}`
        ];

        const links = [];

        for (const url of urls) {
            try {
                const response = await axiosWithProxy.get(url, {
                    headers: {
                        'Referer': 'https://www.google.com/',
                        'Accept-Language': 'en-US,en;q=0.9'
                    }
                });

                const $ = cheerio.load(response.data);

                // Extract from video/source elements
                $('video source, video[src]').each((i, el) => {
                    const src = $(el).attr('src') || $(el).parent().attr('src');
                    if (src && src.match(/\.(mp4|m3u8)/i)) {
                        links.push({
                            url: src,
                            quality: this.detectQuality(src),
                            type: src.includes('.m3u8') ? 'hls' : 'mp4',
                            source: 'superembed'
                        });
                    }
                });

                // Extract from data attributes
                $('[data-src],[data-url],[data-video],[data-file]').each((i, el) => {
                    const src = $(el).attr('data-src') || $(el).attr('data-url') ||
                                $(el).attr('data-video') || $(el).attr('data-file');
                    if (src && src.match(/https?:\/\//)) {
                        links.push({
                            url: src,
                            quality: this.detectQuality(src),
                            type: src.includes('.m3u8') ? 'hls' : 'mp4',
                            source: 'superembed'
                        });
                    }
                });

                // Scan inline scripts for video URLs
                $('script').each((i, el) => {
                    const content = $(el).html() || '';
                    const matches = content.match(/https?:\/\/[^"'\s\\]+\.(mp4|m3u8)[^"'\s\\]*/gi);
                    if (matches) {
                        matches.forEach(matchUrl => {
                            links.push({
                                url: matchUrl,
                                quality: this.detectQuality(matchUrl),
                                type: matchUrl.includes('.m3u8') ? 'hls' : 'mp4',
                                source: 'superembed'
                            });
                        });
                    }
                });

            } catch (error) {
                continue; // Try next URL
            }
        }

        return {
            links: this.deduplicateLinks(links),
            quality: this.getBestQuality(links)
        };
    }

    detectQuality(url) {
        if (url.includes('1080') || url.includes('1080p')) return '1080p';
        if (url.includes('720') || url.includes('720p')) return '720p';
        if (url.includes('480') || url.includes('480p')) return '480p';
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
        if (links.some(l => l.quality === '1080p')) return '1080p';
        if (links.some(l => l.quality === '720p')) return '720p';
        return 'auto';
    }
}

// =============================================================================
// SOURCE 4: MULTI EMBED EXTRACTOR
// =============================================================================
class MultiEmbedExtractor {
    constructor() {
        this.name = 'multisrc';
    }

    async extract(movieId, title, year) {
        const baseUrls = [
            `https://vidsrc.xyz/embed/movie/${movieId}`,
            `https://www.2embed.cc/embed/${movieId}`,
            `https://autoembed.co/movie/tmdb/${movieId}`,
            `https://dbgo.fun/movie/${movieId}`
        ];

        const links = [];

        for (const baseUrl of baseUrls) {
            try {
                const response = await axiosWithProxy.get(baseUrl, {
                    headers: {
                        'Referer': 'https://www.google.com/'
                    }
                });

                const $ = cheerio.load(response.data);

                // Extract from common patterns
                const patterns = [
                    'iframe[src]',
                    'source[src]',
                    '[data-player]',
                    '[data-video]',
                    '[data-src]',
                    '#player source',
                    '.player source'
                ];

                patterns.forEach(pattern => {
                    $(pattern).each((i, el) => {
                        let src = $(el).attr('src') || 
                                 $(el).attr('data-player') || 
                                 $(el).attr('data-video') || 
                                 $(el).attr('data-src');
                        
                        if (src) {
                            // Handle relative URLs
                            if (src.startsWith('//')) {
                                src = 'https:' + src;
                            } else if (src.startsWith('/')) {
                                src = new URL(src, baseUrl).href;
                            }
                            
                            if (src.match(/\.(mp4|m3u8)/) || src.includes('embed') || src.includes('video')) {
                                links.push({
                                    url: src,
                                    quality: this.detectQuality(src),
                                    type: src.includes('.m3u8') ? 'hls' : 
                                          src.includes('embed') ? 'embed' : 'mp4',
                                    source: 'multisrc'
                                });
                            }
                        }
                    });
                });

                // Check for JSON configs
                const scripts = $('script').map((i, el) => $(el).html()).get();
                scripts.forEach(script => {
                    if (script && script.includes('sources') && script.includes('file')) {
                        try {
                            const jsonMatch = script.match(/sources:\s*(\[.*?\])/s);
                            if (jsonMatch) {
                                const sources = JSON.parse(jsonMatch[1].replace(/'/g, '"'));
                                sources.forEach(source => {
                                    if (source.file) {
                                        links.push({
                                            url: source.file,
                                            quality: source.label || 'auto',
                                            type: 'mp4',
                                            source: 'multisrc'
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            // Ignore JSON parse errors
                        }
                    }
                });

            } catch (error) {
                continue; // Try next URL
            }
        }

        return {
            links: this.deduplicateLinks(links),
            quality: this.getBestQuality(links)
        };
    }

    detectQuality(url) {
        if (url.includes('1080') || url.includes('1080p')) return '1080p';
        if (url.includes('720') || url.includes('720p')) return '720p';
        if (url.includes('480') || url.includes('480p')) return '480p';
        if (url.includes('360') || url.includes('360p')) return '360p';
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
            const hasQuality = links.some(l => l.quality === q);
            if (hasQuality) return q;
        }
        return 'auto';
    }
}

// =============================================================================
// TITLE MATCHING & SCORING SYSTEM
// =============================================================================
class TitleMatcher {
    constructor() {
        this.minScore = 0.7; // Minimum similarity score to consider a match
    }

    calculateSimilarity(title1, title2) {
        // Normalize strings
        const normalize = (str) => {
            return str.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        };

        const a = normalize(title1);
        const b = normalize(title2);

        // Exact match
        if (a === b) return 1.0;

        // Check if one contains the other
        if (a.includes(b) || b.includes(a)) {
            const longer = a.length > b.length ? a : b;
            const shorter = a.length > b.length ? b : a;
            return shorter.length / longer.length;
        }

        // Levenshtein distance for fuzzy matching
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
        
        // Year bonus
        if (sourceYear && targetYear && Math.abs(sourceYear - targetYear) <= 1) {
            score += 0.15;
        }
        
        // Penalize if years don't match
        if (sourceYear && targetYear && Math.abs(sourceYear - targetYear) > 2) {
            score -= 0.3;
        }
        
        return Math.min(1, Math.max(0, score));
    }

    isMatch(sourceTitle, sourceYear, targetTitle, targetYear) {
        const score = this.scoreMatch(sourceTitle, targetTitle, sourceYear, targetYear);
        return score >= this.minScore;
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
            // First, get TMDB details to ensure we have accurate metadata
            const tmdbResponse = await axios.get(
                `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`
            );
            
            const movie = tmdbResponse.data;
            const movieTitle = movie.title;
            const movieYear = new Date(movie.release_date).getFullYear();

            // Check if we already have links in cache
            const cached = linkCache.get(`links_${movieId}`);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                if (age < 12 * 60 * 60 * 1000) { // 12 hours
                    logInfo('CACHE', `Returning cached links for ${movieTitle}`);
                    return {
                        ...cached,
                        cached: true,
                        cacheAge: Math.floor(age / 1000 / 60) + ' minutes'
                    };
                }
            }

            // Extract fresh links
            const links = await this.extractor.extractLinks(movieId, movieTitle, movieYear);
            
            if (links.error) {
                throw new Error(links.error);
            }

            // Process and rank links
            const processed = this.processLinks(links, movieTitle, movieYear);

            // Cache the processed links
            linkCache.set(`links_${movieId}`, {
                ...processed,
                timestamp: Date.now()
            });

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

        // Process each source's links
        for (const source of links.sources) {
            const sourceLinks = source.links.map(link => ({
                ...link,
                quality: this.normalizeQuality(link.quality),
                verified: link.validated || false
            }));

            // Sort by quality
            sourceLinks.sort((a, b) => this.qualityRank(b.quality) - this.qualityRank(a.quality));

            processed.sources.push({
                source: source.source,
                links: sourceLinks,
                bestQuality: sourceLinks[0]?.quality || 'unknown'
            });
        }

        // Sort sources by best quality
        processed.sources.sort((a, b) => 
            this.qualityRank(b.bestQuality) - this.qualityRank(a.bestQuality)
        );

        // Generate quality options for download
        processed.qualityOptions = this.generateQualityOptions(processed.sources);

        return processed;
    }

    normalizeQuality(quality) {
        if (!quality || quality === 'auto') return '720p';
        
        quality = quality.toString().toLowerCase();
        
        if (quality.includes('1080') || quality.includes('1080p')) return '1080p';
        if (quality.includes('720') || quality.includes('720p')) return '720p';
        if (quality.includes('480') || quality.includes('480p')) return '480p';
        if (quality.includes('360') || quality.includes('360p')) return '360p';
        
        return '720p'; // Default
    }

    qualityRank(quality) {
        const ranks = {
            '1080p': 5,
            '720p': 4,
            '480p': 3,
            '360p': 2,
            'unknown': 1
        };
        return ranks[quality] || 1;
    }

    generateQualityOptions(sources) {
        const options = {};
        
        // Collect all available qualities
        for (const source of sources) {
            for (const link of source.links) {
                if (!options[link.quality]) {
                    options[link.quality] = [];
                }
                options[link.quality].push({
                    source: source.source,
                    url: link.url,
                    type: link.type
                });
            }
        }

        // Sort qualities
        const sorted = {};
        const qualities = ['1080p', '720p', '480p', '360p'];
        
        for (const quality of qualities) {
            if (options[quality]) {
                sorted[quality] = options[quality];
            }
        }

        return sorted;
    }

    async initiateDownload(movieId, quality, title) {
        try {
            const links = await this.getDownloadLinks(movieId, title, null);
            
            if (!links.qualityOptions[quality]) {
                throw new Error(`Quality ${quality} not available`);
            }

            const sources = links.qualityOptions[quality];
            
            // Try each source until one works
            for (const source of sources) {
                try {
                    const response = await axios.head(source.url, {
                        timeout: 10000,
                        maxRedirects: 5,
                        validateStatus: status => status < 400
                    });

                    if (response.status === 200) {
                        const contentLength = response.headers['content-length'];
                        
                        return {
                            url: source.url,
                            size: contentLength ? parseInt(contentLength) : null,
                            type: source.type,
                            quality: quality,
                            source: source.source
                        };
                    }
                } catch (error) {
                    continue; // Try next source
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

        // Get download links
        const links = await downloadManager.getDownloadLinks(id, movie.title, year);

        // Format response for frontend
        const qualityOptions = Object.entries(links.qualityOptions || {}).map(([quality, sources]) => {
            // Calculate approximate file size (1 min = ~10MB at 720p)
            const runtime = movie.runtime || 120;
            const sizePerMin = quality === '1080p' ? 25 : 
                              quality === '720p' ? 12 : 
                              quality === '480p' ? 8 : 5;
            const sizeMB = Math.round(runtime * sizePerMin);

            return {
                quality,
                label: `${quality} - H.264`,
                size: sizeMB,
                sizeText: sizeMB >= 1024 ? `${(sizeMB/1024).toFixed(2)} GB` : `${sizeMB} MB`,
                sources: sources.map(s => s.url),
                available: true
            };
        });

        res.json({
            movie: {
                id: movie.id,
                title: movie.title,
                year,
                runtime: movie.runtime || 120,
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
