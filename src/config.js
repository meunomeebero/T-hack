const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const GAME_ROUNDS = 10;
const ROUND_TIME_LIMIT_MS = 60000;
const PAGE_TRANSITION_GRACE_MS = 7000;
const DISCONNECT_FORFEIT_MS = 4000;
const CLEANUP_DELAY_MS = 15000;

module.exports = {
  CLEANUP_DELAY_MS,
  DISCONNECT_FORFEIT_MS,
  GAME_ROUNDS,
  PAGE_TRANSITION_GRACE_MS,
  PORT,
  PUBLIC_DIR,
  ROUND_TIME_LIMIT_MS
};
