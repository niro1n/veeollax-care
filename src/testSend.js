require("dotenv").config();

const { Client, GatewayIntentBits, Events } = require("discord.js");
const { validateDiscord } = require("./services/discord");
const { sendReminder, messageCollections } = require("./handlers/scheduler");

const categoryArg = process.argv[2] || "breakfast";

if (!messageCollections[categoryArg]) {
  console.error(`\n[ERROR] Kategori "${categoryArg}" tidak valid.`);
  console.log("Pilihan kategori yang tersedia: " + Object.keys(messageCollections).join(", ") + "\n");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async () => {
  try {
    const { channel, member } = await validateDiscord(client);

    console.log(`\n[TEST] Mengirim pesan kategori "${categoryArg}" ke #${channel.name}...`);

    const result = await sendReminder({
      channel,
      member,
      category: categoryArg,
    });

    console.log("\n[SUCCESS] Pesan berhasil dikirim ke Discord!");
    console.log(`Pesan: "${result.message}"`);
    console.log(`GIF: ${result.gifUrl || "(None / Fallback)"}\n`);
  } catch (error) {
    console.error("\n[TEST FAILED]", error);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
