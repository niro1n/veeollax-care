const { DELIVERY_MODES, delivery: defaultDeliveryConfig } = require("../config/delivery");

const VALID_MODES = new Set(Object.values(DELIVERY_MODES));

function normalizeDeliveryMode(mode) {
  const normalized = typeof mode === "string" ? mode.trim().toUpperCase() : "";

  if (!VALID_MODES.has(normalized)) {
    throw new Error(
      `Invalid delivery mode "${mode}". Expected one of: ${Array.from(VALID_MODES).join(", ")}.`,
    );
  }

  return normalized;
}

function formatDeliveryError(error) {
  if (!error) {
    return "Unknown delivery error";
  }

  const message = error.message || String(error);

  if (error.code !== undefined && error.code !== null) {
    return `${message} (code: ${error.code})`;
  }

  return message;
}

function buildDmPayload(embed) {
  return {
    embeds: [embed],
  };
}

function buildChannelPayload(embed, targetUserId) {
  return {
    content: `<@${targetUserId}>`,
    embeds: [embed],
    allowedMentions: {
      users: [targetUserId],
    },
  };
}

async function sendToDM({ targetUser, embed }) {
  if (!targetUser || typeof targetUser.send !== "function") {
    throw new Error("Target user is not available for DM delivery.");
  }

  const sentMessage = await targetUser.send(buildDmPayload(embed));

  return {
    messageId: sentMessage?.id || null,
    target: targetUser.tag || targetUser.username || targetUser.id || "target-user",
  };
}

async function sendToChannel({ channel, targetUserId, embed }) {
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Target channel is not available for channel delivery.");
  }

  if (!targetUserId) {
    throw new Error("Target user ID is required for channel mention.");
  }

  const sentMessage = await channel.send(buildChannelPayload(embed, targetUserId));

  return {
    messageId: sentMessage?.id || null,
    channelName: channel.name || channel.id || "channel",
  };
}

function applyDestinationResult(targetSummary, settledResult, fallbackUsed = false) {
  targetSummary.attempted = true;
  if ("fallbackUsed" in targetSummary) {
    targetSummary.fallbackUsed = fallbackUsed;
  }

  if (settledResult.status === "fulfilled") {
    targetSummary.sent = true;
    targetSummary.status = "sent";
    targetSummary.messageId = settledResult.value?.messageId || null;
    targetSummary.error = null;
    return;
  }

  targetSummary.sent = false;
  targetSummary.status = "failed";
  targetSummary.messageId = null;
  targetSummary.error = formatDeliveryError(settledResult.reason);
}

function resolveOverallStatus(summary) {
  if (summary.deliveredCount === 0) {
    return "failed";
  }

  if (summary.mode === DELIVERY_MODES.BOTH) {
    return summary.dm.sent && summary.channel.sent ? "success" : "partial";
  }

  if (summary.mode === DELIVERY_MODES.DM) {
    return summary.dm.sent ? "success" : "partial";
  }

  return summary.channel.sent ? "success" : "failed";
}

function logDeliveryOutcome(logger, summary, channel) {
  const label = summary.label;
  const channelLabel = channel?.name ? `#${channel.name}` : "channel";

  if (summary.dm.attempted && !summary.dm.sent) {
    logger.warn(`[DELIVERY WARN] ${label} | DM failed: ${summary.dm.error}`);
  }

  if (summary.channel.attempted && !summary.channel.sent) {
    logger.warn(
      `[DELIVERY WARN] ${label} | Channel (${channelLabel}) failed: ${summary.channel.error}`,
    );
  }

  const dmLabel = summary.dm.status.toUpperCase();
  const channelStatusText = summary.channel.fallbackUsed
    ? `${summary.channel.status.toUpperCase()} (fallback)`
    : summary.channel.status.toUpperCase();
  const summaryLine = `[DELIVERY] ${label} | mode=${summary.mode} | DM=${dmLabel} | Channel=${channelStatusText} (${channelLabel}) | status=${summary.overallStatus.toUpperCase()}`;

  if (summary.overallStatus === "failed") {
    logger.error(summaryLine);
  } else {
    logger.log(summaryLine);
  }
}

