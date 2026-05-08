const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "data", "terminal-hack.sqlite3");
const ADS_DB_PATH = process.env.ADS_SQLITE_PATH || path.join(__dirname, "data", "ads.sqlite3");

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
  adsDb.close();
}

// Ads Database
fs.mkdirSync(path.dirname(ADS_DB_PATH), { recursive: true });
const adsDb = new Database(ADS_DB_PATH);
adsDb.pragma("journal_mode = WAL");

adsDb.exec(`
  CREATE TABLE IF NOT EXISTS ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position TEXT NOT NULL,
    company TEXT,
    headline TEXT,
    body TEXT,
    link TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed CurricuLOL ads if no ads exist
const adsCount = adsDb.prepare("SELECT COUNT(*) AS total FROM ads").get().total;

if (adsCount === 0) {
  const seedAds = adsDb.transaction(() => {
    // Left side ads (positions 0-3)
    const curricuLolLeft = adsDb.prepare(`
      INSERT INTO ads (position, company, headline, body, link, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    
    curricuLolLeft.run(
      "left_0",
      "CurricuLOL",
      "VOCÊ ESTÁ A 1 MINUTO DA SUA VAGA DOS SONHOS!",
      "Analise gratuitamente seu currículo ou Linkedin e descubra o que falta para você conquistar sucesso profissional.",
      "https://curricu.lol"
    );
    
    // Left side placeholder ads (1-3)
    const placeholderAd = adsDb.prepare(`
      INSERT INTO ads (position, company, headline, body, link, is_active)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    
    placeholderAd.run("left_1", "", "+ Anuncie seu produto aqui", "", "#advertise");
    placeholderAd.run("left_2", "", "+ Anuncie seu produto aqui", "", "#advertise");
    placeholderAd.run("left_3", "", "+ Anuncie seu produto aqui", "", "#advertise");
    
    // Right side ads (positions 0-3)
    const curricuLolRight = adsDb.prepare(`
      INSERT INTO ads (position, company, headline, body, link, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    
    curricuLolRight.run(
      "right_0",
      "CurricuLOL",
      "UMA IA ESTÁ TE DESCARTANDO. NÓS TEMOS TRÊS",
      "ANYA simula a IA que te julga, VANELLOPE simula um recrutador e ARYA te vende como match perfeito",
      "https://curricu.lol"
    );
    
    // Right side placeholder ads (1-3)
    placeholderAd.run("right_1", "", "+ Anuncie seu produto aqui", "", "#advertise");
    placeholderAd.run("right_2", "", "+ Anuncie seu produto aqui", "", "#advertise");
    placeholderAd.run("right_3", "", "+ Anuncie seu produto aqui", "", "#advertise");
  });
  
  seedAds();
}

const getAllAds = adsDb.prepare("SELECT * FROM ads ORDER BY id ASC");

function getAds() {
  const ads = getAllAds.all();
  const result = { left: [], right: [] };
  
  for (const ad of ads) {
    if (ad.position.startsWith("left_")) {
      result.left.push(ad);
    } else if (ad.position.startsWith("right_")) {
      result.right.push(ad);
    }
  }
  
  return result;
}

module.exports = {
  DB_PATH,
  addWin,
  closeDatabase,
  getAds,
  getTopRankings
};
