const fs = require("fs");
const path = require("path");
const gifKeywords = require("../config/gifKeywords");

const DEFAULT_CACHE_PATH = path.join(__dirname, "../../storage/gifCache.json");
const CACHE_SCHEMA_VERSION = 1;

const queryCache = new Map();

const recentlyUsedUrls = new Set();
const MAX_RECENTLY_USED = 40;

let apiCallTimestamps = [];
let rateLimitCooldownUntil = 0;
let lastCooldownNoticeAt = 0;
let diskLoaded = false;
let diskPersistenceEnabled = true;

const inFlightRequests = new Map();

const CACHE_TTL_MS = 72 * 60 * 60 * 1000;
const STALE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_WINDOW_MS = 60 * 60 * 1000;
const MAX_API_CALLS_PER_HOUR = 60;
const RATE_LIMIT_COOLDOWN_MS = 20 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const AUTH_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_LOG_THROTTLE_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 5000;

const termRegexCache = new Map();

function getCacheFilePath() {
  if (process.env.GIF_CACHE_PATH && process.env.GIF_CACHE_PATH.trim() !== "") {
    return path.resolve(process.env.GIF_CACHE_PATH);
  }
  return DEFAULT_CACHE_PATH;
}

function pruneApiCallTimestamps(now = Date.now()) {
  apiCallTimestamps = apiCallTimestamps.filter(
    (ts) => typeof ts === "number" && Number.isFinite(ts) && ts > now - HOUR_WINDOW_MS && ts <= now + 5000,
  );
  return apiCallTimestamps;
}

function trimRecentlyUsed() {
  while (recentlyUsedUrls.size > MAX_RECENTLY_USED) {
    const oldest = recentlyUsedUrls.values().next().value;
    recentlyUsedUrls.delete(oldest);
  }
}

function ensureCacheLoaded() {
  if (diskLoaded || !diskPersistenceEnabled) {
    return;
  }
  diskLoaded = true;

  const filePath = getCacheFilePath();
  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const now = Date.now();

    if (parsed.queries && typeof parsed.queries === "object" && !Array.isArray(parsed.queries)) {
      for (const [q, entry] of Object.entries(parsed.queries)) {
        if (
          entry &&
          typeof entry === "object" &&
          Array.isArray(entry.items) &&
          typeof entry.cachedAt === "number" &&
          now - entry.cachedAt <= STALE_CACHE_TTL_MS
        ) {
          const validItems = entry.items.filter(
            (it) =>
              it &&
              typeof it.url === "string" &&
              typeof it.combinedText === "string" &&
              it.url.startsWith("http"),
          );
          if (validItems.length > 0) {
            queryCache.set(q, { items: validItems, cachedAt: entry.cachedAt });
          }
        }
      }
    }

    if (Array.isArray(parsed.recentlyUsedUrls)) {
      for (const url of parsed.recentlyUsedUrls.slice(-MAX_RECENTLY_USED)) {
        if (typeof url === "string" && url.startsWith("http")) {
          recentlyUsedUrls.add(url);
        }
      }
      trimRecentlyUsed();
    }

    if (Array.isArray(parsed.apiCallTimestamps)) {
      apiCallTimestamps = parsed.apiCallTimestamps;
      pruneApiCallTimestamps(now);
    }

    if (typeof parsed.rateLimitCooldownUntil === "number" && parsed.rateLimitCooldownUntil > now) {
      rateLimitCooldownUntil = Math.min(parsed.rateLimitCooldownUntil, now + MAX_COOLDOWN_MS);
    }
  } catch (error) {
    console.warn(
      "[GIPHY CACHE WARNING] Failed to load disk GIF cache, continuing in memory:",
      sanitizeMessage(error.message || String(error)),
    );
  }
}

