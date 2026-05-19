const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required to start TERMINAL HACK.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
});

const INITIAL_ADS = [
  {
    position: "left_0",
    company: "CurricuLOL",
    headline: "VOCÊ ESTÁ A 1 MINUTO DA SUA VAGA DOS SONHOS!",
    body: "Analise gratuitamente seu currículo ou Linkedin e descubra o que falta para você conquistar sucesso profissional.",
    link: "https://curricu.lol",
    isActive: true
  },
  {
    position: "left_1",
    company: "",
    headline: "+ Anuncie seu produto aqui",
    body: "",
    link: "#partners",
    isActive: false
  },
  {
    position: "left_2",
    company: "",
    headline: "+ Anuncie seu produto aqui",
    body: "",
    link: "#partners",
    isActive: false
  },
  {
    position: "left_3",
    company: "",
    headline: "+ Anuncie seu produto aqui",
    body: "",
    link: "#partners",
    isActive: false
  },
  {
    position: "right_0",
    company: "CurricuLOL",
    headline: "UMA IA ESTÁ TE DESCARTANDO. NÓS TEMOS TRÊS",
    body: "ANYA simula a IA que te julga, VANELLOPE simula um recrutador e ARYA te vende como match perfeito",
    link: "https://curricu.lol",
    isActive: true
  },
  {
    position: "right_1",
    company: "",
    headline: "+ Anuncie seu produto aqui",
    body: "",
    link: "#partners",
    isActive: false
  },
  {
    position: "right_2",
    company: "",
    headline: "+ Anuncie seu produto aqui",
    body: "",
    link: "#partners",
    isActive: false
  },
  {
    position: "right_3",
    company: "",
    headline: "+ Anuncie seu produto aqui",
    body: "",
    link: "#partners",
    isActive: false
  }
];

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rankings (
      username TEXT PRIMARY KEY,
      score INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query("ALTER TABLE rankings ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE rankings ADD COLUMN IF NOT EXISTS losses INTEGER NOT NULL DEFAULT 0");
  await pool.query("UPDATE rankings SET wins = score WHERE wins = 0 AND score > 0");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id BIGSERIAL PRIMARY KEY,
      position TEXT NOT NULL UNIQUE,
      company TEXT,
      headline TEXT,
      body TEXT,
      link TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bans (
      username TEXT PRIMARY KEY,
      ip TEXT,
      banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      target TEXT NOT NULL,
      reporter_key TEXT NOT NULL,
      game_id TEXT,
      reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (target, reporter_key)
    );
  `);

  await migrateUsernameOwners();

  await pool.query("UPDATE ads SET link = '#partners' WHERE link = '#advertise'");

  await seedInitialAds();
}

async function persistBan(username, ip) {
  await pool.query(
    "INSERT INTO bans (username, ip) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET ip = COALESCE(EXCLUDED.ip, bans.ip)",
    [username, ip || null]
  );
}

async function persistReport(target, reporterKey, gameId) {
  await pool.query(
    "INSERT INTO reports (target, reporter_key, game_id) VALUES ($1, $2, $3) ON CONFLICT (target, reporter_key) DO NOTHING",
    [target, reporterKey, gameId || null]
  );
}

async function migrateUsernameOwners() {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.username_owners') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'username_owners'
            AND column_name = 'owner_key'
        )
      THEN
        CREATE TABLE username_owners_migrated (
          owner_key TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          client_id TEXT NOT NULL,
          ip TEXT,
          claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        INSERT INTO username_owners_migrated (owner_key, username, client_id, ip, claimed_at)
        SELECT username || '::' || COALESCE(NULLIF(ip, ''), 'unknown'), username, client_id, ip, claimed_at
        FROM username_owners
        ON CONFLICT (owner_key) DO NOTHING;

        DROP TABLE username_owners;
        ALTER TABLE username_owners_migrated RENAME TO username_owners;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS username_owners (
      owner_key TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      client_id TEXT NOT NULL,
      ip TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function persistUsernameOwner(username, ownerKey, clientId, ip) {
  await pool.query(
    `
      INSERT INTO username_owners (owner_key, username, client_id, ip)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (owner_key) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        ip = COALESCE(EXCLUDED.ip, username_owners.ip)
    `,
    [ownerKey, username, clientId, ip || null]
  );
}

async function loadAntibotState() {
  const [bansRes, reportsRes, ownersRes] = await Promise.all([
    pool.query("SELECT username, ip FROM bans"),
    pool.query("SELECT target, reporter_key FROM reports"),
    pool.query("SELECT owner_key, client_id FROM username_owners")
  ]);

  const bannedUsernames = [];
  const bannedIps = [];
  for (const row of bansRes.rows) {
    bannedUsernames.push(row.username);
    if (row.ip) bannedIps.push(row.ip);
  }

  const reports = {};
  for (const row of reportsRes.rows) {
    if (!reports[row.target]) reports[row.target] = [];
    reports[row.target].push(row.reporter_key);
  }

  const owners = {};
  for (const row of ownersRes.rows) {
    owners[row.owner_key] = row.client_id;
  }

  return { bannedUsernames, bannedIps, reports, owners };
}

async function seedInitialAds() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const ad of INITIAL_ADS) {
      await client.query(
        `
          INSERT INTO ads (position, company, headline, body, link, is_active)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (position) DO NOTHING
        `,
        [ad.position, ad.company, ad.headline, ad.body, ad.link, ad.isActive]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getTopRankings(limit = 10) {
  const result = await pool.query(
    `
      SELECT username, score, wins, losses
      FROM rankings
      ORDER BY score DESC, updated_at ASC, username ASC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows.map((row, index) => ({
    rank: index + 1,
    username: row.username,
    score: row.score,
    wins: row.wins || 0,
    losses: row.losses || 0
  }));
}

async function addWin(username) {
  await pool.query(
    `
      INSERT INTO rankings (username, wins, score, updated_at)
      VALUES ($1, 1, 1, NOW())
      ON CONFLICT (username) DO UPDATE SET
        wins = rankings.wins + 1,
        score = rankings.wins + 1 - rankings.losses,
        updated_at = NOW()
    `,
    [username]
  );
}

async function addLoss(username) {
  await pool.query(
    `
      INSERT INTO rankings (username, losses, score, updated_at)
      VALUES ($1, 1, -1, NOW())
      ON CONFLICT (username) DO UPDATE SET
        losses = rankings.losses + 1,
        score = rankings.wins - (rankings.losses + 1),
        updated_at = NOW()
    `,
    [username]
  );
}

async function getAds() {
  const result = await pool.query(`
    SELECT id, position, company, headline, body, link, is_active, created_at
    FROM ads
    ORDER BY id ASC
  `);

  const ads = result.rows.map((row) => ({
    id: Number(row.id),
    position: row.position,
    company: row.company || "",
    headline: row.headline || "",
    body: row.body || "",
    link: row.link || "",
    is_active: row.is_active ? 1 : 0,
    created_at: row.created_at
  }));
  const resultBySide = { left: [], right: [] };

  for (const ad of ads) {
    if (ad.position.startsWith("left_")) {
      resultBySide.left.push(ad);
    } else if (ad.position.startsWith("right_")) {
      resultBySide.right.push(ad);
    }
  }

  return resultBySide;
}

async function closeDatabase() {
  await pool.end();
}

module.exports = {
  DATABASE_URL,
  addWin,
  addLoss,
  closeDatabase,
  getAds,
  getTopRankings,
  initDatabase,
  persistBan,
  persistReport,
  persistUsernameOwner,
  loadAntibotState
};
