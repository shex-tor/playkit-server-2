// =============================================================================
// server.js — PLAYKIT Streaming & Download Server v3.0
// Production-ready streaming proxy + download engine + multi-source fallback
// =============================================================================

'use strict';

const express    = require('express');
const axios      = require('axios');
const axiosRetry = require('axios-retry').default;
const NodeCache  = require('node-cache');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const cheerio    = require('cheerio');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const { URL }    = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CONSTANTS & CONFIGURATION
// =============================================================================
const TMDB_KEY = process.env.TMDB_KEY || '480f73d92f9395eb2140f092c746b3bc';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

const QUALITY_RANK = { '4k': 5, '2160p': 5, '1080p': 4, '720p': 3, '480p': 2, '360p': 1, 'auto': 0 };

const DIRS = {
  tmp:   path.join(os.tmpdir(), 'playkit-tmp'),
  cache: path.join(__dirname, 'cache'),
  logs:  path.join(__dirname, 'logs'),
};
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

// =============================================================================
// LOGGING
// =============================================================================
const logger = {
  info:  (ctx, msg, meta = {}) => console.log(`[INFO]  [${ctx}] ${msg}`, meta),
  warn:  (ctx, msg, meta = {}) => console.warn(`[WARN]  [${ctx}] ${msg}`, meta),
  error: (ctx, err, meta = {}) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] [${ctx}] ${msg}`, meta);
    const entry = JSON.stringify({ ts: new Date().toISOString(), ctx, msg, meta }) + '\n';
    const file  = path.join(DIRS.logs, `error-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFile(file, entry, () => {});
  },
};

// =============================================================================
// CACHING — metadata only (never cache stream URLs)
// =============================================================================
// Metadata cache: TMDB movie data — long TTL is fine
const metaCache   = new NodeCache({ stdTTL: 24 * 3600, useClones: false });
// Resolve cache: freshly-resolved stream links — very short TTL
const streamCache = new NodeCache({ stdTTL: 60, useClones: false }); // 60 s

// =============================================================================
// HTTP CLIENT
// =============================================================================
const randUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const httpClient = axios.create({
  timeout: 20_000,
  maxRedirects: 10,
  validateStatus: s => s < 500,
  headers: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  },
});

axiosRetry(httpClient, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: e => axiosRetry.isNetworkOrIdempotentRequestError(e) || (e.response?.status >= 500),
});

// =============================================================================
// DYNAMIC HEADER SYSTEM — per-source required headers
// =============================================================================
const SOURCE_HEADERS = {
  vidapi: {
    Referer: 'https://vidapi.xyz/',
    Origin:  'https://vidapi.xyz',
    'User-Agent': randUA(),
  },
  superembed: {
    Referer: 'https://superembed.stream/',
    Origin:  'https://superembed.stream',
    'User-Agent': randUA(),
  },
  moviesapi: {
    Referer: 'https://moviesapi.club/',
    Origin:  'https://moviesapi.club',
    'User-Agent': randUA(),
  },
  embedsu: {
    Referer: 'https://embed.su/',
    Origin:  'https://embed.su',
    'User-Agent': randUA(),
  },
  vidsrc: {
    Referer: 'https://vidsrc.to/',
    Origin:  'https://vidsrc.to',
    'User-Agent': randUA(),
  },
};

function getHeaders(sourceName) {
  const base = SOURCE_HEADERS[sourceName] || { 'User-Agent': randUA() };
  return { ...base, 'User-Agent': randUA() }; // Fresh UA every call
}

