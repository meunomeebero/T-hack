const {
  closeDatabase, DATABASE_URL, addWin, addLoss, getTopRankings, initDatabase,
  persistBan, persistReport, persistUsernameOwner, loadAntibotState
} = require("./db");
const { PORT, PUBLIC_DIR } = require("./src/config");
const { createGameSocketServer } = require("./src/game-socket-server");
const { createStaticServer } = require("./src/static-server");

async function main() {
  await initDatabase();

  const server = createStaticServer(PUBLIC_DIR, {
    getAds: require("./db").getAds
  });

  createGameSocketServer(server, {
    addWin,
    addLoss,
    getTopRankings,
    persistBan,
    persistReport,
    persistUsernameOwner,
    loadAntibotState
  });

  server.listen(PORT, () => {
    console.log("TERMINAL HACK server running on http://localhost:" + PORT);
    console.log("Database:", maskDatabaseUrl(DATABASE_URL));
  });

  async function shutdown() {
    await closeDatabase();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function maskDatabaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "****";
    }
    return url.toString();
  } catch (error) {
    return "DATABASE_URL";
  }
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
