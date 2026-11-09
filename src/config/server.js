require("dotenv").config();

module.exports = {
  guildId: process.env.GUILD_ID,
  channelId: process.env.CHANNEL_ID,
  targetUserId: process.env.TARGET_USER_ID,
};
