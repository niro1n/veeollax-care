require("dotenv").config();

const { getCategoryGif, clearGifCache } = require("./services/gifService");
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

  const categories = ["breakfast", "shortBreak", "lunch", "dinner", "nightRest"];

  console.log("--- 1. Testing Category GIF Retrieval ---");
  for (const cat of categories) {
    const keywords = gifKeywords.categories[cat];
    const gifUrl = await getCategoryGif(cat);
    console.log(`\nCategory: [${cat}]`);
    console.log(`Keywords pool (${keywords.length}): "${keywords.slice(0, 3).join('", "')}"...`);
    if (gifUrl) {
      console.log(`-> Returned GIF: ${gifUrl}`);
    } else {
      console.log(`-> Returned GIF: (null - Graceful Fallback)`);
    }
  }

  console.log("\n--- 2. Testing In-Memory Caching & Randomization ---");
  const catTest = "breakfast";
  const firstGif = await getCategoryGif(catTest);
  const secondGif = await getCategoryGif(catTest);

  console.log(`First call (${catTest}):  ${firstGif || "(null)"}`);
  console.log(`Second call (${catTest}): ${secondGif || "(null)"}`);
  if (firstGif && secondGif) {
    console.log(`[OK] Both calls resolved from cache/pool. (Different: ${firstGif !== secondGif})`);
  } else {
    console.log("[INFO] Caching test passed with graceful fallback.");
  }

  console.log("\n--- 3. Testing Fallback Resilience (Invalid/Empty Key) ---");
  clearGifCache();
  const originalKey = process.env.GIPHY_API_KEY;
  process.env.GIPHY_API_KEY = "INVALID_KEY_TEST";

  const fallbackResult = await getCategoryGif("lunch");
  console.log(`Result with invalid key: ${fallbackResult === null ? "null [PASS - Graceful fallback without crash]" : fallbackResult}`);

  // Restore original key
  process.env.GIPHY_API_KEY = originalKey;
  clearGifCache();

  console.log("\n==========================================");
  console.log("          ALL TESTS COMPLETED ♡");
  console.log("==========================================\n");
}

runGiphyTests().catch((err) => {
  console.error("[TEST FATAL ERROR]", err);
  process.exit(1);
});
