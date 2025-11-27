const { createClient } = require('@vercel/kv');

const API_KEY = process.env.TOMTOM_API_KEY;

let kv = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
} else {
  console.warn('KV_REST_API_URL or KV_REST_API_TOKEN not set; caching disabled.');
}

const activeDownloads = new Map();

module.exports = async function handler(req, res) {
  const { method, url, query } = req;

  // Root endpoint
  if (url === '/' || url === '/index.html') {
    res.statusCode = 200;
    res.end('Tile server operational');
    return;
  }

  // Tile endpoint
  if (method === 'GET' && url.startsWith('/tile')) {
    const x = parseInt(query.x, 10);
    const y = parseInt(query.y, 10);
    const z = parseInt(query.z, 10);

    if (
      isNaN(x) || !Number.isInteger(x) ||
      isNaN(y) || !Number.isInteger(y) ||
      isNaN(z) || !Number.isInteger(z)
    ) {
      res.statusCode = 400;
      res.end('Invalid or missing x, y, z query parameters');
      return;
    }

    const cacheKey = `tile:${z}_${x}_${y}`;

    try {
      // Cache lookup
      if (kv) {
        const cached = await kv.get(cacheKey);
        if (cached) {
          res.setHeader('Content-Type', 'image/png');
          res.end(Buffer.from(cached, 'base64'));
          return;
        }
      }

      // Coalesce duplicate requests
      if (activeDownloads.has(cacheKey)) {
        await new Promise(resolve => activeDownloads.get(cacheKey).push(resolve));
        return;
      }

      const waiters = [];
      activeDownloads.set(cacheKey, waiters);

      const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png?key=${API_KEY}`;

      const fetchModule = await import('node-fetch');
      const fetch = fetchModule.default;

      const tileResp = await fetch(tileUrl);
      if (!tileResp.ok) throw new Error(`Tile fetch failed: ${tileResp.status}`);

      const buffer = await tileResp.arrayBuffer();
      const tileData = Buffer.from(buffer).toString('base64');

      if (kv) await kv.set(cacheKey, tileData, { ex: 300 });

      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from(tileData, 'base64'));

      for (const waiter of waiters) waiter();
    } catch (err) {
      res.statusCode = 500;
      res.end(err.message);
    } finally {
      activeDownloads.delete(cacheKey);
    }
    return;
  }

  // Fallback
  res.statusCode = 404;
  res.end('Not found');
};