async function deliverReminder(
  { channel, member, targetUser, targetUserId, embed, category, label },
  options = {},
) {
  if (!embed) {
    throw new Error("Reminder embed is required for delivery.");
  }

  const rawDeliveryConfig = options.deliveryConfig || defaultDeliveryConfig;
  const mode = normalizeDeliveryMode(rawDeliveryConfig.mode);
  const fallbackToChannel = Boolean(rawDeliveryConfig.fallbackToChannel);
  const logger = options.logger || console;

  const resolvedUser = targetUser || member?.user || member || null;
  const resolvedUserId = targetUserId || resolvedUser?.id || member?.id || null;

  const summary = {
    mode,
    fallbackToChannel,
    category: category || null,
    label: label || category || "Reminder",
    dm: {
      targeted: false,
      attempted: false,
      sent: false,
      status: "skipped",
      messageId: null,
      error: null,
    },
    channel: {
      targeted: false,
      attempted: false,
      sent: false,
      fallbackUsed: false,
      status: "skipped",
      messageId: null,
      error: null,
    },
    fallbackTriggered: false,
    deliveredCount: 0,
    overallStatus: "failed",
  };

  if (mode === DELIVERY_MODES.BOTH) {
    summary.dm.targeted = true;
    summary.channel.targeted = true;

    const [dmResult, channelResult] = await Promise.allSettled([
      sendToDM({ targetUser: resolvedUser, embed }),
      sendToChannel({ channel, targetUserId: resolvedUserId, embed }),
    ]);

    applyDestinationResult(summary.dm, dmResult);
    applyDestinationResult(summary.channel, channelResult, false);
  } else if (mode === DELIVERY_MODES.DM) {
    summary.dm.targeted = true;

    const [dmResult] = await Promise.allSettled([
      sendToDM({ targetUser: resolvedUser, embed }),
    ]);

    applyDestinationResult(summary.dm, dmResult);

    if (!summary.dm.sent && fallbackToChannel && !summary.channel.attempted) {
      summary.fallbackTriggered = true;
      summary.channel.targeted = true;

      const channelName = channel?.name ? `#${channel.name}` : "channel";
      logger.warn(
        `[DELIVERY FALLBACK] ${summary.label} | DM unavailable, falling back to ${channelName}...`,
      );

      const [fallbackResult] = await Promise.allSettled([
        sendToChannel({ channel, targetUserId: resolvedUserId, embed }),
      ]);

      applyDestinationResult(summary.channel, fallbackResult, true);
    }
  } else if (mode === DELIVERY_MODES.CHANNEL) {
    summary.channel.targeted = true;

    const [channelResult] = await Promise.allSettled([
      sendToChannel({ channel, targetUserId: resolvedUserId, embed }),
    ]);

    applyDestinationResult(summary.channel, channelResult, false);
  }

  summary.deliveredCount = (summary.dm.sent ? 1 : 0) + (summary.channel.sent ? 1 : 0);
  summary.overallStatus = resolveOverallStatus(summary);

  logDeliveryOutcome(logger, summary, channel);

  if (summary.overallStatus === "failed") {
    const failureDetails = [
      summary.dm.attempted ? `DM: ${summary.dm.error}` : null,
      summary.channel.attempted ? `Channel: ${summary.channel.error}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const error = new Error(
      `Reminder delivery failed for all destinations (${failureDetails || "no destinations attempted"}).`,
    );
    error.deliverySummary = summary;
    throw error;
  }

  return summary;
}

module.exports = {
  DELIVERY_MODES,
  normalizeDeliveryMode,
  buildDmPayload,
  buildChannelPayload,
  deliverReminder,
};
