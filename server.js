const { closeDatabase, DB_PATH, addWin, getTopRankings } = require("./db");
const { PORT, PUBLIC_DIR } = require("./src/config");
const { createGameSocketServer } = require("./src/game-socket-server");
const { createStaticServer } = require("./src/static-server");

const server = createStaticServer(PUBLIC_DIR);

createGameSocketServer(server, {
  addWin,
  getTopRankings
});

server.listen(PORT, () => {
  console.log("TERMINAL HACK server running on http://localhost:" + PORT);
  console.log("Leaderboard database:", DB_PATH);
});

function shutdown() {
  closeDatabase();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
