import express from "express";
import fetch from "node-fetch";
import NodeCache from "node-cache";

const app = express();
const API_KEY = process.env.TOMTOM_API_KEY;
const cache = new NodeCache({ stdTTL: 300, checkperiod: 0 }); // 300s TTL, disable automatic expiration checks

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

  const cacheKey = `${z}_${lat}_${lon}`;
  let cached = cache.get(cacheKey);
  if (cached) {
    // Check if expired
    const ttl = cache.getTtl(cacheKey);
    if (ttl && ttl > Date.now()) {
      return res.type("png").send(cached);
    } else {
      cache.del(cacheKey); // Remove expired entry
      cached = null; // Force fresh download
    }
  }

  const { x, y } = latLonToTile(lat, lon, z);
  const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png?key=${API_KEY}`;

  if (!cached) {
    try {
      const tileResp = await fetch(tileUrl);
      if (!tileResp.ok) return res.status(tileResp.status).send("Error fetching tile");
      const buffer = Buffer.from(await tileResp.arrayBuffer());
    
      // Delete expired cache entries when adding new tile
      const now = Date.now();
      cache.keys().forEach(key => {
        const ttl = cache.getTtl(key);
        if (ttl && ttl < now) {
          cache.del(key);
        }
      });
    
      cache.set(cacheKey, buffer);
      res.type("png").send(buffer);
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
});

app.listen(30001, () => console.log("Tile server running on port 30001"));
