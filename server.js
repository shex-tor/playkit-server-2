// =============================================================================
// server.js — PLAYKIT Streaming & Download Server v3.1
// Primary: YouTube via yt-dlp  |  Fallback: SuperEmbed, MoviesAPI, VidSrc
// =============================================================================

'use strict';

const express     = require('express');
const axios       = require('axios');
const axiosRetry  = require('axios-retry').default;
const NodeCache   = require('node-cache');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const cheerio     = require('cheerio');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { URL }     = require('url');
const { execFile, exec } = require('child_process');
const { promisify }      = require('util');

const execFileAsync = promisify(execFile);
const execAsync     = promisify(exec);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_KEY = process.env.TMDB_KEY || '480f73d92f9395eb2140f092c746b3bc';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

const QUALITY_RANK = { '4k': 5, '2160p': 5, '1080p': 4, '720p': 3, '480p': 2, '360p': 1, 'auto': 0 };

const DIRS = {
  tmp:  path.join(os.tmpdir(), 'playkit-tmp'),
  logs: path.join(__dirname, 'logs'),
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
// CACHE
// — metadata : long TTL  (TMDB data)
// — streams  : short TTL (yt-dlp URLs expire in ~6 min)
// =============================================================================
const metaCache   = new NodeCache({ stdTTL: 6 * 3600, useClones: false }); // 6 h
const streamCache = new NodeCache({ stdTTL: 60 * 4,   useClones: false }); // 4 min

// =============================================================================
// HTTP CLIENT
// =============================================================================
const randUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const http = axios.create({
  timeout: 20_000,
  maxRedirects: 10,
  validateStatus: s => s < 500,
  headers: {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    DNT: '1',
  },
});

axiosRetry(http, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: e => axiosRetry.isNetworkOrIdempotentRequestError(e),
});

// =============================================================================
// YT-DLP BOOTSTRAP — auto-install at startup if missing
// =============================================================================
const YTDLP_BIN = process.env.YTDLP_PATH || '/usr/local/bin/yt-dlp';

async function ensureYtDlp() {
  // Check if already available
  for (const bin of [YTDLP_BIN, 'yt-dlp', '/usr/bin/yt-dlp']) {
    try { await execFileAsync(bin, ['--version']); logger.info('YTDLP', `Found at ${bin} ✅`); return; } catch {}
  }

  logger.info('YTDLP', 'Not found — installing...');
  try {
    await execAsync('pip3 install -q yt-dlp 2>/dev/null || pip install -q yt-dlp 2>/dev/null');
    logger.info('YTDLP', 'Installed via pip ✅');
    return;
  } catch {}

  try {
    await execAsync(
      `curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${YTDLP_BIN} && chmod +x ${YTDLP_BIN}`
    );
    logger.info('YTDLP', 'Installed via curl ✅');
  } catch (err) {
    logger.error('YTDLP', err, { note: 'YouTube source will not work without yt-dlp' });
  }
}

// =============================================================================
// YOUTUBE SOURCE (PRIMARY)
// =============================================================================
class YouTubeSource {
  get name() { return 'youtube'; }

