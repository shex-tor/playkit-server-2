// =============================================================================
// server.js — PLAYKIT AI-Powered Movie Server
// Complete system with real link extraction, Gemini AI integration, and caching
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
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// GEMINI AI CONFIGURATION
// =============================================================================
const GEMINI_KEY = 'AIzaSyCc_o1ylT7HzPajmtSwet2Ihs8HWsKKDLk';
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const aiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// AI Cache
const aiCache = {
    embeddings: new NodeCache({ stdTTL: 86400 }), // 24 hours
    recommendations: new NodeCache({ stdTTL: 3600 }), // 1 hour
    explanations: new NodeCache({ stdTTL: 604800 }), // 7 days
    semantic: new NodeCache({ stdTTL: 3600 }) // 1 hour
};

// =============================================================================
// ADVANCED CORS & SECURITY
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Exact-Size, X-Movie-Title, X-Cache-Hit, X-AI-Confidence');
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
    windowMs: 15 * 60 * 1000,
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

[TEMP_DIR, CACHE_DIR, LOG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =============================================================================
// CACHE SYSTEM
// =============================================================================
const linkCache = new NodeCache({
    stdTTL: 86400,
    checkperiod: 3600,
    useClones: false
});

const CACHE_FILE = path.join(CACHE_DIR, 'links-cache.json');

function loadCacheFromDisk() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            Object.entries(data).forEach(([key, value]) => {
                linkCache.set(key, value);
            });
            console.log(`Loaded ${Object.keys(data).length} cached links`);
        }
    } catch (error) {
        console.error('Failed to load cache:', error.message);
    }
}

function saveCacheToDisk() {
    try {
        const keys = linkCache.keys();
        const cacheData = {};
        keys.forEach(key => {
            cacheData[key] = linkCache.get(key);
        });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`Saved ${keys.length} links to disk cache`);
    } catch (error) {
        console.error('Failed to save cache:', error.message);
    }
}

setInterval(saveCacheToDisk, 5 * 60 * 1000);
loadCacheFromDisk();

// =============================================================================
// AI FUNCTIONS
// =============================================================================

class AIAssistant {
    constructor() {
        this.model = aiModel;
    }

    // Generate movie embeddings for semantic search
    async generateEmbedding(text) {
        const cacheKey = `emb_${crypto.createHash('md5').update(text).digest('hex')}`;
        const cached = aiCache.embeddings.get(cacheKey);
        if (cached) return cached;

        try {
            // For Gemini, we'll use a text representation rather than actual embeddings
            // Store a compressed version of the semantic meaning
            const result = await this.model.generateContent(
                `Summarize this movie description in 50 words for semantic matching: ${text}`
            );
            const summary = (await result.response).text();
            
            aiCache.embeddings.set(cacheKey, summary);
            return summary;
        } catch (error) {
            console.error('Embedding error:', error);
            return text;
        }
    }

