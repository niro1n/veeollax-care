const cron = require("node-cron");
const { EmbedBuilder } = require("discord.js");

const scheduleConfig = require("../config/schedule");
const { delivery: deliveryConfig } = require("../config/delivery");
const { getMessage } = require("../services/messageEngine");
const { getCategoryGif } = require("../services/gifService");
const { deliverReminder } = require("../services/deliveryService");

const breakfast = require("../data/messages/breakfast");
const lunch = require("../data/messages/lunch");
const dinner = require("../data/messages/dinner");
const shortBreak = require("../data/messages/shortBreak");
const nightRest = require("../data/messages/nightRest");

const messageCollections = {
  breakfast,
  lunch,
  dinner,
  shortBreak,
  nightRest,
};

function timeToCron(time) {
  const [hour, minute] = time.split(":").map(Number);

  return `${minute} ${hour} * * *`;
}

function buildReminderEmbed({ message, gifUrl }) {
  const embed = new EmbedBuilder()
    .setColor("#C8A2E8")
    .setDescription(message)
    .setFooter({
      text: "a little care, every day. ♡ • niro | Powered by GIPHY",
    })
    .setTimestamp();

  if (gifUrl) {
    embed.setImage(gifUrl);
  }

  return embed;
}

async function sendReminder({ channel, member, category, label }, options = {}) {
  const messages = messageCollections[category];

  if (!messages || messages.length === 0) {
    throw new Error(`Message collection missing: ${category}`);
  }

  const message = getMessage(category, messages, member.displayName);

  let gifUrl = null;
  try {
    gifUrl = await getCategoryGif(category, message);
  } catch (error) {
    gifUrl = null;
  }

  const embed = buildReminderEmbed({ message, gifUrl });

  const delivery = await deliverReminder(
    {
      channel,
      member,
      targetUser: member.user,
      embed,
      category,
      label: label || category,
    },
    options,
  );

  return { message, gifUrl, delivery };
}

function startScheduler({ channel, member }) {
  const timezone = scheduleConfig.timezone;

  console.log("\n================================");
  console.log("       VEEOLLAX SCHEDULER");
  console.log("================================");

  for (const item of scheduleConfig.schedules) {
    if (!item.enabled) {
      console.log(`[DISABLED] ${item.name}`);
      continue;
    }

    const messages = messageCollections[item.category];

    if (!messages || messages.length === 0) {
      throw new Error(`Message collection missing: ${item.category}`);
    }

    const expression = timeToCron(item.time);

    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${item.name}`);
    }

    cron.schedule(
      expression,
      async () => {
        console.log(`[TRIGGERED] ${item.name} - ${item.time} WIB`);

        try {
          const result = await sendReminder({
            channel,
            member,
            category: item.category,
            label: item.name,
          });

          if (result.delivery.overallStatus === "partial") {
            console.warn(`[PARTIAL] ${item.name} delivered with partial destination failure.`);
          } else {
            console.log(`[SUCCESS] ${item.name} delivered.`);
          }
        } catch (error) {
          console.error(`[FAILED] ${item.name}:`, error);
        }
      },
      {
        timezone,
      },
    );

    console.log(`[REGISTERED] ${item.name} | ${item.time} WIB`);
  }

  console.log("================================");
  console.log("All reminder schedules registered ♡");
  console.log(`Timezone: ${timezone}`);
  console.log(
    `Delivery mode: ${deliveryConfig.mode} (fallback: ${deliveryConfig.fallbackToChannel ? "ON" : "OFF"})`,
  );
  console.log("================================\n");
}

module.exports = { startScheduler, sendReminder, buildReminderEmbed, messageCollections };
