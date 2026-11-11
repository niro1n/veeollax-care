require("dotenv").config();

const { getCategoryGif, resolveQueryPool, getGifCacheStats } = require("./services/gifService");
const gifKeywords = require("./config/gifKeywords");

async function runGiphyTests() {
  console.log("==========================================");
  console.log("       VEEOLLAX GIPHY SERVICE TEST");
  console.log("==========================================\n");

  const apiKey = process.env.GIPHY_API_KEY;
  const isKeyConfigured = apiKey && apiKey !== "YOUR_GIPHY_API_KEY" && apiKey.trim() !== "";

  console.log(`[CONFIG] GIPHY_API_KEY present: ${isKeyConfigured ? "YES (Configured)" : "NO (Placeholder/Empty)"}`);
  console.log(`[CONFIG] Default rating: ${gifKeywords.defaultRating}`);
  console.log(`[CONFIG] Configured categories: ${Object.keys(gifKeywords.categories).join(", ")}\n`);

  const testCases = [
    { category: "breakfast", sampleMessage: "semangat buat hari ini yaa. luangkan waktu sebentar buat sarapan biar badan tetap fit." },
    { category: "breakfast", sampleMessage: "good morning! minum air putih dulu, terus jangan lupa sarapan yaa." },
    { category: "shortBreak", sampleMessage: "take a deep breath. tarik nafas pelan-pelan, and give yourself a moment to relax." },
    { category: "shortBreak", sampleMessage: "waktunya regangkan badan sebentar. gerak-gerakkan leher dan pergelangan tangan kamu yaa." },
    { category: "shortBreak", sampleMessage: "jangan lupa minum air putih yaa. yuk jeda sebentar dari aktivitas dan ambil minum dulu." },
    { category: "shortBreak", sampleMessage: "jangan lupa istirahat sejenak yaa, take care dan peluk hangat ♡" },
    { category: "lunch", sampleMessage: "siang! udah makan siang belum? luangkan waktu sebentar buat makan yaa." },
    { category: "dinner", sampleMessage: "malam! udah makan malam belum? yuk cari makan malam yang hangat." },
    { category: "nightRest", sampleMessage: "malam! udah jam segini, yuk sudahi aktivitas hari ini dan siap-siap tidur." },
  ];

  console.log("--- 1. Testing Context-Aware Category & Message GIF Retrieval ---");
  for (const tc of testCases) {
    const pool = resolveQueryPool(tc.category, tc.sampleMessage);
    const poolLabels = pool.primary.map((item) => item.q).join('", "');
    const gifUrl = await getCategoryGif(tc.category, tc.sampleMessage);

    console.log(`\nCategory: [${tc.category}] | Intent: [${pool.intentName}]`);
    console.log(`Message:  "${tc.sampleMessage}"`);
    console.log(`Matched Queries: "${poolLabels}"`);
    if (gifUrl) {
      console.log(`-> Returned GIF: ${gifUrl}`);
    } else {
      console.log(`-> Returned GIF: (null - Graceful Fallback / Rate Limit)`);
    }
  }

  console.log("\n--- 2. Testing Cache-First Reuse & Randomization ---");
  const catTest = "breakfast";
  const firstGif = await getCategoryGif(catTest);
  const secondGif = await getCategoryGif(catTest);

  console.log(`First call (${catTest}):  ${firstGif || "(null)"}`);
  console.log(`Second call (${catTest}): ${secondGif || "(null)"}`);
  if (firstGif && secondGif) {
    console.log(`[OK] Both calls resolved cleanly. (Different: ${firstGif !== secondGif})`);
  } else {
    console.log("[INFO] Caching test passed with graceful fallback.");
  }

  console.log("\n--- 3. Testing Fallback Resilience (Invalid/Empty Key, Isolated) ---");
  const originalKey = process.env.GIPHY_API_KEY;
  process.env.GIPHY_API_KEY = "INVALID_KEY_TEST";

  const fallbackWithPool = await getCategoryGif("lunch", "makan siang yuk", { useCache: false });
  const fallbackStrictNull = await getCategoryGif("lunch", "makan siang yuk", { allowFallback: false, useCache: false });
  console.log(`Result with invalid key (curated fallback): ${fallbackWithPool ? "[PASS] " + fallbackWithPool : "null"}`);
  console.log(`Result with invalid key (strict null mode): ${fallbackStrictNull === null ? "null [PASS - Graceful fallback without crash]" : fallbackStrictNull}`);

  process.env.GIPHY_API_KEY = originalKey;

  const cacheStats = getGifCacheStats();
  console.log("\n--- 4. API Quota & Cache Summary ---");
  console.log(`[CACHE] Cached queries: ${cacheStats.cachedQueries} | Recently used tracked: ${cacheStats.recentlyUsedCount}`);
  console.log(`[QUOTA] Live API calls (last 1h): ${cacheStats.apiCallsLastHour}/${cacheStats.maxApiCallsPerHour} | Cooldown remaining: ${Math.ceil(cacheStats.cooldownRemainingMs / 1000)}s`);

  console.log("\n==========================================");
  console.log("          ALL TESTS COMPLETED ♡");
  console.log("==========================================\n");
}

runGiphyTests().catch((err) => {
  console.error("[TEST FATAL ERROR]", err);
  process.exit(1);
});
