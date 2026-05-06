const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "data", "terminal-hack.sqlite3");

const DEFAULT_RANKINGS = [
  ["hacker1337", 150],
  ["root_admin", 120],
  ["net_runner", 95],
  ["script_kiddie", 80],
  ["cyber_punk", 60]
];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS rankings (
    username TEXT PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const count = db.prepare("SELECT COUNT(*) AS total FROM rankings").get().total;

if (count === 0) {
  const seedRanking = db.prepare(`
    INSERT INTO rankings (username, score)
    VALUES (?, ?)
  `);

  const seed = db.transaction(() => {
    for (const [username, score] of DEFAULT_RANKINGS) {
      seedRanking.run(username, score);
    }
  });

  seed();
}

const topRankings = db.prepare(`
  SELECT username, score
  FROM rankings
  ORDER BY score DESC, updated_at ASC, username ASC
  LIMIT ?
`);

const incrementRanking = db.prepare(`
  INSERT INTO rankings (username, score, updated_at)
  VALUES (?, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(username) DO UPDATE SET
    score = rankings.score + 1,
    updated_at = CURRENT_TIMESTAMP
`);

function getTopRankings(limit = 10) {
  return topRankings.all(limit).map((row, index) => ({
    rank: index + 1,
    username: row.username,
    score: row.score
  }));
}

function addWin(username) {
  incrementRanking.run(username);
}

function closeDatabase() {
  db.close();
}

module.exports = {
  DB_PATH,
  addWin,
  closeDatabase,
  getTopRankings
};
