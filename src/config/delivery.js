const DELIVERY_MODES = Object.freeze({
  BOTH: "BOTH",
  DM: "DM",
  CHANNEL: "CHANNEL",
});

module.exports = {
  DELIVERY_MODES,
  delivery: {
    mode: DELIVERY_MODES.BOTH,
    fallbackToChannel: true,
  },
};
