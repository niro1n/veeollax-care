const fs = require("fs");
const path = require("path");

const statePath = path.join(__dirname, "../../storage/messageState.json");
const legacyStatePath = path.join(__dirname, "../data/messageState.json");

function isValidStateObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeStateFile(targetPath, state) {
  const dir = path.dirname(targetPath);
  const tempPath = `${targetPath}.${process.pid}.tmp`;

  fs.mkdirSync(dir, {
    recursive: true,
  });

  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    throw error;
  }
}

function readStateFile(targetPath) {
  const raw = fs.readFileSync(targetPath, "utf8").trim();

  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw);

  if (!isValidStateObject(parsed)) {
    return null;
  }

  return parsed;
}

function loadState() {
  fs.mkdirSync(path.dirname(statePath), {
    recursive: true,
  });

  if (!fs.existsSync(statePath)) {
    if (fs.existsSync(legacyStatePath)) {
      try {
        const legacyState = readStateFile(legacyStatePath);

        if (legacyState !== null) {
          writeStateFile(statePath, legacyState);
          console.log(
            "[STATE] Migrated runtime state from src/data/messageState.json to storage/messageState.json",
          );
          return legacyState;
        }
      } catch (error) {
        console.warn(
          "[STATE WARNING] Failed to migrate legacy messageState.json, initializing fresh state.",
          error.message,
        );
      }
    }

    const initialState = {};
    writeStateFile(statePath, initialState);
    console.log("[STATE] Initialized storage/messageState.json");
    return initialState;
  }

  try {
    const state = readStateFile(statePath);

    if (state !== null) {
      return state;
    }

    console.warn(
      "[STATE WARNING] storage/messageState.json is empty or invalid, resetting to empty object.",
    );
  } catch (error) {
    console.warn(
      "[STATE WARNING] Failed to parse storage/messageState.json, preserving backup and resetting.",
      error.message,
    );

    try {
      const corruptRaw = fs.readFileSync(statePath, "utf8");
      if (corruptRaw.trim()) {
        fs.writeFileSync(`${statePath}.corrupt`, corruptRaw, "utf8");
      }
    } catch (backupError) {
      console.warn(
        "[STATE WARNING] Could not write corrupt state backup:",
        backupError.message,
      );
    }
  }

  const fallbackState = {};
  writeStateFile(statePath, fallbackState);
  return fallbackState;
}

function saveState(state) {
  writeStateFile(statePath, state);
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