  async extract(title, year) {
    const cacheKey = `yt_${title}_${year}`;
    const cached   = metaCache.get(cacheKey);
    if (cached) return cached;

    const ytdlpBin = await this._findBin();
    if (!ytdlpBin) throw new Error('yt-dlp binary not found');

    // Step 1: search YouTube for the movie
    const query = `${title} ${year} full movie free`;
    logger.info('YOUTUBE', `Searching: "${query}"`);

    const { stdout: searchOut } = await execFileAsync(ytdlpBin, [
      `ytsearch5:${query}`,
      '--print', '%(id)s|||%(title)s|||%(duration)s',
      '--no-playlist', '--quiet', '--no-warnings',
    ], { timeout: 30_000 });

    const results = searchOut.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        const [id, vtitle, duration] = line.split('|||');
        return { id, title: vtitle, duration: parseInt(duration || '0', 10) };
      });

    if (!results.length) throw new Error('No YouTube search results');

    // Prefer results > 60 min (likely a real movie upload)
    const best = results.find(r => r.duration > 3600) || results[0];
    logger.info('YOUTUBE', `Best match: "${best.title}" (${Math.floor(best.duration / 60)} min)`);

    // Step 2: extract direct URLs for that video
    const links = await this._extractFromId(best.id, ytdlpBin);
    if (links.length) metaCache.set(cacheKey, links, 60 * 4); // 4-min TTL
    return links;
  }

  async extractById(videoId) {
    const ytdlpBin = await this._findBin();
    if (!ytdlpBin) throw new Error('yt-dlp binary not found');
    return this._extractFromId(videoId, ytdlpBin);
  }

  async _extractFromId(videoId, bin) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    logger.info('YOUTUBE', `Extracting formats from ${videoUrl}`);

    const { stdout } = await execFileAsync(bin, [
      videoUrl,
      '--dump-json', '--no-playlist',
      '--quiet', '--no-warnings',
      '--extractor-args', 'youtube:skip=dash',
    ], { timeout: 45_000 });

    const info    = JSON.parse(stdout);
    const formats = (info.formats || [])
      .filter(f => f.url && f.ext !== 'webm' && f.vcodec && f.vcodec !== 'none');

    // Prefer formats that have audio merged in, sorted by resolution desc
    formats.sort((a, b) => {
      const aAudio = (a.acodec && a.acodec !== 'none') ? 1 : 0;
      const bAudio = (b.acodec && b.acodec !== 'none') ? 1 : 0;
      if (aAudio !== bAudio) return bAudio - aAudio;
      return (b.height || 0) - (a.height || 0);
    });

    return formats.slice(0, 5).map(f => ({
      url:     f.url,
      quality: this._hq(f.height),
      type:    (f.protocol || '').includes('m3u8') ? 'hls' : 'mp4',
      source:  this.name,
      videoId,
      title:   info.title,
      headers: {
        'User-Agent': f.http_headers?.['User-Agent'] || randUA(),
        Referer:      f.http_headers?.Referer        || 'https://www.youtube.com/',
        Origin:       'https://www.youtube.com',
      },
    }));
  }

  async _findBin() {
    for (const b of [YTDLP_BIN, 'yt-dlp', '/usr/bin/yt-dlp', path.join(os.homedir(), '.local/bin/yt-dlp')]) {
      try { await execFileAsync(b, ['--version']); return b; } catch {}
    }
    return null;
  }

  _hq(h) {
    if (!h)       return 'auto';
    if (h >= 2160) return '4k';
    if (h >= 1080) return '1080p';
    if (h >= 720)  return '720p';
    if (h >= 480)  return '480p';
    return '360p';
  }
}

// =============================================================================
// FALLBACK SOURCES
// =============================================================================
const SOURCE_HEADERS = {
  superembed: { Referer: 'https://superembed.stream/', Origin: 'https://superembed.stream' },
  moviesapi:  { Referer: 'https://moviesapi.club/',    Origin: 'https://moviesapi.club' },
  vidsrc:     { Referer: 'https://vidsrc.to/',         Origin: 'https://vidsrc.to' },
};
const getHeaders = src => ({ ...(SOURCE_HEADERS[src] || {}), 'User-Agent': randUA() });

