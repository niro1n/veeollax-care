const fs = require("fs");
const path = require("path");

const statePath = path.join(__dirname, "../data/messageState.json");

function loadState() {
  if (!fs.existsSync(statePath)) {
    fs.mkdirSync(path.dirname(statePath), {
      recursive: true,
    });

    fs.writeFileSync(statePath, "{}");
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function getMessage(category, messages, recipientName) {
  if (!messages || messages.length === 0) {
    throw new Error(`No messages found: ${category}`);
  }

  const state = loadState();

  if (!state[category]) {
    state[category] = {
      queue: [],
      lastMessageId: null,
    };
  }

  const categoryState = state[category];

  if (categoryState.queue.length === 0) {
    categoryState.queue = shuffle(
      messages.filter((message) => message.id !== categoryState.lastMessageId),
    ).map((message) => message.id);
  }

  const selectedId = categoryState.queue.shift();

  const selectedMessage = messages.find((message) => message.id === selectedId);

  if (!selectedMessage) {
    throw new Error("Selected message not found.");
  }

  categoryState.lastMessageId = selectedId;

  let text = selectedMessage.text;

  if (recipientName && selectedMessage.canAddress && Math.random() < 0.25) {
    text = `hey ${recipientName}, ${text}`;
  }

  saveState(state);

  return text;
}

module.exports = { getMessage };