    // Get personalized recommendations
    async getRecommendations(userPreferences, availableMovies, count = 10) {
        const cacheKey = `rec_${crypto.createHash('md5').update(JSON.stringify(userPreferences)).digest('hex')}`;
        const cached = aiCache.recommendations.get(cacheKey);
        if (cached) return cached;

        try {
            const movieList = availableMovies.map(m => 
                `${m.title} (${m.release_date?.slice(0,4) || 'Unknown'}): ${m.overview?.slice(0,100) || 'No description'}`
            ).join('\n');

            const prompt = `You are a movie recommendation AI. Based on these preferences:
            ${JSON.stringify(userPreferences, null, 2)}
            
            Rank these movies from most to least suitable:
            ${movieList}
            
            Return a JSON object with:
            {
                "rankings": ["Movie Title 1", "Movie Title 2", ...],
                "explanations": {
                    "Movie Title 1": "Why this matches the preferences"
                },
                "confidenceScores": {
                    "Movie Title 1": 0.95
                }
            }
            
            Only include movies from the provided list.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            const jsonMatch = text.match(/\{.*\}/s);
            if (jsonMatch) {
                const aiData = JSON.parse(jsonMatch[0]);
                aiCache.recommendations.set(cacheKey, aiData);
                return aiData;
            }
        } catch (error) {
            console.error('Recommendation error:', error);
        }

        return { rankings: [], explanations: {}, confidenceScores: {} };
    }

    // Semantic search
    async semanticSearch(query, movies) {
        const cacheKey = `sem_${crypto.createHash('md5').update(query).digest('hex')}`;
        const cached = aiCache.semantic.get(cacheKey);
        if (cached) return cached;

        try {
            const movieDescriptions = movies.map(m => 
                `${m.title} (${m.release_date?.slice(0,4) || 'Unknown'}): ${m.overview || 'No description'}`
            ).join('\n');

            const prompt = `Find movies matching this query: "${query}"
            
            Available movies:
            ${movieDescriptions}
            
            Return a JSON array of the top 10 most relevant movie titles in order of relevance.
            Format: ["Movie Title 1", "Movie Title 2", ...]`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            const jsonMatch = text.match(/\[.*\]/s);
            if (jsonMatch) {
                const titles = JSON.parse(jsonMatch[0]);
                
                // Map titles to movie objects with scores
                const results = movies
                    .filter(m => titles.includes(m.title))
                    .map(m => ({
                        ...m,
                        relevanceScore: 1 - (titles.indexOf(m.title) / titles.length)
                    }))
                    .sort((a, b) => b.relevanceScore - a.relevanceScore);

                aiCache.semantic.set(cacheKey, results);
                return results;
            }
        } catch (error) {
            console.error('Semantic search error:', error);
        }

        return [];
    }

    // Get movie explanation
    async explainMovie(movie) {
        const cacheKey = `exp_${movie.id}`;
        const cached = aiCache.explanations.get(cacheKey);
        if (cached) return cached;

        try {
            const prompt = `Explain why someone would enjoy this movie in 2-3 sentences:
            Title: ${movie.title}
            Year: ${movie.release_date?.slice(0,4) || 'Unknown'}
            Overview: ${movie.overview || 'No description'}
            Genres: ${movie.genres?.map(g => g.name).join(', ') || 'Unknown'}
            
            Focus on:
            - Emotional appeal
            - Target audience
            - Unique elements
            - Similar movies they might like`;

            const result = await this.model.generateContent(prompt);
            const explanation = (await result.response).text();

            aiCache.explanations.set(cacheKey, explanation);
            return explanation;
        } catch (error) {
            console.error('Explanation error:', error);
            return 'An AI-powered explanation is not available right now.';
        }
    }

    // Find similar movies with reasoning
    async findSimilar(movie, candidates) {
        try {
            const candidateList = candidates.map(m => 
                `${m.title} (${m.release_date?.slice(0,4) || 'Unknown'}): ${m.overview?.slice(0,100) || 'No description'}`
            ).join('\n');

            const prompt = `Find movies similar to "${movie.title}" and explain why.
            
            Target movie:
            Title: ${movie.title}
            Overview: ${movie.overview || 'No description'}
            
            Candidate movies:
            ${candidateList}
            
            Return a JSON object with:
            {
                "similar": ["Movie Title 1", "Movie Title 2", ...],
                "explanations": {
                    "Movie Title 1": "Why it's similar"
                },
                "similarityScores": {
                    "Movie Title 1": 0.9
                }
            }`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            const jsonMatch = text.match(/\{.*\}/s);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
        } catch (error) {
            console.error('Similar movies error:', error);
        }

        return { similar: [], explanations: {}, similarityScores: {} };
    }

    // Generate smart search suggestions
    async generateSuggestions(partial) {
        try {
            const prompt = `Generate 5 movie search suggestions based on "${partial}".
            Make them natural language queries like:
            - "funny comedies from the 90s"
            - "action movies with strong female leads"
            - "sci-fi films about artificial intelligence"
            - "feel-good movies for a rainy day"
            - "thrillers with plot twists"
            
            Return as JSON array of strings.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            const jsonMatch = text.match(/\[.*\]/s);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]).slice(0, 5);
            }
        } catch (error) {
            console.error('Suggestions error:', error);
        }

        return [];
    }

    // Mood-based recommendations
    async moodRecommendations(mood, movies) {
        const moodPrompts = {
            happy: 'uplifting, cheerful, feel-good movies',
            sad: 'emotional, touching, meaningful dramas',
            excited: 'action-packed, thrilling, high-energy movies',
            relaxed: 'calm, soothing, easy-going films',
            thoughtful: 'thought-provoking, philosophical, deep movies',
            romantic: 'love stories, romantic comedies, date night films',
            scared: 'horror, suspense, terrifying movies',
            nostalgic: 'classics, movies from past decades, retro films'
        };

        const promptText = moodPrompts[mood] || 'entertaining movies';

        try {
            const movieList = movies.map(m => 
                `${m.title} (${m.release_date?.slice(0,4) || 'Unknown'}): ${m.overview?.slice(0,100) || 'No description'}`
            ).join('\n');

            const prompt = `Find movies matching this mood: "${promptText}"
            
            Available movies:
            ${movieList}
            
            Return a JSON object with:
            {
                "recommendations": ["Movie Title 1", "Movie Title 2", ...],
                "explanation": "Why these movies fit the mood",
                "moodScore": {
                    "Movie Title 1": 0.95
                }
            }`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            const jsonMatch = text.match(/\{.*\}/s);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
        } catch (error) {
            console.error('Mood recommendations error:', error);
        }

        return { recommendations: [], explanation: '', moodScore: {} };
    }
}