function persistCache() {
  if (!diskPersistenceEnabled) {
    return;
  }

  const filePath = getCacheFilePath();
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const now = Date.now();

  try {
    fs.mkdirSync(dir, { recursive: true });

    const serializedQueries = {};
    for (const [q, entry] of queryCache.entries()) {
      if (entry && now - entry.cachedAt <= STALE_CACHE_TTL_MS && entry.items.length > 0) {
        serializedQueries[q] = entry;
      }
    }

    const payload = {
      version: CACHE_SCHEMA_VERSION,
      updatedAt: new Date(now).toISOString(),
      rateLimitCooldownUntil: rateLimitCooldownUntil > now ? rateLimitCooldownUntil : 0,
      apiCallTimestamps: pruneApiCallTimestamps(now),
      recentlyUsedUrls: Array.from(recentlyUsedUrls).slice(-MAX_RECENTLY_USED),
      queries: serializedQueries,
    };

    fs.writeFileSync(tempPath, JSON.stringify(payload), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {}
    console.warn(
      "[GIPHY CACHE WARNING] Failed to save disk GIF cache:",
      sanitizeMessage(error.message || String(error)),
    );
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTermRegex(term) {
  const normalized = term.toLowerCase().trim();
  let regex = termRegexCache.get(normalized);
  if (!regex) {
    regex = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalized)}(?:$|[^a-z0-9])`, "i");
    termRegexCache.set(normalized, regex);
  }
  return regex;
}

function matchesTerm(combinedText, term) {
  if (!combinedText || !term) {
    return false;
  }
  return getTermRegex(term).test(combinedText);
}

function getRandomItem(array) {
  if (!Array.isArray(array) || array.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * array.length);
  return array[index];
}

function buildCombinedText(item) {
  const title = (item.title || "").toLowerCase();
  const slug = (item.slug || "").toLowerCase();
  const username = (item.username || "").toLowerCase();
  const id = (item.id || "").toLowerCase();
  return `${title} ${slug} ${username} ${id}`;
}

function isItemRelevant(combinedText, queryConfig = {}, excludeTerms = []) {
  if (!combinedText || typeof combinedText !== "string") {
    return false;
  }

  const blockedTerms = gifKeywords.blockedTerms || [];
  for (const blocked of blockedTerms) {
    if (matchesTerm(combinedText, blocked)) {
      return false;
    }
  }

  for (const excluded of excludeTerms) {
    if (matchesTerm(combinedText, excluded)) {
      return false;
    }
  }

  if (
    Array.isArray(queryConfig.requiredTerms) &&
    queryConfig.requiredTerms.length > 0
  ) {
    const hasMatch = queryConfig.requiredTerms.some((term) =>
      matchesTerm(combinedText, term),
    );
    if (!hasMatch) {
      return false;
    }
  }

  return true;
}

function isRelevantCartoonGif(item, queryConfig = {}, excludeTerms = []) {
  if (!item || typeof item !== "object") {
    return false;
  }
  return isItemRelevant(buildCombinedText(item), queryConfig, excludeTerms);
}

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

function countKeywordMatches(lowerMessage, keywords = []) {
  let count = 0;
  for (const kw of keywords) {
    if (lowerMessage.includes(kw.toLowerCase())) {
      count += 1;
    }
  }
  return count;
}

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
  const excludeTerms =
    (gifKeywords.categoryExcludeTerms &&
      gifKeywords.categoryExcludeTerms[category]) ||
    [];
  const basePreferTerms =
    (gifKeywords.categoryPreferTerms &&
      gifKeywords.categoryPreferTerms[category]) ||
    [];

  const categoryRules =
    (gifKeywords.intentRules && gifKeywords.intentRules[category]) || [];

  let matchedRule = null;
  if (lowerMessage && categoryRules.length > 0) {
    for (const rule of categoryRules) {
      const hasExcludedPhrase =
        Array.isArray(rule.unlessKeywords) &&
        rule.unlessKeywords.length > 0 &&
        countKeywordMatches(lowerMessage, rule.unlessKeywords) > 0;
      if (!hasExcludedPhrase && countKeywordMatches(lowerMessage, rule.keywords) > 0) {
        matchedRule = rule;
        break;
      }
    }
  }

  if (matchedRule) {
    const ruleExcludeTerms = Array.isArray(matchedRule.excludeTerms)
      ? [...excludeTerms, ...matchedRule.excludeTerms]
      : excludeTerms;

    return {
      intentName: matchedRule.name,
      primary: matchedRule.queries || baseQueries,
      fallback: baseQueries,
      fallbackUrls:
        Array.isArray(matchedRule.fallbacks) && matchedRule.fallbacks.length > 0
          ? matchedRule.fallbacks
          : baseFallbacks,
      preferTerms:
        Array.isArray(matchedRule.preferTerms) && matchedRule.preferTerms.length > 0
          ? matchedRule.preferTerms
          : basePreferTerms,
      excludeTerms: ruleExcludeTerms,
    };
  }

  return {
    intentName: category,
    primary: baseQueries,
    fallback: [],
    fallbackUrls: baseFallbacks,
    preferTerms: basePreferTerms,
    excludeTerms,
  };
}

function parseRetryAfterMs(response) {
  const headerVal = response?.headers?.get?.("retry-after");
  if (!headerVal) {
    return RATE_LIMIT_COOLDOWN_MS;
  }

  const numericSeconds = Number(headerVal);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return Math.min(Math.max(numericSeconds * 1000, RATE_LIMIT_COOLDOWN_MS), MAX_COOLDOWN_MS);
  }

  const retryDateMs = Date.parse(headerVal);
  if (Number.isFinite(retryDateMs)) {
    const delta = retryDateMs - Date.now();
    if (delta > 0) {
      return Math.min(Math.max(delta, RATE_LIMIT_COOLDOWN_MS), MAX_COOLDOWN_MS);
    }
  }

  return RATE_LIMIT_COOLDOWN_MS;
}

function logCooldownOnce(message) {
  const now = Date.now();
  if (now - lastCooldownNoticeAt >= COOLDOWN_LOG_THROTTLE_MS) {
    lastCooldownNoticeAt = now;
    console.warn(message);
  }
}

async function fetchRawItemsFromGiphy(queryString, options = {}) {
  const useCache = options.useCache !== false;
  const apiKey = process.env.GIPHY_API_KEY;

  if (!apiKey || apiKey.trim() === "" || apiKey === "YOUR_GIPHY_API_KEY") {
    return { items: [], rateLimited: false, skipped: true };
  }

  const now = Date.now();

  if (useCache) {
    ensureCacheLoaded();

    if (now < rateLimitCooldownUntil) {
      const remainingMin = Math.ceil((rateLimitCooldownUntil - now) / 60000);
      logCooldownOnce(
        `[GIPHY COOLDOWN] Skipping live request (${remainingMin}m cooldown active). Serving cached/fallback GIFs.`,
      );
      return { items: [], rateLimited: true, skipped: true };
    }

    const recentCalls = pruneApiCallTimestamps(now);
    if (recentCalls.length >= MAX_API_CALLS_PER_HOUR) {
      const oldestCall = recentCalls[0];
      rateLimitCooldownUntil = Math.min(oldestCall + HOUR_WINDOW_MS, now + MAX_COOLDOWN_MS);
      persistCache();
      logCooldownOnce(
        `[GIPHY QUOTA GUARD] Reached local cap (${MAX_API_CALLS_PER_HOUR} calls/hr). Serving cached/fallback GIFs cleanly.`,
      );
      return { items: [], rateLimited: true, skipped: true };
    }

    if (inFlightRequests.has(queryString)) {
      return inFlightRequests.get(queryString);
    }
  }

  const runFetch = async () => {
    const rating = gifKeywords.defaultRating || "g";
    const limit = gifKeywords.limit || 20;

    const endpoint = new URL("https://api.giphy.com/v1/gifs/search");
    endpoint.searchParams.set("api_key", apiKey);
    endpoint.searchParams.set("q", queryString);
    endpoint.searchParams.set("limit", limit.toString());
    endpoint.searchParams.set("rating", rating);
    endpoint.searchParams.set("lang", "en");

    const callTime = Date.now();
    if (useCache) {
      apiCallTimestamps.push(callTime);
      pruneApiCallTimestamps(callTime);
    }

    try {
      const response = await fetch(endpoint.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
        },
      });

      if (response.status === 429) {
        const cooldownMs = parseRetryAfterMs(response);
        if (useCache) {
          rateLimitCooldownUntil = Date.now() + cooldownMs;
          persistCache();
        }
        console.warn(
          `[GIPHY WARNING] Rate limit (429) reached for query "${queryString}". Cooling down ${Math.round(cooldownMs / 60000)}m and using cached/fallback GIF.`,
        );
        return { items: [], rateLimited: true };
      }

      if (response.status === 401 || response.status === 403) {
        console.warn(
          `[GIPHY WARNING] GIPHY API responded with status ${response.status} for query "${queryString}".`,
        );
        if (useCache) {
          rateLimitCooldownUntil = Date.now() + AUTH_ERROR_COOLDOWN_MS;
          persistCache();
        }
        return { items: [], rateLimited: true };
      }

      if (!response.ok) {
        console.warn(
          `[GIPHY WARNING] GIPHY API responded with status ${response.status} for query "${queryString}".`,
        );
        if (useCache) persistCache();
        return { items: [], rateLimited: false };
      }

      const payload = await response.json();

      if (!payload.data || !Array.isArray(payload.data)) {
        if (useCache) persistCache();
        return { items: [], rateLimited: false };
      }

      const items = [];
      for (const item of payload.data) {
        const url = extractValidGifUrl(item);
        if (!url) continue;
        items.push({
          url,
          combinedText: buildCombinedText(item),
        });
      }

      return { items, rateLimited: false };
    } catch (error) {
      const safeError = sanitizeMessage(error.message || String(error));
      console.warn(
        `[GIPHY WARNING] Failed to retrieve GIF for query "${queryString}": ${safeError}`,
      );
      if (useCache) persistCache();
      return { items: [], rateLimited: false };
    }
  };

  if (!useCache) {
    return runFetch();
  }

  const promise = runFetch().finally(() => {
    inFlightRequests.delete(queryString);
  });
  inFlightRequests.set(queryString, promise);
  return promise;
}

async function fetchGifsFromGiphy(queryConfig, excludeTerms = [], options = {}) {
  const useCache = options.useCache !== false;
  const now = Date.now();

  if (useCache) {
    ensureCacheLoaded();
    const cached = queryCache.get(queryConfig.q);
    if (cached && now - cached.cachedAt <= CACHE_TTL_MS && cached.items.length > 0) {
      const urls = cached.items
        .filter((entry) => isItemRelevant(entry.combinedText, queryConfig, excludeTerms))
        .map((entry) => entry.url);
      return { urls, rateLimited: false };
    }
  }

  const { items, rateLimited } = await fetchRawItemsFromGiphy(queryConfig.q, { useCache });

  if (items.length > 0) {
    if (useCache) {
      queryCache.set(queryConfig.q, { items, cachedAt: now });
      persistCache();
    }
    const urls = items
      .filter((entry) => isItemRelevant(entry.combinedText, queryConfig, excludeTerms))
      .map((entry) => entry.url);
    return { urls, rateLimited };
  }

  if (useCache) {
    const stale = queryCache.get(queryConfig.q);
    if (stale && now - stale.cachedAt <= STALE_CACHE_TTL_MS && stale.items.length > 0) {
      const urls = stale.items
        .filter((entry) => isItemRelevant(entry.combinedText, queryConfig, excludeTerms))
        .map((entry) => entry.url);
      return { urls, rateLimited };
    }
  }

  return { urls: [], rateLimited };
}

function filterAndScoreItems(items, queryConfig, profile) {
  const { excludeTerms = [], preferTerms = [] } = profile;

  const valid = items.filter((entry) =>
    isItemRelevant(entry.combinedText, queryConfig, excludeTerms),
  );

  if (valid.length === 0) {
    return [];
  }

  if (preferTerms.length === 0) {
    return valid.map((entry) => entry.url);
  }

  const scored = valid.map((entry) => {
    let score = 0;
    for (const term of preferTerms) {
      if (matchesTerm(entry.combinedText, term)) {
        score += 1;
      }
    }
    return { url: entry.url, score };
  });

  const maxScore = Math.max(...scored.map((s) => s.score));
  if (maxScore === 0) {
    return scored.map((s) => s.url);
  }

  const topTier = scored.filter((s) => s.score === maxScore);
  const selectedPool =
    topTier.length >= 2 || maxScore <= 1
      ? topTier
      : scored.filter((s) => s.score >= maxScore - 1);

  return selectedPool.map((s) => s.url);
}

function pickUniqueUrl(urlPool, options = {}) {
  if (!Array.isArray(urlPool) || urlPool.length === 0) {
    return null;
  }

  const unused = urlPool.filter((url) => !recentlyUsedUrls.has(url));
  const pool = unused.length > 0 ? unused : urlPool;
  const selected = getRandomItem(pool);

  if (selected) {
    recentlyUsedUrls.add(selected);
    trimRecentlyUsed();
    if (options.persist !== false) {
      persistCache();
    }
  }

  return selected;
}

function collectCachedPools(queryList, profile, maxAgeMs, now = Date.now()) {
  const poolsWithUnused = [];
  const poolsAnyValid = [];

  for (const qObj of queryList) {
    const cached = queryCache.get(qObj.q);
    if (!cached || now - cached.cachedAt > maxAgeMs || cached.items.length === 0) {
      continue;
    }
    const urls = filterAndScoreItems(cached.items, qObj, profile);
    if (urls.length === 0) continue;

    poolsAnyValid.push(urls);
    const unused = urls.filter((url) => !recentlyUsedUrls.has(url));
    if (unused.length > 0) {
      poolsWithUnused.push(unused);
    }
  }

  return { poolsWithUnused, poolsAnyValid };
}

async function getCategoryGif(
  category,
  messageText = "",
  options = { allowFallback: true },
) {
  const allowFallback = options.allowFallback !== false;
  const useCache = options.useCache !== false;

  try {
    if (useCache) {
      ensureCacheLoaded();
    }

    const now = Date.now();
    const profile = resolveQueryPool(category, messageText);
    const { primary, fallback, fallbackUrls } = profile;

    if (useCache && primary.length > 0) {
      const { poolsWithUnused } = collectCachedPools(primary, profile, CACHE_TTL_MS, now);
      if (poolsWithUnused.length > 0) {
        const chosenUnusedPool = getRandomItem(poolsWithUnused);
        return pickUniqueUrl(chosenUnusedPool, { persist: true });
      }
    }

    const refreshPool = useCache
      ? primary.filter((qObj) => {
          const cached = queryCache.get(qObj.q);
          return !cached || now - cached.cachedAt > CACHE_TTL_MS;
        })
      : primary;

    const queryToFetch = getRandomItem(refreshPool);
    if (queryToFetch) {
      const { items } = await fetchRawItemsFromGiphy(queryToFetch.q, { useCache });
      if (items.length > 0) {
        if (useCache) {
          queryCache.set(queryToFetch.q, { items, cachedAt: Date.now() });
          persistCache();
        }
        const liveUrls = filterAndScoreItems(items, queryToFetch, profile);
        if (liveUrls.length > 0) {
          return pickUniqueUrl(liveUrls, { persist: useCache });
        }
      }
    }

    if (useCache) {
      const primaryCached = collectCachedPools(primary, profile, STALE_CACHE_TTL_MS, now);
      if (primaryCached.poolsWithUnused.length > 0) {
        return pickUniqueUrl(getRandomItem(primaryCached.poolsWithUnused), { persist: true });
      }
      if (primaryCached.poolsAnyValid.length > 0) {
        return pickUniqueUrl(getRandomItem(primaryCached.poolsAnyValid), { persist: true });
      }

      if (fallback.length > 0) {
        const fallbackCached = collectCachedPools(fallback, profile, STALE_CACHE_TTL_MS, now);
        if (fallbackCached.poolsWithUnused.length > 0) {
          return pickUniqueUrl(getRandomItem(fallbackCached.poolsWithUnused), { persist: true });
        }
        if (fallbackCached.poolsAnyValid.length > 0) {
          return pickUniqueUrl(getRandomItem(fallbackCached.poolsAnyValid), { persist: true });
        }
      }
    }

    if (allowFallback && fallbackUrls.length > 0) {
      return pickUniqueUrl(fallbackUrls, { persist: useCache });
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

function getGifCacheStats() {
  ensureCacheLoaded();
  const now = Date.now();
  const callsLastHour = pruneApiCallTimestamps(now).length;
  return {
    cachedQueries: queryCache.size,
    recentlyUsedCount: recentlyUsedUrls.size,
    apiCallsLastHour: callsLastHour,
    maxApiCallsPerHour: MAX_API_CALLS_PER_HOUR,
    cooldownRemainingMs: rateLimitCooldownUntil > now ? rateLimitCooldownUntil - now : 0,
  };
}

function clearGifCache(options = {}) {
  queryCache.clear();
  recentlyUsedUrls.clear();
  apiCallTimestamps = [];
  rateLimitCooldownUntil = 0;
  lastCooldownNoticeAt = 0;

  if (typeof options.persistenceEnabled === "boolean") {
    diskPersistenceEnabled = options.persistenceEnabled;
  }

  diskLoaded = true;

  if (options.clearDisk === true) {
    const filePath = getCacheFilePath();
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn(
        "[GIPHY CACHE WARNING] Failed to remove disk GIF cache:",
        sanitizeMessage(error.message || String(error)),
      );
    }
  }
}

module.exports = {
  getCategoryGif,
  fetchGifsFromGiphy,
  resolveQueryPool,
  isRelevantCartoonGif,
  clearGifCache,
  getGifCacheStats,
};
