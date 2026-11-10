const gifKeywords = require("../config/gifKeywords");

/**
 * In-memory cache for fetched GIF URLs by category.
 * Shape: Map<category, { urls: string[], cachedAt: number }>
 */
const categoryCache = new Map();

/**
 * Track recently delivered GIF URLs to avoid returning identical GIFs consecutively.
 * Uses a rolling Set with MAX_RECENTLY_USED items.
 */
const recentlyUsedUrls = new Set();
const MAX_RECENTLY_USED = 30;

/**
 * Cache time-to-live: 1 hour (3600000 ms).
 * Helps stay well within GIPHY API free tier rate limits while keeping GIFs fresh.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Network timeout for GIPHY API requests: 5 seconds.
 */
const REQUEST_TIMEOUT_MS = 5000;

function getRandomItem(array) {
  if (!Array.isArray(array) || array.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * array.length);
  return array[index];
}

/**
 * Validates and extracts a direct GIF URL suitable for Discord embeds.
 * Prioritizes medium/downsized sizes (< 5MB) for fast Discord rendering.
 */
function extractValidGifUrl(item) {
  if (!item || typeof item !== "object" || !item.images) {
    return null;
  }

  const candidate =
    item.images.downsized_medium?.url ||
    item.images.downsized?.url ||
    item.images.original?.url ||
    item.images.fixed_height?.url;

  if (typeof candidate === "string" && candidate.startsWith("http")) {
    // Strip trailing query parameters if present
    const cleanUrl = candidate.split("?")[0];
    if (cleanUrl.endsWith(".gif") || cleanUrl.includes("giphy.com")) {
      return cleanUrl;
    }
  }

  return null;
}

/**
 * Sanitizes log output to ensure GIPHY_API_KEY is never leaked in logs.
 */
function sanitizeMessage(text) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (apiKey && typeof text === "string") {
    return text.replaceAll(apiKey, "[REDACTED_API_KEY]");
  }
  return text;
}

/**
 * Fetches a fresh batch of GIFs from GIPHY Search API for a specific category.
 * Returns an array of valid GIF URLs or an empty array on error/no key.
 */
async function fetchGifsFromGiphy(category) {
  const apiKey = process.env.GIPHY_API_KEY;

  if (!apiKey || apiKey.trim() === "" || apiKey === "YOUR_GIPHY_API_KEY") {
    // Graceful skip: no key configured
    return [];
  }

  const keywordPool =
    gifKeywords.categories[category] ||
    gifKeywords.categories.shortBreak ||
    [];

  const keyword = getRandomItem(keywordPool) || "cute cat love";
  const rating = gifKeywords.defaultRating || "g";
  const limit = gifKeywords.limit || 25;

  const endpoint = new URL("https://api.giphy.com/v1/gifs/search");
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("q", keyword);
  endpoint.searchParams.set("limit", limit.toString());
  endpoint.searchParams.set("rating", rating);
  endpoint.searchParams.set("lang", "en");

  try {
    const response = await fetch(endpoint.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn(
        `[GIPHY WARNING] GIPHY API responded with status ${response.status} for category "${category}".`,
      );
      return [];
    }

    const payload = await response.json();

    if (!payload.data || !Array.isArray(payload.data)) {
      return [];
    }

    const validUrls = payload.data
      .map(extractValidGifUrl)
      .filter((url) => typeof url === "string" && url.length > 0);

    return validUrls;
  } catch (error) {
    const safeError = sanitizeMessage(error.message || String(error));
    console.warn(
      `[GIPHY WARNING] Could not retrieve GIF for category "${category}": ${safeError}`,
    );
    return [];
  }
}

/**
 * Main public function: Retrieves a category-specific, non-repeating GIF URL.
 * Automatically checks cache first, refreshes if expired, and manages deduplication.
 * Returns a valid GIF URL string or null if unavailable.
 */
async function getCategoryGif(category) {
  try {
    const now = Date.now();
    let cached = categoryCache.get(category);

    // If cache is missing, empty, or expired (older than CACHE_TTL_MS), fetch fresh URLs
    if (!cached || now - cached.cachedAt > CACHE_TTL_MS || cached.urls.length === 0) {
      const freshUrls = await fetchGifsFromGiphy(category);

      if (freshUrls.length > 0) {
        cached = {
          urls: freshUrls,
          cachedAt: now,
        };
        categoryCache.set(category, cached);
      }
    }

    const availableUrls = cached?.urls || [];

    if (availableUrls.length === 0) {
      return null;
    }

    // Filter out recently used URLs to prevent duplicates
    const unusedUrls = availableUrls.filter((url) => !recentlyUsedUrls.has(url));

    // If all URLs in cache have been used recently, reuse available pool
    const pool = unusedUrls.length > 0 ? unusedUrls : availableUrls;

    const selectedUrl = getRandomItem(pool);

    if (selectedUrl) {
      recentlyUsedUrls.add(selectedUrl);
      if (recentlyUsedUrls.size > MAX_RECENTLY_USED) {
        const oldest = recentlyUsedUrls.values().next().value;
        recentlyUsedUrls.delete(oldest);
      }
    }

    return selectedUrl;
  } catch (error) {
    console.warn(
      "[GIPHY ERROR] Unexpected error in getCategoryGif:",
      sanitizeMessage(error.message),
    );
    return null;
  }
}

/**
 * Utility helper to clear in-memory cache and history (useful for testing).
 */
function clearGifCache() {
  categoryCache.clear();
  recentlyUsedUrls.clear();
}

module.exports = {
  getCategoryGif,
  fetchGifsFromGiphy,
  clearGifCache,
};