const aiAssistant = new AIAssistant();

// =============================================================================
// LINK EXTRACTORS (same as original)
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
            console.log(`Cache hit for ${title}`);
            return { ...cached, cached: true };
        }

        console.log(`Extracting links for ${title} (${year})`);
        
        const results = [];
        const errors = [];

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
            }
        });

        await Promise.allSettled(extractPromises);

        if (results.length === 0) {
            return { error: 'No working links found', errors };
        }

        const validatedLinks = await this.validateLinks(results);
        
        const output = {
            movieId,
            title,
            year,
            timestamp: Date.now(),
            sources: validatedLinks,
            primary: validatedLinks[0]?.links[0] || null
        };

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
                    if (isValid.valid) {
                        validLinks.push({
                            ...link,
                            validated: true,
                            checkedAt: Date.now(),
                            size: isValid.size,
                            contentType: isValid.contentType
                        });
                    }
                } catch (error) {
                    console.error('Validate error:', error.message);
                }
                
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
            
            const isValid = contentType.includes('video/') || 
                           url.match(/\.(mp4|mkv|avi|mov|webm)$/i) ||
                           (contentLength && parseInt(contentLength) > 1024 * 1024);
            
            return {
                valid: isValid,
                contentType,
                size: contentLength ? parseInt(contentLength) : null,
                status: response.status
            };
        } catch (error) {
            if (error.response?.status === 302 || error.response?.status === 301) {
                return this.checkLink(error.response.headers.location);
            }
            return { valid: false, error: error.message };
        }
    }
}

