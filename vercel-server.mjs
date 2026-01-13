import express from "express";
import fetch from "node-fetch";
import NodeCache from "node-cache";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();
const API_KEY = process.env.TOMTOM_API_KEY;
const cache = new NodeCache({ stdTTL: 300 }); // 120s TTL

function latLonToTile(lat, lon, z) {
  const x = Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, z)
  );
  return { x, y };
}

app.get("/tile", async (req, res) => {
  const z = parseInt(req.query.z || "13");
  
  // Check if tile coordinates (x, y) are provided
  const x = parseInt(req.query.x);
  const y = parseInt(req.query.y);
  
  // Check if GPS coordinates (lat, lon) are provided
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  
  // Validate input
  if (isNaN(z)) {
    return res.status(400).send("Invalid z parameter");
  }
  
  let cacheKey, tileX, tileY;
  
  if (!isNaN(x) && !isNaN(y)) {
    // Use direct tile coordinates
    tileX = x;
    tileY = y;
    cacheKey = `tile_${z}_${x}_${y}`;
  } else if (!isNaN(lat) && !isNaN(lon)) {
    // Convert GPS to tile coordinates
    const { x: tileXFromLatLon, y: tileYFromLatLon } = latLonToTile(lat, lon, z);
    tileX = tileXFromLatLon;
    tileY = tileYFromLatLon;
    cacheKey = `gps_${z}_${lat}_${lon}`;
  } else {
    return res.status(400).send("Please provide either x,y,z or lat,lon,z parameters");
  }

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) return res.type("png").send(cached);

  // Fetch tile from TomTom API
  const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${tileX}/${tileY}.png?key=${API_KEY}&thickness=6`;

  try {
    const tileResp = await fetch(tileUrl);
    if (!tileResp.ok) return res.status(tileResp.status).send("Error fetching tile");
    const buffer = Buffer.from(await tileResp.arrayBuffer());
    cache.set(cacheKey, buffer);
    res.type("png").send(buffer);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Cache statistics endpoint
app.get("/cache-stats", (req, res) => {
  res.json({
    keys: cache.keys(),          // Array of all cache keys
    stats: cache.getStats(),     // Cache statistics (hits, misses, etc.)
    memory: process.memoryUsage() // Node.js memory usage
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.status(200).send("Success");
});

app.listen(30001, () => console.log("Tile server running on port 30001"));