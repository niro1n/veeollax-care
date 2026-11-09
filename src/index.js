require("dotenv").config();

const { Client, GatewayIntentBits, Events } = require("discord.js");

const botConfig = require("./config/bot");
const { validateDiscord } = require("./services/discord");
const { startScheduler } = require("./handlers/scheduler");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async () => {
  try {
    client.user.setPresence({
      activities: [
        {
          name: botConfig.activity,
          type: 0,
        },
      ],
      status: botConfig.status,
    });

    console.log(`\n${botConfig.name} is online!`);

    const { channel, member } = await validateDiscord(client);

    console.log(`[OK] Connected to #${channel.name}`);

    console.log(`[OK] Reminder target: ${member.displayName}`);

    startScheduler({
      channel,
      member,
    });

    console.log("\n[VEEOLLAX] All systems operational ♡");
  } catch (error) {
    console.error("[VEEOLLAX ERROR]", error);
    client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