class LinkResolver {
  async resolveEmbedUrl(embedUrl, sourceName) {
    try {
      const res  = await http.get(embedUrl, { headers: getHeaders(sourceName), timeout: 15_000 });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const $    = cheerio.load(html);
      const links = [];

      $('video source[src], video[src]').each((_, el) => {
        const s = $(el).attr('src') || $(el).attr('data-src');
        if (s) links.push(this._abs(s, embedUrl));
      });

      $('[data-src],[data-url],[data-video],[data-file]').each((_, el) => {
        ['data-src','data-url','data-video','data-file'].forEach(a => {
          const v = $(el).attr(a);
          if (v?.startsWith('http')) links.push(v);
        });
      });

      $('script').each((_, el) => {
        const code = $(el).html() || '';
        (code.match(/https?:\/\/[^\s"'\\]+?\.(mp4|m3u8)(\?[^\s"'\\]*)?/gi) || [])
          .forEach(m => links.push(this._abs(m, embedUrl)));
      });

      return [...new Set(links)];
    } catch { return []; }
  }

  _abs(url, base) {
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/'))  try { return new URL(url, base).href; } catch {}
    return url;
  }
}

const resolver = new LinkResolver();

const mkFallback = (name, urlFn) => ({
  name,
  async extract(tmdbId) {
    const raw = await resolver.resolveEmbedUrl(urlFn(tmdbId), name);
    return raw.map(url => ({
      url, source: name, headers: getHeaders(name),
      quality: url.includes('1080') ? '1080p' : 'auto',
      type: url.includes('.m3u8') ? 'hls' : 'mp4',
    }));
  },
});

const fallbackSources = [
  mkFallback('superembed', id => `https://superembed.stream/movie/${id}`),
  mkFallback('moviesapi',  id => `https://moviesapi.club/movie/${id}`),
  mkFallback('vidsrc',     id => `https://vidsrc.to/embed/movie/${id}`),
];

// =============================================================================
// STREAM VALIDATOR (Range GET, not HEAD)
// =============================================================================
async function validateLink(url, headers = {}) {
  try {
    const res = await http.get(url, {
      headers: { ...headers, Range: 'bytes=0-65535' },
      responseType: 'stream',
      timeout: 10_000,
    });
    res.data.destroy();
    const ct = (res.headers['content-type'] || '').toLowerCase();
    const ok = [200, 206].includes(res.status) &&
      (ct.includes('video') || ct.includes('octet') || ct.includes('mpegurl') ||
       url.includes('.mp4') || url.includes('.m3u8'));
    return { valid: ok, contentType: ct };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

// =============================================================================
// SOURCE MANAGER
// =============================================================================
class SourceManager {
  constructor() {
    this.youtube = new YouTubeSource();
  }

  async resolveStream(tmdbId, title, year) {
    const cacheKey = `stream_${tmdbId}`;
    const cached   = streamCache.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    // PRIMARY: YouTube
    logger.info('SOURCE_MGR', `Trying YouTube for "${title} (${year})"`);
    try {
      const links = await this.youtube.extract(title, year);
      for (const link of links) {
        const check = await validateLink(link.url, link.headers);
        if (check.valid) {
          streamCache.set(cacheKey, link);
          logger.info('SOURCE_MGR', `✅ YouTube [${link.quality}]`);
          return link;
        }
      }
      logger.warn('SOURCE_MGR', 'YouTube links found but none validated — trying fallbacks');
    } catch (err) {
      logger.warn('SOURCE_MGR', `YouTube failed: ${err.message}`);
    }

    // FALLBACKS
    for (const src of fallbackSources) {
      logger.info('SOURCE_MGR', `Trying fallback: ${src.name}`);
      try {
        const links = await src.extract(tmdbId);
        for (const link of links.slice(0, 3)) {
          const check = await validateLink(link.url, link.headers);
          if (check.valid) {
            streamCache.set(cacheKey, link);
            logger.info('SOURCE_MGR', `✅ Fallback [${src.name}] [${link.quality}]`);
            return link;
          }
        }
      } catch (err) {
        logger.warn('SOURCE_MGR', `${src.name} failed: ${err.message}`);
      }
    }

    return null;
  }
}

const sourceManager = new SourceManager();

// =============================================================================
// TMDB HELPERS
// =============================================================================
async function getTMDBMovie(tmdbId) {
  const k = `tmdb_${tmdbId}`;
  if (metaCache.has(k)) return metaCache.get(k);
  const res = await http.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}`);
  metaCache.set(k, res.data);
  return res.data;
}

// =============================================================================
// HLS REWRITER
// =============================================================================
async function rewriteHLS(m3u8Url, hdrs, baseProxy) {
  const res  = await http.get(m3u8Url, { headers: hdrs, timeout: 15_000 });
  const base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  const encodedHdrs = encodeURIComponent(JSON.stringify(hdrs));

  return res.data.split('\n').map(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return line;
    try {
      const abs = new URL(line, base).href;
      return `${baseProxy}/api/hls/segment?url=${encodeURIComponent(abs)}&hdrs=${encodedHdrs}`;
    } catch { return line; }
  }).join('\n');
}

// =============================================================================
// EXPRESS SETUP
// =============================================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers',
    'Content-Length, Content-Disposition, Content-Range, Accept-Ranges, X-Source, X-Quality, X-Video-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(compression());
app.use(express.json());
app.use(express.static('public'));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 120, message: { error: 'Rate limit exceeded' } }));

// =============================================================================
// ROUTES
// =============================================================================
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/movie/:tmdbId', async (req, res) => {
  try {
    const m = await getTMDBMovie(req.params.tmdbId);
    res.json({
      id: m.id, title: m.title,
      year: new Date(m.release_date).getFullYear(),
      overview: m.overview, runtime: m.runtime, rating: m.vote_average,
      poster:   `https://image.tmdb.org/t/p/w500${m.poster_path}`,
      backdrop: `https://image.tmdb.org/t/p/w1280${m.backdrop_path}`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing q' });
    const r = await http.get(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(q)}`);
    res.json((r.data?.results || []).slice(0, 10).map(m => ({
      id: m.id, title: m.title,
      year: m.release_date?.split('-')[0],
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w185${m.poster_path}` : null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resolve — returns stream info as JSON, no piping
app.get('/api/resolve/:tmdbId', async (req, res) => {
  try {
    const movie  = await getTMDBMovie(req.params.tmdbId);
    const title  = movie.title;
    const year   = new Date(movie.release_date).getFullYear();
    const stream = await sourceManager.resolveStream(req.params.tmdbId, title, year);
    if (!stream) return res.status(503).json({ error: 'No stream found across all sources' });
    res.json({
      title, year,
      url:      stream.url,
      quality:  stream.quality,
      type:     stream.type,
      source:   stream.source,
      videoId:  stream.videoId || null,
      streamProxy:   `/api/stream/${req.params.tmdbId}`,
      downloadProxy: `/api/download/${req.params.tmdbId}`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Streaming proxy
app.get('/api/stream/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  try {
    const movie  = await getTMDBMovie(tmdbId);
    const stream = await sourceManager.resolveStream(
      tmdbId, movie.title, new Date(movie.release_date).getFullYear()
    );
    if (!stream) return res.status(503).json({ error: 'No stream available' });

    res.setHeader('X-Source',   stream.source);
    res.setHeader('X-Quality',  stream.quality);
    if (stream.videoId) res.setHeader('X-Video-Id', stream.videoId);

    const hdrs = stream.headers || getHeaders(stream.source);

    // HLS path
    if (stream.type === 'hls' || stream.url.includes('.m3u8')) {
      const playlist = await rewriteHLS(stream.url, hdrs, `${req.protocol}://${req.get('host')}`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(playlist);
    }

    // MP4 path — range-aware pipe
    const upstream = await http.get(stream.url, {
      headers: { ...hdrs, ...(req.headers['range'] ? { Range: req.headers['range'] } : {}) },
      responseType: 'stream',
      timeout: 0,
    });

    ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status);
    upstream.data.pipe(res);
    req.on('close', () => upstream.data.destroy());

  } catch (err) {
    logger.error('STREAM', err, { tmdbId });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// HLS segment proxy
app.get('/api/hls/segment', async (req, res) => {
  const { url, hdrs } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  let headers = {};
  try { headers = JSON.parse(decodeURIComponent(hdrs || '{}')); } catch {}
  try {
    const up = await http.get(decodeURIComponent(url), {
      headers: { ...headers, 'User-Agent': randUA() },
      responseType: 'stream', timeout: 30_000,
    });
    res.setHeader('Content-Type',   up.headers['content-type']   || 'video/MP2T');
    res.setHeader('Content-Length', up.headers['content-length'] || '');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(up.status);
    up.data.pipe(res);
    req.on('close', () => up.data.destroy());
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Segment failed' });
  }
});

// Download
app.get('/api/download/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  try {
    const movie  = await getTMDBMovie(tmdbId);
    const stream = await sourceManager.resolveStream(
      tmdbId, movie.title, new Date(movie.release_date).getFullYear()
    );
    if (!stream) return res.status(503).json({ error: 'No downloadable stream found' });

    const hdrs     = stream.headers || getHeaders(stream.source);
    const safeName = movie.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${stream.quality}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Source',  stream.source);
    res.setHeader('X-Quality', stream.quality);
    res.setHeader('Cache-Control', 'no-store');

    // HLS: stitch segments
    if (stream.type === 'hls' || stream.url.includes('.m3u8')) {
      const pr  = await http.get(stream.url, { headers: hdrs });
      const base = stream.url.substring(0, stream.url.lastIndexOf('/') + 1);
      const segs = pr.data.split('\n').filter(l => l && !l.startsWith('#'));
      for (const seg of segs) {
        if (res.destroyed) break;
        try {
          const segUrl = seg.startsWith('http') ? seg : new URL(seg, base).href;
          const sr = await http.get(segUrl, { headers: hdrs, responseType: 'arraybuffer', timeout: 30_000 });
          res.write(Buffer.from(sr.data));
        } catch {}
      }
      return res.end();
    }

    // MP4: direct pipe
    const up = await http.get(stream.url, { headers: hdrs, responseType: 'stream', timeout: 0 });
    if (up.headers['content-length']) res.setHeader('Content-Length', up.headers['content-length']);
    up.data.pipe(res);
    req.on('close', () => up.data.destroy());

  } catch (err) {
    logger.error('DOWNLOAD', err, { tmdbId });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Direct YouTube extract by video ID
app.get('/api/youtube/:videoId', async (req, res) => {
  try {
    const links = await sourceManager.youtube.extractById(req.params.videoId);
    res.json({ videoId: req.params.videoId, links });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cache/status', (_, res) => res.json({
  meta: metaCache.keys().length, stream: streamCache.keys().length,
  uptime: Math.floor(process.uptime()),
}));

app.post('/api/cache/clear', (_, res) => {
  metaCache.flushAll(); streamCache.flushAll();
  res.json({ ok: true });
});

// =============================================================================
// STARTUP
// =============================================================================
async function start() {
  await ensureYtDlp();
  app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║         PLAYKIT Streaming Server v3.1                            ║
╠══════════════════════════════════════════════════════════════════╣
║  Listening on http://${HOST}:${PORT}                                 ║
║                                                                  ║
║  Primary  : YouTube (yt-dlp)                                     ║
║  Fallbacks: SuperEmbed → MoviesAPI → VidSrc                      ║
║                                                                  ║
║  GET /api/search?q=          search TMDB                         ║
║  GET /api/movie/:id          metadata                            ║
║  GET /api/resolve/:id        stream info JSON                    ║
║  GET /api/stream/:id         proxy stream (MP4 or HLS)           ║
║  GET /api/download/:id       download file                       ║
║  GET /api/youtube/:videoId   extract by YT video ID              ║
╚══════════════════════════════════════════════════════════════════╝`);
  });
}

start().catch(err => { logger.error('STARTUP', err); process.exit(1); });

module.exports = app;
