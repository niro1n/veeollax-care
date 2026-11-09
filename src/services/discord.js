const { ChannelType } = require("discord.js");
const serverConfig = require("../config/server");

async function validateDiscord(client) {
  console.log("\n[VALIDATION] Checking configuration...");

  const guild = await client.guilds.fetch(serverConfig.guildId);

  if (!guild) {
    throw new Error("Guild not found.");
  }

  console.log(`[OK] Server: ${guild.name}`);

  const channel = await guild.channels.fetch(serverConfig.channelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Invalid reminder channel.");
  }

  console.log(`[OK] Channel: #${channel.name}`);

  const member = await guild.members.fetch(serverConfig.targetUserId);

  if (!member) {
    throw new Error("Target user not found.");
  }

  console.log(`[OK] Target: ${member.user.tag}`);

  return { guild, channel, member };
}

module.exports = { validateDiscord };