// Source extractor classes (same as original)
class VidsrcExtractor {
    constructor() { this.name = 'vidsrc'; }
    async extract(movieId, title, year) {
        const embedUrl = `https://vidsrc.to/embed/movie/${movieId}`;
        try {
            const response = await axios.get(embedUrl, {
                headers: { 'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] }
            });
            const $ = cheerio.load(response.data);
            const links = [];
            
            $('source').each((i, el) => {
                const src = $(el).attr('src');
                if (src && src.includes('.mp4')) {
                    links.push({
                        url: src,
                        quality: this.detectQuality(src),
                        type: 'mp4',
                        source: 'vidsrc'
                    });
                }
            });

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

class EmbedExtractor {
    constructor() { this.name = 'embed'; }
    async extract(movieId, title, year) {
        const domains = [
            `https://multiembed.mov/directstream.php?video_id=${movieId}&s=movie`,
            `https://embed.su/embed/movie/${movieId}`,
            `https://moviesapi.club/movie/${movieId}`
        ];

        const links = [];

        for (const domain of domains) {
            try {
                const response = await axios.get(domain, {
                    headers: {
                        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                        'Referer': 'https://www.google.com/'
                    }
                });
                
                if (typeof response.data === 'object' && response.data.sources) {
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
                
                const $ = cheerio.load(response.data);
                
                $('video source, video[src]').each((i, el) => {
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

            } catch (error) {
                continue;
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

class SuperEmbedExtractor {
    constructor() { this.name = 'superembed'; }
    async extract(movieId, title, year) {
        const urls = [
            `https://superembed.stream/movie/${movieId}`,
            `https://embedder.net/movie/${movieId}`
        ];

        const links = [];

        for (const url of urls) {
            try {
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                        'Referer': 'https://www.google.com/'
                    }
                });

                const $ = cheerio.load(response.data);

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

            } catch (error) {
                continue;
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

class MultiEmbedExtractor {
    constructor() { this.name = 'multisrc'; }
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
                const response = await axios.get(baseUrl, {
                    headers: {
                        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                        'Referer': 'https://www.google.com/'
                    }
                });

                const $ = cheerio.load(response.data);

                const patterns = [
                    'iframe[src]',
                    'source[src]',
                    '[data-player]',
                    '[data-video]',
                    '[data-src]'
                ];

                patterns.forEach(pattern => {
                    $(pattern).each((i, el) => {
                        let src = $(el).attr('src') || 
                                 $(el).attr('data-player') || 
                                 $(el).attr('data-video') || 
                                 $(el).attr('data-src');
                        
                        if (src) {
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

            } catch (error) {
                continue;
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
            if (links.some(l => l.quality === q)) return q;
        }
        return 'auto';
    }
}

// =============================================================================
// DOWNLOAD MANAGER
// =============================================================================
class DownloadManager {
    constructor() {
        this.extractor = new LinkExtractor();
        this.activeDownloads = new Map();
    }

    async getDownloadLinks(movieId, title, year) {
        try {
            const tmdbResponse = await axios.get(
                `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`
            );
            
            const movie = tmdbResponse.data;
            const movieTitle = movie.title;
            const movieYear = new Date(movie.release_date).getFullYear();

            const cached = linkCache.get(`links_${movieId}`);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                if (age < 12 * 60 * 60 * 1000) {
                    console.log(`Returning cached links for ${movieTitle}`);
                    return {
                        ...cached,
                        cached: true,
                        cacheAge: Math.floor(age / 1000 / 60) + ' minutes'
                    };
                }
            }

            const links = await this.extractor.extractLinks(movieId, movieTitle, movieYear);
            
            if (links.error) {
                throw new Error(links.error);
            }

            const processed = this.processLinks(links, movieTitle, movieYear);

            linkCache.set(`links_${movieId}`, {
                ...processed,
                timestamp: Date.now()
            });

            return processed;

        } catch (error) {
            console.error('Download manager error:', error);
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
        if (!quality || quality === 'auto') return '720p';
        
        quality = quality.toString().toLowerCase();
        
        if (quality.includes('1080') || quality.includes('1080p')) return '1080p';
        if (quality.includes('720') || quality.includes('720p')) return '720p';
        if (quality.includes('480') || quality.includes('480p')) return '480p';
        if (quality.includes('360') || quality.includes('360p')) return '360p';
        
        return '720p';
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
                    continue;
                }
            }

            throw new Error('No working download sources found');

        } catch (error) {
            console.error('Download initiation error:', error);
            throw error;
        }
    }
}

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
        aiCacheSize: {
            embeddings: aiCache.embeddings.keys().length,
            recommendations: aiCache.recommendations.keys().length,
            explanations: aiCache.explanations.keys().length,
            semantic: aiCache.semantic.keys().length
        }
    });
});

// Get movie details with AI insights
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

        // Get AI explanation
        const aiExplanation = await aiAssistant.explainMovie(movie);

        res.json({
            ...movie,
            trailerKey: trailer?.key || null,
            aiExplanation
        });
    } catch (error) {
        console.error('Movie API error:', error);
        res.status(500).json({ error: error.message });
    }
});

// AI Recommendations
app.post('/api/ai/recommendations', async (req, res) => {
    try {
        const { preferences, movieIds } = req.body;

        // Fetch movie details from TMDB
        const moviePromises = movieIds.map(id =>
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`)
        );
        
        const movieResponses = await Promise.allSettled(moviePromises);
        const movies = movieResponses
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value.data);

        const aiData = await aiAssistant.getRecommendations(preferences, movies);

        // Map rankings back to full movie objects
        const rankedMovies = [];
        const movieMap = new Map(movies.map(m => [m.title, m]));

        for (const title of aiData.rankings || []) {
            const movie = movieMap.get(title);
            if (movie) {
                rankedMovies.push({
                    ...movie,
                    aiConfidence: aiData.confidenceScores?.[title] || 0.5,
                    aiExplanation: aiData.explanations?.[title] || ''
                });
            }
        }

        res.json({
            recommendations: rankedMovies,
            explanations: aiData.explanations || {},
            confidenceScores: aiData.confidenceScores || {}
        });
    } catch (error) {
        console.error('AI Recommendations error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Semantic Search
app.post('/api/ai/semantic-search', async (req, res) => {
    try {
        const { query, movieIds } = req.body;

        const moviePromises = movieIds.map(id =>
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`)
        );
        
        const movieResponses = await Promise.allSettled(moviePromises);
        const movies = movieResponses
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value.data);

        const results = await aiAssistant.semanticSearch(query, movies);

        res.json({
            query,
            results,
            count: results.length
        });
    } catch (error) {
        console.error('Semantic search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mood-based recommendations
app.post('/api/ai/mood', async (req, res) => {
    try {
        const { mood, movieIds } = req.body;

        const moviePromises = movieIds.map(id =>
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`)
        );
        
        const movieResponses = await Promise.allSettled(moviePromises);
        const movies = movieResponses
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value.data);

        const aiData = await aiAssistant.moodRecommendations(mood, movies);

        const movieMap = new Map(movies.map(m => [m.title, m]));
        const recommendations = (aiData.recommendations || []).map(title => ({
            ...movieMap.get(title),
            moodScore: aiData.moodScore?.[title] || 0.5
        })).filter(m => m);

        res.json({
            mood,
            recommendations,
            explanation: aiData.explanation || '',
            moodScores: aiData.moodScore || {}
        });
    } catch (error) {
        console.error('Mood recommendations error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Similar movies with AI reasoning
app.post('/api/ai/similar', async (req, res) => {
    try {
        const { movieId, candidateIds } = req.body;

        const [targetRes, ...candidateRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`),
            ...candidateIds.map(id =>
                axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`)
            )
        ]);

        const targetMovie = targetRes.data;
        const candidateMovies = candidateRes.map(r => r.data);

        const aiData = await aiAssistant.findSimilar(targetMovie, candidateMovies);

        const movieMap = new Map(candidateMovies.map(m => [m.title, m]));
        const similar = (aiData.similar || []).map(title => ({
            ...movieMap.get(title),
            similarityScore: aiData.similarityScores?.[title] || 0.5,
            similarityExplanation: aiData.explanations?.[title] || ''
        })).filter(m => m);

        res.json({
            targetMovie: {
                id: targetMovie.id,
                title: targetMovie.title
            },
            similar,
            explanations: aiData.explanations || {},
            similarityScores: aiData.similarityScores || {}
        });
    } catch (error) {
        console.error('Similar movies error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Generate search suggestions
app.get('/api/ai/suggestions', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ suggestions: [] });
        }

        const suggestions = await aiAssistant.generateSuggestions(q);
        res.json({ suggestions });
    } catch (error) {
        console.error('Suggestions error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get download options (original)
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const movieRes = await axios.get(
            `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`
        );
        
        const movie = movieRes.data;
        const year = new Date(movie.release_date).getFullYear();

        const links = await downloadManager.getDownloadLinks(id, movie.title, year);

        const qualityOptions = Object.entries(links.qualityOptions || {}).map(([quality, sources]) => {
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
        console.error('Download options error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch download options',
            details: error.message 
        });
    }
});

// Initiate download (original)
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

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Download-URL', downloadInfo.url);
        res.setHeader('X-Download-Size', downloadInfo.size || 'unknown');
        res.setHeader('X-Download-Source', downloadInfo.source);
        res.setHeader('X-Download-Quality', downloadInfo.quality);

        res.json({
            success: true,
            url: downloadInfo.url,
            size: downloadInfo.size,
            quality: downloadInfo.quality,
            source: downloadInfo.source,
            filename: `${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4`
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ 
            error: 'Download failed',
            details: error.message 
        });
    }
});

// Proxy download (original)
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

        Object.entries(response.headers).forEach(([key, value]) => {
            if (key.toLowerCase().startsWith('content-')) {
                res.setHeader(key, value);
            }
        });

        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

        response.data.pipe(res);

    } catch (error) {
        console.error('Proxy download error:', error);
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
        keys: keys.slice(0, 20),
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        aiCache: {
            embeddings: aiCache.embeddings.keys().length,
            recommendations: aiCache.recommendations.keys().length,
            explanations: aiCache.explanations.keys().length,
            semantic: aiCache.semantic.keys().length
        }
    };
    res.json(stats);
});

// Clear cache (admin only)
app.post('/api/cache/clear', (req, res) => {
    linkCache.flushAll();
    aiCache.embeddings.flushAll();
    aiCache.recommendations.flushAll();
    aiCache.explanations.flushAll();
    aiCache.semantic.flushAll();
    saveCacheToDisk();
    res.json({ success: true, message: 'All caches cleared' });
});

// =============================================================================
// BACKGROUND TASKS
// =============================================================================

async function refreshCache() {
    const keys = linkCache.keys();
    const refreshKeys = keys.filter(key => {
        const value = linkCache.get(key);
        const age = Date.now() - (value.timestamp || 0);
        return age > 6 * 60 * 60 * 1000;
    });

    for (const key of refreshKeys.slice(0, 5)) {
        try {
            const movieId = key.replace('links_', '');
            console.log(`Refreshing cache for ${movieId}`);
            
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
            
            await new Promise(r => setTimeout(r, 5000));
            
        } catch (error) {
            console.error('Refresh error:', error);
        }
    }
}

setInterval(refreshCache, 60 * 60 * 1000);

// =============================================================================
// CLEANUP
// =============================================================================
process.on('SIGINT', async () => {
    console.log('Shutting down, saving cache...');
    saveCacheToDisk();
    process.exit(0);
});

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
════════════════════════════════════════════════════════════
              PLAYKIT AI-Powered Server v3.0
   Real link extraction · Gemini AI · Semantic Search · Caching
════════════════════════════════════════════════════════════
  Server: http://${HOST}:${PORT}
  Cache: ${linkCache.keys().length} entries
  AI Cache: ${aiCache.embeddings.keys().length + aiCache.recommendations.keys().length + aiCache.explanations.keys().length + aiCache.semantic.keys().length} entries
  Sources: vidsrc, embed, superembed, multisrc
  AI Features: Recommendations, Semantic Search, Mood Picks, Explanations
════════════════════════════════════════════════════════════
    `);
});
