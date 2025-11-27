const express = require('express');
const { createClient } = require('@vercel/kv');

const API_KEY = process.env.TOMTOM_API_KEY;

// Initialize Vercel KV client
const kv = createClient({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Request coalescing to prevent duplicate downloads
const activeDownloads = new Map();

function latLonToTile(lat, lon, z) {
  const x = Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, z)
  );
  return { x, y };
}

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
    const lat = parseFloat(query.lat);
    const lon = parseFloat(query.lon);
    const z = parseInt(query.z || '13');

    if (isNaN(lat) || isNaN(lon) || isNaN(z)) {
      res.statusCode = 400;
      res.end('Invalid lat/lon/z');
      return;
    }

    const cacheKey = `tile:${z}_${lat}_${lon}`;

    try {
      const cachedTile = await kv.get(cacheKey);
      if (cachedTile) {
        res.setHeader('Content-Type', 'image/png');
        res.end(Buffer.from(cachedTile, 'base64'));
        return;
      }

      if (activeDownloads.has(cacheKey)) {
        await new Promise(resolve => activeDownloads.get(cacheKey).push(resolve));
        return;
      }

      const waiters = [];
      activeDownloads.set(cacheKey, waiters);

      const { x, y } = latLonToTile(lat, lon, z);
      const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png?key=${API_KEY}`;

      // Dynamic import of node-fetch (ESM)
      const fetchModule = await import('node-fetch');
      const fetch = fetchModule.default;

      const tileResp = await fetch(tileUrl);
      if (!tileResp.ok) throw new Error(`Tile fetch failed: ${tileResp.status}`);

      const buffer = await tileResp.arrayBuffer();
      const tileData = Buffer.from(buffer).toString('base64');

      await kv.set(cacheKey, tileData, { ex: 300 });

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