// =============================================================================
// SMART LINK VALIDATOR — uses Range GET, not HEAD
// =============================================================================
async function validateStreamLink(url, sourceName) {
  try {
    const res = await httpClient.get(url, {
      headers: {
        ...getHeaders(sourceName),
        Range: 'bytes=0-65535',
      },
      responseType: 'stream',
      timeout: 12_000,
    });
    // Accept the stream immediately so we don't buffer it
    res.data.destroy();

    const ct     = (res.headers['content-type'] || '').toLowerCase();
    const cl     = parseInt(res.headers['content-length'] || '0', 10);
    const status = res.status;

    const isVideo = ct.includes('video/') || ct.includes('application/octet-stream') ||
                    ct.includes('application/vnd') || ct.includes('binary/');
    const isHLS   = ct.includes('application/vnd.apple.mpegurl') ||
                    ct.includes('application/x-mpegURL') ||
                    url.includes('.m3u8');
    const isMP4   = url.match(/\.mp4(\?|$)/i) || ct.includes('video/mp4');

    if ([200, 206].includes(status) && (isVideo || isHLS || isMP4 || cl > 65536)) {
      return { valid: true, contentType: ct, size: cl, isHLS, isMP4 };
    }
    return { valid: false, reason: `status=${status}, ct=${ct}` };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

// =============================================================================
// HLS HANDLER — proxies / parses .m3u8 playlists and rewrites segment URLs
// =============================================================================
class HLSHandler {
  /**
   * Fetch a master or media playlist, rewrite all segment & sub-playlist URLs
   * to route through our own proxy endpoint so the client never contacts the
   * origin directly (solves CORS, auth tokens, Referer requirements).
   */
  async rewritePlaylist(m3u8Url, sourceName, baseProxyUrl) {
    const res = await httpClient.get(m3u8Url, {
      headers: getHeaders(sourceName),
      timeout: 15_000,
    });
    const text = res.data;

    const originBase = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    const lines = text.split('\n').map(line => {
      line = line.trim();
      if (!line || line.startsWith('#EXT-X-KEY') ) return line; // leave keys alone
      if (line.startsWith('#'))                   return line; // other directives

      // Resolve relative URLs
      let absUrl;
      try {
        absUrl = new URL(line, originBase).href;
      } catch {
        return line;
      }

      // Rewrite through our segment proxy
      const encoded = encodeURIComponent(absUrl);
      return `${baseProxyUrl}/api/hls/segment?url=${encoded}&src=${sourceName}`;
    });

    return lines.join('\n');
  }

  detectQualityFromPlaylist(text) {
    const lines = text.split('\n');
    let best = 0;
    lines.forEach(l => {
      const m = l.match(/RESOLUTION=(\d+)x(\d+)/);
      if (m) best = Math.max(best, parseInt(m[2], 10));
    });
    if (best >= 2160) return '4k';
    if (best >= 1080) return '1080p';
    if (best >= 720)  return '720p';
    if (best >= 480)  return '480p';
    return 'auto';
  }
}

const hlsHandler = new HLSHandler();

// =============================================================================
// LINK RESOLVER — converts embed/iframe URLs into direct playable streams
// =============================================================================
class LinkResolver {
  async resolveEmbedUrl(embedUrl, sourceName) {
    try {
      const res = await httpClient.get(embedUrl, {
        headers: getHeaders(sourceName),
        timeout: 15_000,
      });
      const html   = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const $      = cheerio.load(html);
      const links  = [];

      // 1. <source src="...">  inside <video>
      $('video source[src], video[src]').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src) links.push(this._norm(src, embedUrl));
      });

      // 2. data-* attributes on player containers
      $('[data-src],[data-url],[data-video],[data-file],[data-hls]').each((_, el) => {
        ['data-src','data-url','data-video','data-file','data-hls'].forEach(attr => {
          const v = $(el).attr(attr);
          if (v && v.startsWith('http')) links.push(this._norm(v, embedUrl));
        });
      });

      // 3. Regex scan of inline scripts for mp4/m3u8 URLs
      $('script').each((_, el) => {
        const code = $(el).html() || '';
        const matches = code.match(/https?:\/\/[^\s"'\\]+?\.(mp4|m3u8)(\?[^\s"'\\]*)?/gi);
        if (matches) matches.forEach(m => links.push(this._norm(m, embedUrl)));
      });

      // 4. JSON blob: { sources: [{ file: ..., label: ... }] }
      const jsonMatches = html.match(/sources\s*:\s*(\[[\s\S]*?\])/g);
      if (jsonMatches) {
        jsonMatches.forEach(block => {
          try {
            const arr = JSON.parse(block.replace(/^sources\s*:\s*/, '').replace(/'/g, '"'));
            arr.forEach(s => {
              const u = s.file || s.url || s.src;
              if (u) links.push(this._norm(u, embedUrl));
            });
          } catch {}
        });
      }

      // 5. Look for nested iframes and recurse (one level only)
      const iframeSrc = $('iframe').first().attr('src');
      if (iframeSrc && links.length === 0) {
        const abs = this._norm(iframeSrc, embedUrl);
        return this.resolveEmbedUrl(abs, sourceName);
      }

      return this._dedupe(links);
    } catch (err) {
      logger.warn('RESOLVER', `Failed to resolve ${embedUrl}: ${err.message}`);
      return [];
    }
  }

  _norm(url, base) {
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/'))  return new URL(url, base).href;
    return url;
  }

  _dedupe(links) {
    const seen = new Set();
    return links.filter(u => {
      const key = u.split('?')[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

const resolver = new LinkResolver();

// =============================================================================
// SOURCE EXTRACTORS
// =============================================================================

// ── 1. VidAPI (PRIMARY) ──────────────────────────────────────────────────────
class VidAPISource {
  get name() { return 'vidapi'; }

  async extract(tmdbId, type = 'movie') {
    // VidAPI JSON endpoint
    const apiUrl = `https://vidapi.xyz/api/${type}/${tmdbId}`;
    try {
      const res = await httpClient.get(apiUrl, {
        headers: getHeaders(this.name),
        timeout: 15_000,
      });
      const data = res.data;
      const links = [];

      // Parse standard VidAPI response shape
      const sources = data?.sources || data?.streams || data?.data?.sources || [];
      sources.forEach(s => {
        const url = s.url || s.file || s.src;
        if (!url) return;
        links.push({
          url,
          quality: this._detectQuality(s.quality || s.label || url),
          type:    url.includes('.m3u8') ? 'hls' : 'mp4',
          source:  this.name,
        });
      });

      // Also try HTML embed page for fallback
      if (links.length === 0) {
        const embedUrl = `https://vidapi.xyz/embed/${type}/${tmdbId}`;
        const resolved = await resolver.resolveEmbedUrl(embedUrl, this.name);
        resolved.forEach(u => links.push({
          url: u,
          quality: this._detectQuality(u),
          type: u.includes('.m3u8') ? 'hls' : 'mp4',
          source: this.name,
        }));
      }

      return this._rank(links);
    } catch (err) {
      throw new Error(`VidAPI failed: ${err.message}`);
    }
  }

  _detectQuality(s) {
    s = String(s).toLowerCase();
    if (s.includes('2160') || s.includes('4k'))  return '4k';
    if (s.includes('1080'))                       return '1080p';
    if (s.includes('720'))                        return '720p';
    if (s.includes('480'))                        return '480p';
    if (s.includes('360'))                        return '360p';
    return 'auto';
  }

  _rank(links) {
    return links.sort((a, b) => (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0));
  }
}

// ── 2. SuperEmbed (FALLBACK 1) ───────────────────────────────────────────────
class SuperEmbedSource {
  get name() { return 'superembed'; }

  async extract(tmdbId, type = 'movie') {
    const embedUrl = `https://superembed.stream/${type}/${tmdbId}`;
    const raw = await resolver.resolveEmbedUrl(embedUrl, this.name);
    return raw.map(url => ({
      url,
      quality: this._dq(url),
      type:    url.includes('.m3u8') ? 'hls' : 'mp4',
      source:  this.name,
    })).sort((a, b) => (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0));
  }

  _dq(u) {
    if (u.includes('1080')) return '1080p';
    if (u.includes('720'))  return '720p';
    if (u.includes('480'))  return '480p';
    return 'auto';
  }
}

// ── 3. MoviesAPI (FALLBACK 2) ────────────────────────────────────────────────
class MoviesAPISource {
  get name() { return 'moviesapi'; }

  async extract(tmdbId, type = 'movie') {
    const url = `https://moviesapi.club/${type}/${tmdbId}`;
    try {
      const res = await httpClient.get(url, {
        headers: getHeaders(this.name),
        timeout: 15_000,
      });
      const html = res.data;
      const $    = cheerio.load(html);
      const links = [];

      // moviesapi returns jwplayer-style setup
      $('script').each((_, el) => {
        const code = $(el).html() || '';
        const m    = code.match(/sources:\s*(\[[\s\S]*?\])/);
        if (m) {
          try {
            const arr = JSON.parse(m[1].replace(/'/g, '"'));
            arr.forEach(s => {
              const u = s.file;
              if (u) links.push({ url: u, quality: s.label || 'auto', type: u.includes('.m3u8') ? 'hls' : 'mp4', source: this.name });
            });
          } catch {}
        }

        // fallback regex
        const mp4 = code.match(/https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi) || [];
        const hls = code.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/gi) || [];
        [...mp4, ...hls].forEach(u => links.push({ url: u, quality: 'auto', type: u.includes('.m3u8') ? 'hls' : 'mp4', source: this.name }));
      });

      return links;
    } catch (err) {
      throw new Error(`MoviesAPI failed: ${err.message}`);
    }
  }
}

// ── 4. EmbedSu (FALLBACK 3) ──────────────────────────────────────────────────
class EmbedSuSource {
  get name() { return 'embedsu'; }

  async extract(tmdbId, type = 'movie') {
    const embedUrl = `https://embed.su/embed/${type}/${tmdbId}`;
    const raw = await resolver.resolveEmbedUrl(embedUrl, this.name);
    return raw.map(url => ({
      url,
      quality: url.includes('1080') ? '1080p' : url.includes('720') ? '720p' : 'auto',
      type:    url.includes('.m3u8') ? 'hls' : 'mp4',
      source:  this.name,
    }));
  }
}

// ── 5. VidSrc (FALLBACK 4) ───────────────────────────────────────────────────
class VidSrcSource {
  get name() { return 'vidsrc'; }

  async extract(tmdbId, type = 'movie') {
    const embedUrl = `https://vidsrc.to/embed/${type}/${tmdbId}`;
    const raw = await resolver.resolveEmbedUrl(embedUrl, this.name);
    return raw.map(url => ({
      url,
      quality: 'auto',
      type:    url.includes('.m3u8') ? 'hls' : 'mp4',
      source:  this.name,
    }));
  }
}

// =============================================================================
// SOURCE MANAGER — orchestrates priority + fallback
// =============================================================================
class SourceManager {
  constructor() {
    this.primary   = new VidAPISource();
    this.fallbacks = [
      new SuperEmbedSource(),
      new MoviesAPISource(),
      new EmbedSuSource(),
      new VidSrcSource(),
    ];
  }

  /**
   * Returns the first working stream link, trying primary then fallbacks in order.
   * @returns {{ url, quality, type, source, isHLS, validated }} | null
   */
  async resolveStream(tmdbId, contentType = 'movie') {
    const cacheKey = `stream_${tmdbId}_${contentType}`;
    const cached   = streamCache.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    // Try primary first
    const sourceList = [this.primary, ...this.fallbacks];

    for (const source of sourceList) {
      logger.info('SOURCE_MGR', `Trying source: ${source.name}`, { tmdbId });
      try {
        const links = await source.extract(tmdbId, contentType);
        if (!links || links.length === 0) {
          logger.warn('SOURCE_MGR', `${source.name} returned no links`);
          continue;
        }

        // Validate top candidates (up to 3)
        for (const link of links.slice(0, 3)) {
          const check = await validateStreamLink(link.url, source.name);
          if (check.valid) {
            const result = { ...link, isHLS: check.isHLS, validated: true };
            streamCache.set(cacheKey, result);
            logger.info('SOURCE_MGR', `✅ Valid stream from ${source.name}`, { quality: link.quality, url: link.url.slice(0, 60) });
            return result;
          }
          logger.warn('SOURCE_MGR', `Link invalid: ${check.reason}`, { url: link.url.slice(0, 60) });
        }
      } catch (err) {
        logger.error('SOURCE_MGR', err, { source: source.name, tmdbId });
      }
    }

    return null; // All sources exhausted
  }
}

const sourceManager = new SourceManager();

// =============================================================================
// TMDB HELPERS
// =============================================================================
async function getTMDBMovie(tmdbId) {
  const cached = metaCache.get(`tmdb_${tmdbId}`);
  if (cached) return cached;

  const res  = await httpClient.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`);
  const data = res.data;
  metaCache.set(`tmdb_${tmdbId}`, data);
  return data;
}

async function searchTMDB(query) {
  const res = await httpClient.get(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}`
  );
  return res.data?.results || [];
}

// =============================================================================
// EXPRESS SETUP — middleware
// =============================================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, Content-Range, Accept-Ranges, X-Source, X-Quality');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Rate limit exceeded. Try again in a few minutes.' },
}));

// =============================================================================
// ROUTE: /api/movie/:tmdbId — metadata
// =============================================================================
app.get('/api/movie/:tmdbId', async (req, res) => {
  try {
    const movie = await getTMDBMovie(req.params.tmdbId);
    res.json({
      id:       movie.id,
      title:    movie.title,
      year:     new Date(movie.release_date).getFullYear(),
      overview: movie.overview,
      runtime:  movie.runtime,
      rating:   movie.vote_average,
      poster:   `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
      backdrop: `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`,
    });
  } catch (err) {
    logger.error('API_MOVIE', err);
    res.status(500).json({ error: 'Failed to fetch movie metadata' });
  }
});

// =============================================================================
// ROUTE: /api/search?q=...
// =============================================================================
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
    const results = await searchTMDB(q);
    res.json(results.slice(0, 10).map(m => ({
      id:     m.id,
      title:  m.title,
      year:   m.release_date?.split('-')[0],
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w185${m.poster_path}` : null,
    })));
  } catch (err) {
    logger.error('API_SEARCH', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// =============================================================================
// ROUTE: /api/resolve/:tmdbId — returns resolved stream info (JSON, no proxy)
// Useful for native players / debug
// =============================================================================
app.get('/api/resolve/:tmdbId', async (req, res) => {
  try {
    const { tmdbId } = req.params;
    const type = req.query.type || 'movie';

    const stream = await sourceManager.resolveStream(tmdbId, type);
    if (!stream) {
      return res.status(503).json({ error: 'No working stream found across all sources' });
    }

    res.json({
      tmdbId,
      url:      stream.url,
      quality:  stream.quality,
      type:     stream.type,
      source:   stream.source,
      isHLS:    stream.isHLS,
      streamProxy:   `/api/stream/${tmdbId}`,
      downloadProxy: `/api/download/${tmdbId}`,
    });
  } catch (err) {
    logger.error('API_RESOLVE', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// ROUTE: /api/stream/:tmdbId — STREAMING PROXY
// Client → PlayKit server → Video source (piped, with required headers)
// Supports:
//   • MP4 (range requests, seekable)
//   • HLS master playlist (rewrites segment URLs)
// =============================================================================
app.get('/api/stream/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const type = req.query.type || 'movie';

  try {
    const stream = await sourceManager.resolveStream(tmdbId, type);
    if (!stream) {
      return res.status(503).json({ error: 'No working stream found across all sources' });
    }

    res.setHeader('X-Source',  stream.source);
    res.setHeader('X-Quality', stream.quality);

    // ── HLS path ─────────────────────────────────────────────────────────────
    if (stream.isHLS || stream.type === 'hls' || stream.url.includes('.m3u8')) {
      logger.info('STREAM', `Serving HLS playlist for ${tmdbId}`, { source: stream.source });

      const baseProxyUrl = `${req.protocol}://${req.get('host')}`;
      const playlist = await hlsHandler.rewritePlaylist(stream.url, stream.source, baseProxyUrl);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(playlist);
    }

    // ── MP4 path with Range support ───────────────────────────────────────────
    logger.info('STREAM', `Piping MP4 for ${tmdbId}`, { source: stream.source });

    const rangeHeader = req.headers['range'];
    const reqHeaders  = {
      ...getHeaders(stream.source),
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    };

    const upstream = await httpClient.get(stream.url, {
      responseType: 'stream',
      headers: reqHeaders,
      timeout: 0, // no timeout for streaming
    });

    // Forward relevant headers to client
    const forwardHeaders = [
      'content-type', 'content-length', 'content-range',
      'accept-ranges', 'last-modified', 'etag',
    ];
    forwardHeaders.forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');

    res.status(upstream.status); // 200 or 206 (partial)
    upstream.data.pipe(res);

    upstream.data.on('error', err => {
      logger.error('STREAM_PIPE', err, { tmdbId });
      if (!res.headersSent) res.status(502).json({ error: 'Upstream stream error' });
    });

    req.on('close', () => upstream.data.destroy());

  } catch (err) {
    logger.error('API_STREAM', err, { tmdbId });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// ROUTE: /api/hls/segment — proxies individual HLS .ts segments
// =============================================================================
app.get('/api/hls/segment', async (req, res) => {
  const { url, src } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const upstream = await httpClient.get(decodeURIComponent(url), {
      headers: getHeaders(src || 'vidsrc'),
      responseType: 'stream',
      timeout: 30_000,
    });

    res.setHeader('Content-Type',  upstream.headers['content-type']  || 'video/MP2T');
    res.setHeader('Content-Length', upstream.headers['content-length'] || '');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(upstream.status);
    upstream.data.pipe(res);

    req.on('close', () => upstream.data.destroy());
  } catch (err) {
    logger.error('HLS_SEGMENT', err);
    if (!res.headersSent) res.status(502).json({ error: 'Segment fetch failed' });
  }
});

// =============================================================================
// ROUTE: /api/download/:tmdbId — DOWNLOAD HANDLER
// Supports direct MP4 download and HLS-to-progressive streaming (download mode)
// =============================================================================
app.get('/api/download/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const type = req.query.type || 'movie';

  try {
    const [movie, stream] = await Promise.all([
      getTMDBMovie(tmdbId),
      sourceManager.resolveStream(tmdbId, type),
    ]);

    if (!stream) {
      return res.status(503).json({ error: 'No downloadable stream found' });
    }

    const safeName = (movie?.title || `movie_${tmdbId}`)
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const ext = stream.isHLS ? 'ts' : 'mp4';
    const filename = `${safeName}_${stream.quality}.${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Source',  stream.source);
    res.setHeader('X-Quality', stream.quality);
    res.setHeader('Cache-Control', 'no-store');

    // ── HLS download: stream segments sequentially into response ─────────────
    if (stream.isHLS || stream.type === 'hls') {
      logger.info('DOWNLOAD', `HLS download for ${tmdbId}`, { source: stream.source });
      res.setHeader('Content-Type', 'video/MP2T');

      const playlistRes = await httpClient.get(stream.url, { headers: getHeaders(stream.source) });
      const lines       = playlistRes.data.split('\n').filter(l => l && !l.startsWith('#'));

      const originBase  = stream.url.substring(0, stream.url.lastIndexOf('/') + 1);

      for (const line of lines) {
        if (res.destroyed) break;
        try {
          const segUrl = line.startsWith('http') ? line : new URL(line, originBase).href;
          const segRes = await httpClient.get(segUrl, {
            headers: getHeaders(stream.source),
            responseType: 'arraybuffer',
            timeout: 30_000,
          });
          res.write(Buffer.from(segRes.data));
        } catch (segErr) {
          logger.warn('DOWNLOAD_HLS_SEG', `Segment failed: ${segErr.message}`);
        }
      }
      return res.end();
    }

    // ── MP4 direct pipe ───────────────────────────────────────────────────────
    logger.info('DOWNLOAD', `MP4 download for ${tmdbId}`, { source: stream.source });
    res.setHeader('Content-Type', 'video/mp4');

    const upstream = await httpClient.get(stream.url, {
      headers: getHeaders(stream.source),
      responseType: 'stream',
      timeout: 0,
    });

    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    upstream.data.pipe(res);

    upstream.data.on('error', err => {
      logger.error('DOWNLOAD_PIPE', err, { tmdbId });
      if (!res.headersSent) res.status(502).json({ error: 'Upstream error during download' });
    });

    req.on('close', () => upstream.data.destroy());

  } catch (err) {
    logger.error('API_DOWNLOAD', err, { tmdbId });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// ROUTE: /api/proxy?url=...&src=... — generic media proxy
// Used by the frontend player to bypass CORS for any validated URL
// =============================================================================
app.get('/api/proxy', async (req, res) => {
  const { url, src } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  let decoded;
  try {
    decoded = decodeURIComponent(url);
    new URL(decoded); // validate
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const rangeHeader = req.headers['range'];
    const upstream = await httpClient.get(decoded, {
      headers: {
        ...getHeaders(src || 'vidsrc'),
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      responseType: 'stream',
      timeout: 0,
    });

    ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.status(upstream.status);
    upstream.data.pipe(res);
    req.on('close', () => upstream.data.destroy());
  } catch (err) {
    logger.error('API_PROXY', err);
    if (!res.headersSent) res.status(502).json({ error: 'Proxy failed' });
  }
});

// =============================================================================
// ROUTE: /api/cache/status & /api/cache/clear
// =============================================================================
app.get('/api/cache/status', (req, res) => {
  res.json({
    metaEntries:   metaCache.keys().length,
    streamEntries: streamCache.keys().length,
    uptime:        Math.floor(process.uptime()),
    memory:        process.memoryUsage(),
  });
});

app.post('/api/cache/clear', (req, res) => {
  metaCache.flushAll();
  streamCache.flushAll();
  res.json({ ok: true, message: 'All caches cleared' });
});

// =============================================================================
// HEALTH CHECK
// =============================================================================
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================
process.on('SIGINT',  () => { logger.info('SHUTDOWN', 'Received SIGINT — exiting'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SHUTDOWN', 'Received SIGTERM — exiting'); process.exit(0); });

// =============================================================================
// START
// =============================================================================
app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║          PLAYKIT Streaming Server v3.0  — PRODUCTION             ║
╠══════════════════════════════════════════════════════════════════╣
║  http://${HOST}:${PORT}                                              ║
║                                                                  ║
║  Sources (priority order):                                       ║
║    1. VidAPI (primary)                                           ║
║    2. SuperEmbed  3. MoviesAPI  4. EmbedSu  5. VidSrc            ║
║                                                                  ║
║  Endpoints:                                                      ║
║    GET /api/movie/:tmdbId        — metadata                      ║
║    GET /api/search?q=...         — TMDB search                   ║
║    GET /api/resolve/:tmdbId      — get stream info (JSON)        ║
║    GET /api/stream/:tmdbId       — proxy stream (HLS or MP4)     ║
║    GET /api/hls/segment?url=...  — HLS segment proxy             ║
║    GET /api/download/:tmdbId     — download trigger              ║
║    GET /api/proxy?url=...        — generic media proxy           ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app; // for testing
