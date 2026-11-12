const assert = require("node:assert/strict");
const path = require("node:path");
const { EmbedBuilder } = require("discord.js");

const { DELIVERY_MODES, delivery: productionDeliveryConfig } = require("./config/delivery");
const { deliverReminder } = require("./services/deliveryService");

function createSilentLogger() {
  const entries = { log: [], warn: [], error: [] };
  return {
    entries,
    log: (msg) => entries.log.push(msg),
    warn: (msg) => entries.warn.push(msg),
    error: (msg) => entries.error.push(msg),
  };
}

function createSampleEmbed() {
  return new EmbedBuilder()
    .setColor("#C8A2E8")
    .setDescription("pagi! jangan lupa sarapan yaa ♡")
    .setFooter({
      text: "a little care, every day. ♡ • niro | Powered by GIPHY",
    })
    .setImage("https://media.giphy.com/media/sample/giphy.gif")
    .setTimestamp();
}

function createMockTargets({ dmError = null, channelError = null } = {}) {
  const dmCalls = [];
  const channelCalls = [];

  const targetUser = {
    id: "999000111222333444",
    tag: "specialone#0001",
    async send(payload) {
      dmCalls.push(payload);
      if (dmError) throw dmError;
      return { id: `dm-msg-${dmCalls.length}` };
    },
  };

  const member = {
    id: targetUser.id,
    displayName: "Special",
    user: targetUser,
  };

  const channel = {
    id: "888000111222333444",
    name: "✨〢little-reminder",
    async send(payload) {
      channelCalls.push(payload);
      if (channelError) throw channelError;
      return { id: `ch-msg-${channelCalls.length}` };
    },
  };

  return { member, targetUser, channel, dmCalls, channelCalls };
}

