import { deflateSync } from "node:zlib";

export const CHAT_ASSET_VERSION = "20260820-pwa1";

export const CHAT_MANIFEST = `${JSON.stringify({
  name: "LocalLLM Private Chat",
  short_name: "LocalLLM",
  description: "Private chat backed by your own LocalLLM compute through LazyEdge.",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f4f7f6",
  theme_color: "#f7faf9",
  orientation: "any",
  categories: ["productivity", "utilities"],
  icons: [
    {
      src: "/assets/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any maskable",
    },
    {
      src: "/assets/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ],
})}\n`;

export const CHAT_SERVICE_WORKER = String.raw`"use strict";

var VERSION = "${CHAT_ASSET_VERSION}";
var CACHE_PREFIX = "lazyedge-private-chat-";
var CACHE_NAME = CACHE_PREFIX + VERSION;
var SHELL = [
  "/",
  "/manifest.webmanifest",
  "/assets/app.css",
  "/assets/app.js",
  "/assets/markdown.js",
  "/assets/katex.mjs",
  "/assets/icon-192.png",
  "/assets/icon-512.png"
];
var STATIC_PATHS = new Set(SHELL.slice(1));

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return Promise.all(SHELL.map(function (path) {
      var request = new Request(path, {
        cache: "reload",
        credentials: "same-origin"
      });
      return fetch(request).then(function (response) {
        if (!response.ok || response.type === "opaque") throw new Error("PWA asset unavailable");
        return cache.put(path, response);
      });
    }));
  }));
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (name) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) return caches.delete(name);
      return Promise.resolve(false);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return;
  if (url.pathname.startsWith("/chat/api/") || url.pathname.startsWith("/v1/")) return;

  if (request.mode === "navigate" && url.pathname === "/") {
    event.respondWith(fetch(request).then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
          return cache.put("/", copy);
        }));
      }
      return response;
    }).catch(function () {
      return caches.match("/").then(function (cached) {
        return cached || Response.error();
      });
    }));
    return;
  }

  if (!STATIC_PATHS.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(url.pathname).then(function (cached) {
      return cached || fetch(request);
    });
  }));
});
`;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const value = Buffer.allocUnsafe(12 + data.length);
  value.writeUInt32BE(data.length, 0);
  typeBuffer.copy(value, 4);
  data.copy(value, 8);
  value.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return value;
}

function roundedRectangle(x, y, left, top, right, bottom, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return x >= left && x <= right && y >= top && y <= bottom && dx * dx + dy * dy <= radius * radius;
}

function makeIcon(size) {
  const rowBytes = 1 + size * 4;
  const pixels = Buffer.alloc(rowBytes * size);
  const scale = size / 512;
  const bars = [
    [166, 235, 202, 336, 18],
    [223, 165, 259, 336, 18],
    [280, 201, 316, 336, 18],
  ];
  for (let y = 0; y < size; y += 1) {
    const row = y * rowBytes;
    pixels[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const normalizedX = x / Math.max(1, size - 1);
      const normalizedY = y / Math.max(1, size - 1);
      const glow = Math.max(0, 1 - Math.hypot(normalizedX - 0.7, normalizedY - 0.18));
      let red = Math.round(28 + 18 * normalizedY + 20 * glow);
      let green = Math.round(132 + 40 * normalizedX + 28 * glow);
      let blue = Math.round(135 + 50 * (1 - normalizedY) + 22 * glow);
      const px = x / scale;
      const py = y / scale;
      if (Math.hypot(px - 256, py - 256) < 170) {
        red = Math.round(red * 0.72);
        green = Math.round(green * 0.82);
        blue = Math.round(blue * 0.85);
      }
      for (const [left, top, right, bottom, radius] of bars) {
        if (roundedRectangle(px, py, left, top, right, bottom, radius)) {
          red = 225;
          green = 255;
          blue = 249;
          break;
        }
      }
      const offset = row + 1 + x * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const CHAT_ICON_192 = makeIcon(192);
export const CHAT_ICON_512 = makeIcon(512);
