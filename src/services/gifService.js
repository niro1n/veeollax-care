const gifKeywords = require("../config/gifKeywords");

/**
 * In-memory cache keyed by query signature.
 * Shape: Map<string, { urls: string[], cachedAt: number }>
 */
const queryCache = new Map();

/**
 * Track recently delivered GIF URLs to avoid returning identical GIFs consecutively.
 */
const recentlyUsedUrls = new Set();
const MAX_RECENTLY_USED = 40;

/**
 * Cache time-to-live: 6 hours (21600000 ms).
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

function buildCacheKey(queryConfig) {
  const terms = Array.isArray(queryConfig.requiredTerms)
    ? queryConfig.requiredTerms.join(",")
    : "";
  return `${queryConfig.q}::${terms}`;
}

/**
 * Filters out real-life animals, NFTs, and irrelevant spam so only cute
 * 2D cartoon characters (Bubu Dudu, Milk & Mocha, Nailong, Loof & Timmy, etc.) pass.
 */
function isRelevantCartoonGif(item, queryConfig) {
  if (!item || typeof item !== "object") {
    return false;
  }

  const title = (item.title || "").toLowerCase();
  const slug = (item.slug || "").toLowerCase();
  const username = (item.username || "").toLowerCase();
  const combined = `${title} ${slug} ${username}`;

  const blockedTerms = gifKeywords.blockedTerms || [];
  for (const blocked of blockedTerms) {
    if (combined.includes(blocked.toLowerCase())) {
      return false;
    }
  }

  if (
    Array.isArray(queryConfig.requiredTerms) &&
    queryConfig.requiredTerms.length > 0
  ) {
    const hasMatch = queryConfig.requiredTerms.some((term) =>
      combined.includes(term.toLowerCase()),
    );
    if (!hasMatch) {
      return false;
    }
  }

  return true;
}

/**
 * Extracts and validates a clean GIF URL suitable for Discord embeds.
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
    const cleanUrl = candidate.split("?")[0];
    if (cleanUrl.endsWith(".gif") || cleanUrl.includes("giphy.com")) {
      return cleanUrl;
    }
  }

  return null;
}

function sanitizeMessage(text) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (apiKey && typeof text === "string") {
    return text.replaceAll(apiKey, "[REDACTED_API_KEY]");
  }
  return text;
}

/**
 * Resolves both query pool and curated fallback pool tailored to
 * the reminder category and message content.
 */
function resolveQueryPool(category, messageText = "") {
  const lowerMessage = (messageText || "").toLowerCase();
  const baseQueries =
    gifKeywords.categories[category] ||
    gifKeywords.categories.shortBreak ||
    [];
  const baseFallbacks =
    (gifKeywords.categoryFallbacks && gifKeywords.categoryFallbacks[category]) ||
    (gifKeywords.categoryFallbacks && gifKeywords.categoryFallbacks.shortBreak) ||
    [];

  if (lowerMessage && gifKeywords.messageMoods) {
    const matchedMoodQueries = [];
    const matchedMoodFallbacks = [];

    for (const mood of Object.values(gifKeywords.messageMoods)) {
      const isAllowedCategory =
        !mood.allowedCategories || mood.allowedCategories.includes(category);

      if (!isAllowedCategory) continue;

      const hasKeyword = (mood.keywords || []).some((kw) =>
        lowerMessage.includes(kw.toLowerCase()),
      );

      if (hasKeyword) {
        if (Array.isArray(mood.queries)) {
          matchedMoodQueries.push(...mood.queries);
        }
        if (Array.isArray(mood.fallbacks)) {
          matchedMoodFallbacks.push(...mood.fallbacks);
        }
      }
    }

    if (matchedMoodQueries.length > 0) {
      return {
        primary: matchedMoodQueries,
        fallback: baseQueries,
        fallbackUrls:
          matchedMoodFallbacks.length > 0 ? matchedMoodFallbacks : baseFallbacks,
      };
    }
  }

  return {
    primary: baseQueries,
    fallback: [],
    fallbackUrls: baseFallbacks,
  };
}

/**
 * Fetches a filtered batch of cartoon GIFs from GIPHY Search API.
 */