async function runDeliveryTests() {
  console.log("==========================================");
  console.log("     VEEOLLAX DELIVERY SERVICE TESTS");
  console.log("==========================================\n");

  // 1. Production config defaults
  assert.equal(productionDeliveryConfig.mode, DELIVERY_MODES.BOTH);
  assert.equal(productionDeliveryConfig.fallbackToChannel, true);
  console.log("[PASS] 1. Default production config is BOTH + fallbackToChannel=true");

  // 2. Mode BOTH - both succeed
  {
    const { member, channel, dmCalls, channelCalls } = createMockTargets();
    const embed = createSampleEmbed();
    const logger = createSilentLogger();

    const summary = await deliverReminder(
      { channel, member, embed, category: "breakfast", label: "Breakfast" },
      { deliveryConfig: { mode: "BOTH", fallbackToChannel: true }, logger },
    );

    assert.equal(dmCalls.length, 1);
    assert.equal(channelCalls.length, 1);
    assert.equal(dmCalls[0].content, undefined, "DM must NOT include mention content");
    assert.equal(dmCalls[0].embeds.length, 1);
    assert.equal(channelCalls[0].content, `<@${member.id}>`);
    assert.deepEqual(channelCalls[0].allowedMentions, { users: [member.id] });
    assert.equal(channelCalls[0].embeds.length, 1);
    assert.equal(summary.overallStatus, "success");
    assert.equal(summary.deliveredCount, 2);
    assert.equal(summary.fallbackTriggered, false);
    console.log("[PASS] 2. Mode BOTH sends DM (no mention) + Channel (with mention & allowedMentions)");
  }

  // 3. Mode BOTH - DM fails, Channel succeeds (must NOT double-send Channel)
  {
    const dmErr = Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
    const { member, channel, dmCalls, channelCalls } = createMockTargets({ dmError: dmErr });
    const logger = createSilentLogger();

    const summary = await deliverReminder(
      { channel, member, embed: createSampleEmbed(), category: "lunch", label: "Lunch" },
      { deliveryConfig: { mode: "BOTH", fallbackToChannel: true }, logger },
    );

    assert.equal(dmCalls.length, 1);
    assert.equal(channelCalls.length, 1, "Channel must NOT be sent twice when DM fails in BOTH mode");
    assert.equal(summary.dm.sent, false);
    assert.match(summary.dm.error, /50007/);
    assert.equal(summary.channel.sent, true);
    assert.equal(summary.channel.fallbackUsed, false);
    assert.equal(summary.fallbackTriggered, false);
    assert.equal(summary.overallStatus, "partial");
    assert.equal(summary.deliveredCount, 1);
    assert.ok(logger.entries.warn.some((line) => line.includes("DM failed")));
    console.log("[PASS] 3. Mode BOTH handles DM failure independently without double-sending channel");
  }

  // 4. Mode BOTH - DM succeeds, Channel fails
  {
    const chErr = Object.assign(new Error("Missing Permissions"), { code: 50013 });
    const { member, channel, dmCalls, channelCalls } = createMockTargets({ channelError: chErr });
    const logger = createSilentLogger();

    const summary = await deliverReminder(
      { channel, member, embed: createSampleEmbed(), category: "dinner", label: "Dinner" },
      { deliveryConfig: { mode: "BOTH", fallbackToChannel: true }, logger },
    );

    assert.equal(dmCalls.length, 1);
    assert.equal(channelCalls.length, 1);
    assert.equal(summary.dm.sent, true);
    assert.equal(summary.channel.sent, false);
    assert.match(summary.channel.error, /50013/);
    assert.equal(summary.overallStatus, "partial");
    assert.equal(summary.deliveredCount, 1);
    console.log("[PASS] 4. Mode BOTH handles Channel failure independently without blocking DM");
  }

  // 5. Mode BOTH - both fail
  {
    const { member, channel } = createMockTargets({
      dmError: new Error("DM blocked"),
      channelError: new Error("Channel missing"),
    });
    const logger = createSilentLogger();

    await assert.rejects(
      () =>
        deliverReminder(
          { channel, member, embed: createSampleEmbed(), category: "nightRest", label: "Night Rest" },
          { deliveryConfig: { mode: "BOTH", fallbackToChannel: true }, logger },
        ),
      (error) => {
        assert.equal(error.deliverySummary.overallStatus, "failed");
        assert.equal(error.deliverySummary.deliveredCount, 0);
        return true;
      },
    );
    console.log("[PASS] 5. Mode BOTH throws when both DM and Channel fail");
  }

  // 6. Mode DM - DM succeeds (no channel send)
  {
    const { member, channel, dmCalls, channelCalls } = createMockTargets();
    const logger = createSilentLogger();

    const summary = await deliverReminder(
      { channel, member, embed: createSampleEmbed(), category: "shortBreak", label: "Morning Break" },
      { deliveryConfig: { mode: "DM", fallbackToChannel: true }, logger },
    );

    assert.equal(dmCalls.length, 1);
    assert.equal(channelCalls.length, 0);
    assert.equal(summary.dm.sent, true);
    assert.equal(summary.channel.status, "skipped");
    assert.equal(summary.overallStatus, "success");
    console.log("[PASS] 6. Mode DM sends only to DM when DM succeeds");
  }

  // 7. Mode DM - DM fails with fallbackToChannel=true
  {
    const { member, channel, dmCalls, channelCalls } = createMockTargets({
      dmError: Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }),
    });
    const logger = createSilentLogger();

    const summary = await deliverReminder(
      { channel, member, embed: createSampleEmbed(), category: "breakfast", label: "Breakfast" },
      { deliveryConfig: { mode: "DM", fallbackToChannel: true }, logger },
    );

    assert.equal(dmCalls.length, 1);
    assert.equal(channelCalls.length, 1);
    assert.equal(summary.dm.sent, false);
    assert.equal(summary.fallbackTriggered, true);
    assert.equal(summary.channel.fallbackUsed, true);
    assert.equal(summary.channel.sent, true);
    assert.equal(summary.overallStatus, "partial");
    console.log("[PASS] 7. Mode DM falls back to Channel when DM fails and fallbackToChannel=true");
  }

  // 8. Mode DM - DM fails with fallbackToChannel=false
  {
    const { member, channel, dmCalls, channelCalls } = createMockTargets({
      dmError: new Error("DM disabled"),
    });
    const logger = createSilentLogger();

    await assert.rejects(
      () =>
        deliverReminder(
          { channel, member, embed: createSampleEmbed(), category: "breakfast", label: "Breakfast" },
          { deliveryConfig: { mode: "DM", fallbackToChannel: false }, logger },
        ),
      (error) => {
        assert.equal(error.deliverySummary.overallStatus, "failed");
        assert.equal(channelCalls.length, 0);
        assert.equal(dmCalls.length, 1);
        return true;
      },
    );
    console.log("[PASS] 8. Mode DM does not fall back when fallbackToChannel=false");
  }

  // 9. Mode CHANNEL - Channel only
  {
    const { member, channel, dmCalls, channelCalls } = createMockTargets();
    const logger = createSilentLogger();

    const summary = await deliverReminder(
      { channel, member, embed: createSampleEmbed(), category: "lunch", label: "Lunch" },
      { deliveryConfig: { mode: "CHANNEL", fallbackToChannel: true }, logger },
    );

    assert.equal(dmCalls.length, 0);
    assert.equal(channelCalls.length, 1);
    assert.equal(summary.dm.status, "skipped");
    assert.equal(summary.channel.sent, true);
    assert.equal(summary.overallStatus, "success");
    console.log("[PASS] 9. Mode CHANNEL sends only to Channel");
  }

  // 10. Invalid delivery mode rejected
  {
    const { member, channel } = createMockTargets();
    await assert.rejects(
      () =>
        deliverReminder(
          { channel, member, embed: createSampleEmbed() },
          { deliveryConfig: { mode: "EMAIL", fallbackToChannel: true }, logger: createSilentLogger() },
        ),
      /Invalid delivery mode/,
    );
    console.log("[PASS] 10. Invalid delivery mode throws descriptive validation error");
  }

  // 11. Scheduler integration & embed format preservation (isolated without mutating storage)
  {
    const messageEnginePath = path.resolve(__dirname, "services/messageEngine.js");
    const gifServicePath = path.resolve(__dirname, "services/gifService.js");
    const schedulerPath = path.resolve(__dirname, "handlers/scheduler.js");

    const origMsgModule = require.cache[messageEnginePath];
    const origGifModule = require.cache[gifServicePath];
    const origSchedulerModule = require.cache[schedulerPath];

    require.cache[messageEnginePath] = {
      id: messageEnginePath,
      filename: messageEnginePath,
      loaded: true,
      exports: {
        getMessage: () => "mock rotated breakfast reminder ♡",
      },
    };
    require.cache[gifServicePath] = {
      id: gifServicePath,
      filename: gifServicePath,
      loaded: true,
      exports: {
        getCategoryGif: async () => "https://media.giphy.com/media/test/giphy.gif",
      },
    };
    delete require.cache[schedulerPath];

    try {
      const { sendReminder } = require("./handlers/scheduler");
      const { member, channel, dmCalls, channelCalls } = createMockTargets();
      const logger = createSilentLogger();

      const result = await sendReminder(
        { channel, member, category: "breakfast", label: "Breakfast" },
        { logger },
      );

      assert.equal(result.message, "mock rotated breakfast reminder ♡");
      assert.equal(result.gifUrl, "https://media.giphy.com/media/test/giphy.gif");
      assert.equal(result.delivery.mode, "BOTH");
      assert.equal(result.delivery.overallStatus, "success");
      assert.equal(dmCalls.length, 1);
      assert.equal(channelCalls.length, 1);

      const sentEmbedJson = channelCalls[0].embeds[0].toJSON();
      assert.equal(sentEmbedJson.color, 0xc8a2e8);
      assert.equal(sentEmbedJson.description, "mock rotated breakfast reminder ♡");
      assert.equal(sentEmbedJson.footer.text, "a little care, every day. ♡ • niro | Powered by GIPHY");
      assert.equal(sentEmbedJson.image.url, "https://media.giphy.com/media/test/giphy.gif");
      assert.ok(sentEmbedJson.timestamp);
      console.log("[PASS] 11. Scheduler delegates cleanly and preserves embed color (#C8A2E8), footer, GIF, and timestamp");
    } finally {
      delete require.cache[schedulerPath];
      if (origMsgModule) require.cache[messageEnginePath] = origMsgModule;
      else delete require.cache[messageEnginePath];
      if (origGifModule) require.cache[gifServicePath] = origGifModule;
      else delete require.cache[gifServicePath];
      if (origSchedulerModule) require.cache[schedulerPath] = origSchedulerModule;
    }
  }

  console.log("\n==========================================");
  console.log("      ALL DELIVERY TESTS PASSED ♡");
  console.log("==========================================\n");
}

runDeliveryTests().catch((error) => {
  console.error("[TEST FAILED]", error);
  process.exit(1);
});
