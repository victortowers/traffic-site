import express from 'express';
import { createClient } from '@vercel/kv';
import fetch from 'node-fetch';

const app = express();
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

app.get("/tile", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const z = parseInt(req.query.z || "13");

  if (isNaN(lat) || isNaN(lon) || isNaN(z)) return res.status(400).send("Invalid lat/lon/z");

  const cacheKey = `tile:${z}_${lat}_${lon}`;
  
  try {
    // Check KV cache first
    const cachedTile = await kv.get(cacheKey);
    if (cachedTile) {
      return res.type("png").send(Buffer.from(cachedTile, 'base64'));
    }

    // Request coalescing
    if (activeDownloads.has(cacheKey)) {
      await new Promise(resolve => activeDownloads.get(cacheKey).push(resolve));
      return;
    }

    const waiters = [];
    activeDownloads.set(cacheKey, waiters);

    const { x, y } = latLonToTile(lat, lon, z);
    const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png?key=${API_KEY}`;
    
    const tileResp = await fetch(tileUrl);
    if (!tileResp.ok) throw new Error(`Tile fetch failed: ${tileResp.status}`);

    const buffer = await tileResp.arrayBuffer();
    const tileData = Buffer.from(buffer).toString('base64');

    // Store in KV with 300s TTL
    await kv.set(cacheKey, tileData, { ex: 300 });

    // Respond to all waiting requests
    res.type("png").send(Buffer.from(tileData, 'base64'));
    for (const waiter of waiters) {
      waiter();
    }
  } catch (err) {
    res.status(500).send(err.message);
  } finally {
    activeDownloads.delete(cacheKey);
  }
});

// Add root endpoint
app.get("/", (req, res) => {
  res.send("Tile server operational");
});

// Vercel serverless function handler
export default app;