async function fetchGifsFromGiphy(queryConfig) {
  const apiKey = process.env.GIPHY_API_KEY;

  if (!apiKey || apiKey.trim() === "" || apiKey === "YOUR_GIPHY_API_KEY") {
    return { urls: [], rateLimited: false };
  }

  const rating = gifKeywords.defaultRating || "g";
  const limit = gifKeywords.limit || 15;

  const endpoint = new URL("https://api.giphy.com/v1/gifs/search");
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("q", queryConfig.q);
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

    if (response.status === 429) {
      console.warn(
        `[GIPHY WARNING] Rate limit (429) reached for query "${queryConfig.q}". Using cached/fallback GIF.`,
      );
      return { urls: [], rateLimited: true };
    }

    if (!response.ok) {
      console.warn(
        `[GIPHY WARNING] GIPHY API responded with status ${response.status} for query "${queryConfig.q}".`,
      );
      return { urls: [], rateLimited: false };
    }

    const payload = await response.json();

    if (!payload.data || !Array.isArray(payload.data)) {
      return { urls: [], rateLimited: false };
    }

    const validUrls = payload.data
      .filter((item) => isRelevantCartoonGif(item, queryConfig))
      .map(extractValidGifUrl)
      .filter((url) => typeof url === "string" && url.length > 0);

    return { urls: validUrls, rateLimited: false };
  } catch (error) {
    const safeError = sanitizeMessage(error.message || String(error));
    console.warn(
      `[GIPHY WARNING] Failed to retrieve GIF for query "${queryConfig.q}": ${safeError}`,
    );
    return { urls: [], rateLimited: false };
  }
}

async function getUrlsForQuery(queryConfig) {
  const now = Date.now();
  const cacheKey = buildCacheKey(queryConfig);
  const cached = queryCache.get(cacheKey);

  if (cached && now - cached.cachedAt <= CACHE_TTL_MS && cached.urls.length > 0) {
    return { urls: cached.urls, rateLimited: false };
  }

  const { urls, rateLimited } = await fetchGifsFromGiphy(queryConfig);

  if (urls.length > 0) {
    queryCache.set(cacheKey, {
      urls,
      cachedAt: now,
    });
    return { urls, rateLimited };
  }

  if (cached && cached.urls.length > 0) {
    return { urls: cached.urls, rateLimited };
  }

  return { urls: [], rateLimited };
}

function pickUniqueUrl(urlPool) {
  if (!Array.isArray(urlPool) || urlPool.length === 0) {
    return null;
  }

  const unused = urlPool.filter((url) => !recentlyUsedUrls.has(url));
  const pool = unused.length > 0 ? unused : urlPool;
  const selected = getRandomItem(pool);

  if (selected) {
    recentlyUsedUrls.add(selected);
    if (recentlyUsedUrls.size > MAX_RECENTLY_USED) {
      const oldest = recentlyUsedUrls.values().next().value;
      recentlyUsedUrls.delete(oldest);
    }
  }

  return selected;
}

/**
 * Main public function: Retrieves a cute cartoon GIF matching the reminder
 * category and message context, with caching, deduplication, and fallback.
 */
async function getCategoryGif(
  category,
  messageText = "",
  options = { allowFallback: true },
) {
  try {
    const { primary, fallback, fallbackUrls } = resolveQueryPool(
      category,
      messageText,
    );
    const candidates = [...primary];

    const chosenPrimary = getRandomItem(candidates);
    let availableUrls = [];

    if (chosenPrimary) {
      const result = await getUrlsForQuery(chosenPrimary);
      availableUrls = result.urls;

      if (availableUrls.length === 0 && !result.rateLimited) {
        const remainingPool = [
          ...candidates.filter((c) => c !== chosenPrimary),
          ...fallback,
        ];
        const nextQuery = getRandomItem(remainingPool);
        if (nextQuery) {
          const retryResult = await getUrlsForQuery(nextQuery);
          availableUrls = retryResult.urls;
        }
      }
    }

    // Check any cached entry in the pool before falling back to static fallback pool
    if (availableUrls.length === 0) {
      const allPool = [...primary, ...fallback];
      for (const qObj of allPool) {
        const stale = queryCache.get(buildCacheKey(qObj));
        if (stale && stale.urls.length > 0) {
          availableUrls = stale.urls;
          break;
        }
      }
    }

    if (availableUrls.length > 0) {
      return pickUniqueUrl(availableUrls);
    }

    if (options.allowFallback !== false && fallbackUrls.length > 0) {
      return pickUniqueUrl(fallbackUrls);
    }

    return null;
  } catch (error) {
    console.warn(
      "[GIPHY ERROR] Unexpected error in getCategoryGif:",
      sanitizeMessage(error.message),
    );
    return null;
  }
}

function clearGifCache() {
  queryCache.clear();
  recentlyUsedUrls.clear();
}

module.exports = {
  getCategoryGif,
  fetchGifsFromGiphy,
  resolveQueryPool,
  clearGifCache,
};
