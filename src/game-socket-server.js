const { WebSocketServer, WebSocket } = require("ws");
const {
  CLEANUP_DELAY_MS,
  DISCONNECT_FORFEIT_MS,
  GAME_ROUNDS,
  PAGE_TRANSITION_GRACE_MS,
  ROUND_TIME_LIMIT_MS
} = require("./config");
const { generateCommands } = require("./commands");

const MIN_KEY_INTERVAL_MS = 18;
const MIN_MS_PER_CHAR = 28;
const MIN_ROUND_MS_BASE = 100;
const MIN_VARIANCE_MS_SQ = 9;
const MIN_KEYS_FOR_VARIANCE = 8;
const MAX_SUSPICION = 6;
const FIND_MATCH_COOLDOWN_MS = 1500;
const REPORTS_TO_BAN = 4;
const MAX_CONNECTIONS_PER_IP = 3;

function createGameSocketServer(server, rankingStore) {
  const waitingPlayers = [];
  const activeGames = new Map();
  const connections = new Map();
  const findMatchHistory = new Map();
  const reportCounts = new Map();
  const bannedIps = new Set();
  const bannedUsernames = new Set();
  const userIps = new Map();
  const ipConnectionCount = new Map();
  const usernameOwners = new Map();
  const winStreaks = new Map();
  const wss = new WebSocketServer({ server });

  if (rankingStore && typeof rankingStore.loadAntibotState === "function") {
    rankingStore.loadAntibotState().then((state) => {
      if (!state) return;
      for (const u of state.bannedUsernames || []) bannedUsernames.add(u);
      for (const i of state.bannedIps || []) bannedIps.add(i);
      for (const [u, set] of Object.entries(state.reports || {})) {
        reportCounts.set(u, new Set(set));
      }
      for (const [u, c] of Object.entries(state.owners || {})) {
        usernameOwners.set(u, c);
      }
      console.log("[antibot] loaded", bannedUsernames.size, "bans,", reportCounts.size, "report targets,", usernameOwners.size, "owners");
    }).catch((e) => console.error("[antibot] load failed:", e));
  }

  wss.on("connection", (ws, req) => {
    const ip = extractIp(req);
    if (ip && bannedIps.has(ip)) {
      try { ws.close(1008, "banned"); } catch (e) {}
      return;
    }
    if (ip) {
      const count = (ipConnectionCount.get(ip) || 0) + 1;
      if (count > MAX_CONNECTIONS_PER_IP) {
        console.warn("[ip-cap] rejecting", ip, "count=" + count);
        try { ws.close(1008, "ip-cap"); } catch (e) {}
        return;
      }
      ipConnectionCount.set(ip, count);
    }
    ws._remoteIp = ip || "";
    console.log("New connection", ip || "no-ip");

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(ws, message);
      } catch (error) {
        console.error("Invalid message:", error);
      }
    });

    ws.on("close", () => {
      handleClose(ws);
    });
  });

  function handleClose(ws) {
    const conn = connections.get(ws);
    const ip = ws._remoteIp || "";
    if (ip && ipConnectionCount.has(ip)) {
      const next = (ipConnectionCount.get(ip) || 1) - 1;
      if (next <= 0) {
        ipConnectionCount.delete(ip);
      } else {
        ipConnectionCount.set(ip, next);
      }
    }

    if (conn && conn.spectatingGameId) {
      const watched = activeGames.get(conn.spectatingGameId);
      if (watched && watched.spectators) {
        watched.spectators.delete(ws);
      }
    }

    connections.delete(ws);

    if (!conn) {
      return;
    }

    removeWaitingPlayer(conn.sessionKey || conn.clientId, ws);

    if (conn.gameId && typeof conn.playerIndex === "number") {
      const game = activeGames.get(conn.gameId);
      if (game) {
        const playerKey = getPlayerKey(conn.playerIndex);
        const player = game[playerKey];

        if (player && player.ws === ws) {
          handlePlayerDisconnect(game, playerKey);
        }
      }
    }

    console.log("Connection closed:", conn.username || conn.clientId || "unknown");
  }

  function handleMessage(ws, message) {
    switch (message.type) {
      case "register":
        handleRegister(ws, message);
        break;
      case "get_rankings":
        handleGetRankings(ws);
        break;
      case "find_match":
        handleFindMatch(ws);
        break;
      case "cancel_match":
        handleCancelMatch(ws);
        break;
      case "resume_game":
        handleResumeGame(ws, message);
        break;
      case "game_ready":
        handleGameReady(ws);
        break;
      case "game_input":
        handleGameInput(ws, message);
        break;
      case "get_active_matches":
        handleGetActiveMatches(ws);
        break;
      case "spectate_match":
        handleSpectateMatch(ws, message);
        break;
      case "cancel_spectate":
        handleCancelSpectate(ws);
        break;
      case "report_player":
        handleReportPlayer(ws, message);
        break;
    }
  }

  function handleReportPlayer(ws, message) {
    const conn = connections.get(ws);
    if (!conn || !conn.clientId) {
      return;
    }
    const target = sanitizeUsername(message.target);
    if (!target || target === conn.username) {
      return;
    }
    const gameId = String(message.gameId || "");
    const game = activeGames.get(gameId);
    if (!game) {
      return;
    }
    const involved = game.player0.username === conn.username
      || game.player1.username === conn.username
      || (game.spectators && game.spectators.has(ws));
    if (!involved) {
      return;
    }
    if (game.player0.username !== target && game.player1.username !== target) {
      return;
    }

    let reporters = reportCounts.get(target);
    if (!reporters) {
      reporters = new Set();
      reportCounts.set(target, reporters);
    }
    const reporterKey = ws._remoteIp || conn.clientId;
    if (reporters.has(reporterKey)) {
      send(ws, { type: "report_ack", target: target, count: reporters.size });
      return;
    }
    reporters.add(reporterKey);
    send(ws, { type: "report_ack", target: target, count: reporters.size });
    console.warn("[report]", target, "now has", reporters.size, "unique reports");

    if (rankingStore && typeof rankingStore.persistReport === "function") {
      rankingStore.persistReport(target, reporterKey, gameId).catch((e) => console.error("[report] persist failed:", e));
    }

    if (reporters.size >= REPORTS_TO_BAN) {
      bannedUsernames.add(target);
      const ip = userIps.get(target);
      if (ip) {
        bannedIps.add(ip);
      }
      console.warn("[banned]", target, "ip=" + (ip || "unknown"));
      if (rankingStore && typeof rankingStore.persistBan === "function") {
        rankingStore.persistBan(target, ip || null).catch((e) => console.error("[ban] persist failed:", e));
      }
      kickBanned(target);
    }
  }

  function kickBanned(username) {
    for (const [sock, conn] of connections.entries()) {
      if (conn && conn.username === username) {
        try { sock.close(1008, "banned"); } catch (e) {}
      }
    }
  }

  function handleGetActiveMatches(ws) {
    const matches = [];
    for (const game of activeGames.values()) {
      if (game.status === "active" && !game.winner) {
        matches.push({
          gameId: game.id,
          player0: game.player0.username,
          player1: game.player1.username,
          player0Rounds: game.player0.completedRounds,
          player1Rounds: game.player1.completedRounds,
          totalRounds: GAME_ROUNDS,
          startedAt: game.startTime,
          spectators: game.spectators ? game.spectators.size : 0
        });
      }
    }
    matches.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    let onlineCount = 0;
    for (const conn of connections.values()) {
      if (conn && conn.username) {
        onlineCount += 1;
      }
    }

    const waiting = waitingPlayers.map((p) => ({ username: p.username })).slice(0, 5);

    send(ws, {
      type: "active_matches",
      matches: matches.slice(0, 5),
      onlineCount: onlineCount,
      waiting: waiting
    });
  }

  function handleSpectateMatch(ws, message) {
    const gameId = String(message.gameId || "");
    const game = activeGames.get(gameId);
    if (!game || game.status !== "active" || game.winner) {
      send(ws, { type: "spectate_error", message: "Partida nao esta mais ativa" });
      return;
    }
    removeSpectator(ws);
    if (!game.spectators) {
      game.spectators = new Set();
    }
    game.spectators.add(ws);
    const existing = connections.get(ws) || {};
    connections.set(ws, { ...existing, spectatingGameId: gameId });
    send(ws, {
      type: "spectate_started",
      gameId: game.id,
      player0: game.player0.username,
      player1: game.player1.username,
      commands: game.commands,
      totalRounds: GAME_ROUNDS,
      roundTimeLimitMs: ROUND_TIME_LIMIT_MS,
      state: serializeGame(game)
    });
  }

  function handleCancelSpectate(ws) {
    removeSpectator(ws);
  }

  function removeSpectator(ws) {
    const conn = connections.get(ws);
    if (!conn || !conn.spectatingGameId) {
      return;
    }
    const game = activeGames.get(conn.spectatingGameId);
    if (game && game.spectators) {
      game.spectators.delete(ws);
    }
    connections.set(ws, { ...conn, spectatingGameId: null });
  }

  function handleRegister(ws, message) {
    const username = sanitizeUsername(message.username);
    const clientId = sanitizeClientId(message.clientId);

    if (!username) {
      send(ws, { type: "error", message: "Username required" });
      return;
    }

    if (!clientId) {
      send(ws, { type: "error", message: "Client id required" });
      return;
    }

    if (bannedUsernames.has(username)) {
      send(ws, { type: "error", message: "Conta banida." });
      try { ws.close(1008, "banned"); } catch (e) {}
      return;
    }

    const ip = ws._remoteIp || "";
    if (ip && bannedIps.has(ip)) {
      try { ws.close(1008, "banned"); } catch (e) {}
      return;
    }
    const sessionKey = createSessionKey(username, ip);

    const owner = usernameOwners.get(sessionKey);
    if (!owner) {
      usernameOwners.set(sessionKey, clientId);
    } else if (owner !== clientId) {
      usernameOwners.set(sessionKey, clientId);
    }

    if (rankingStore && typeof rankingStore.persistUsernameOwner === "function") {
      rankingStore.persistUsernameOwner(username, sessionKey, clientId, ip).catch((e) => console.error("[owner] persist failed:", e));
    }

    if (ip) {
      userIps.set(username, ip);
    }

    removeWaitingPlayer(sessionKey);
    connections.set(ws, {
      username,
      clientId,
      sessionKey,
      gameId: null,
      playerIndex: null
    });

    send(ws, { type: "registered", username, clientId });
    console.log("Registered:", username, clientId, ip || "");
  }

  async function handleGetRankings(ws) {
    try {
      send(ws, { type: "rankings", rankings: await rankingStore.getTopRankings(10) });
    } catch (error) {
      console.error("Failed to load rankings:", error);
      send(ws, { type: "rankings", rankings: [] });
    }
  }

  function handleFindMatch(ws) {
    const conn = connections.get(ws);
    if (!conn || !conn.username || !conn.clientId) {
      send(ws, { type: "error", message: "Not registered" });
      return;
    }

    if (conn.gameId) {
      send(ws, { type: "error", message: "Already in a game" });
      return;
    }

    const now = Date.now();
    const lastFind = findMatchHistory.get(conn.sessionKey || conn.clientId) || 0;
    if (now - lastFind < FIND_MATCH_COOLDOWN_MS) {
      send(ws, { type: "error", message: "Aguarde antes de buscar outra partida." });
      return;
    }
    findMatchHistory.set(conn.sessionKey || conn.clientId, now);

    if (waitingPlayers.find((player) => player.sessionKey === conn.sessionKey)) {
      return;
    }

    waitingPlayers.push({
      ws,
      username: conn.username,
      clientId: conn.clientId,
      sessionKey: conn.sessionKey
    });

    send(ws, { type: "searching", message: "Searching for opponent..." });
    tryMatchmaking();
  }

  function handleCancelMatch(ws) {
    const conn = connections.get(ws);
    if (!conn) {
      return;
    }

    removeWaitingPlayer(conn.sessionKey || conn.clientId, ws);
    send(ws, { type: "cancelled" });
  }

  function handleResumeGame(ws, message) {
    const clientId = sanitizeClientId(message.clientId);
    const gameId = String(message.gameId || "");
    const game = activeGames.get(gameId);

    if (!clientId || !game) {
      send(ws, { type: "error", message: "Match expired" });
      return;
    }

    const playerKey = identifyPlayerByClient(game, clientId);
    if (!playerKey) {
      send(ws, { type: "error", message: "Player not found in match" });
      return;
    }

    const player = game[playerKey];
    const opponent = game[getOpponentKey(playerKey)];

    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.connected = true;
    player.ws = ws;

    connections.set(ws, {
      username: player.username,
      clientId: player.clientId,
      sessionKey: player.sessionKey,
      gameId: game.id,
      playerIndex: player.playerIndex
    });

    send(ws, {
      type: "game_resumed",
      gameId: game.id,
      playerIndex: player.playerIndex,
      opponent: opponent.username,
      commands: game.commands,
      totalRounds: GAME_ROUNDS,
      roundTimeLimitMs: ROUND_TIME_LIMIT_MS,
      state: serializeGame(game)
    });

    if (opponent.ws && opponent.ws.readyState === WebSocket.OPEN) {
      send(opponent.ws, { type: "opponent_reconnected" });
    }
  }

  function handleGameReady(ws) {
    const conn = connections.get(ws);
    if (!conn || !conn.gameId) {
      return;
    }

    const game = activeGames.get(conn.gameId);
    if (!game || game.status !== "awaiting_players") {
      return;
    }

    const playerKey = getPlayerKey(conn.playerIndex);
    const opponentKey = getOpponentKey(playerKey);
    const player = game[playerKey];
    const opponent = game[opponentKey];

    player.ready = true;

    if (opponent.ws && opponent.ws.readyState === WebSocket.OPEN) {
      send(opponent.ws, { type: "opponent_ready", player: player.username });
    }

    if (game.player0.ready && game.player1.ready) {
      startGame(game);
    }
  }

  function handleGameInput(ws, message) {
    const conn = connections.get(ws);
    if (!conn || !conn.gameId) {
      return;
    }

    const game = activeGames.get(conn.gameId);
    if (!game || game.status !== "active" || game.winner) {
      return;
    }

    const player = game[getPlayerKey(conn.playerIndex)];
    const command = game.commands[player.roundIndex];

    if (!command) {
      return;
    }

    const input = typeof message.input === "string"
      ? message.input.slice(0, command.length)
      : "";

    const normalizedInput = input.toLowerCase();
    const normalizedCommand = command.toLowerCase();

    if (normalizedInput.length === 0) {
      player.input = "";
      player.progress = 0;
      player.inputTimes = [];
      broadcast(game, {
        type: "progress",
        player: player.username,
        playerIndex: player.playerIndex,
        input: "",
        progress: 0,
        roundIndex: player.roundIndex,
        completedRounds: player.completedRounds
      });
      return;
    }

    if (!normalizedCommand.startsWith(normalizedInput)) {
      return;
    }

    const now = Date.now();
    const previousLen = (player.input || "").length;
    if (normalizedInput.length > previousLen) {
      if (!Array.isArray(player.inputTimes)) {
        player.inputTimes = [];
      }
      if (player.inputTimes.length === 0) {
        if (!player.roundStartedAt) {
          player.roundStartedAt = now;
        }
        player.inputTimes.push(now);
      } else {
        const lastTime = player.inputTimes[player.inputTimes.length - 1];
        const interval = now - lastTime;
        if (interval < MIN_KEY_INTERVAL_MS) {
          rejectInput(game, player, "fast_key");
          return;
        }
        player.inputTimes.push(now);
        if (player.inputTimes.length > 32) {
          player.inputTimes.shift();
        }
      }
    }

    player.input = input;
    player.progress = (normalizedInput.length / normalizedCommand.length) * 100;

    if (normalizedInput === normalizedCommand) {
      const minDuration = Math.max(MIN_ROUND_MS_BASE, normalizedCommand.length * MIN_MS_PER_CHAR);
      const elapsed = player.roundStartedAt ? now - player.roundStartedAt : minDuration;
      if (elapsed < minDuration) {
        rejectInput(game, player, "fast_round");
        return;
      }
      const variance = computeVariance(player.inputTimes);
      if (player.inputTimes.length >= MIN_KEYS_FOR_VARIANCE && variance < MIN_VARIANCE_MS_SQ) {
        rejectInput(game, player, "low_variance");
        return;
      }

      player.completedRounds += 1;
      player.roundIndex += 1;
      player.input = "";
      player.progress = 0;
      player.inputTimes = [];
      player.roundStartedAt = Date.now();

      if (player.completedRounds >= game.commands.length) {
        finishGame(game, player.username, "finish");
        return;
      }

      broadcast(game, {
        type: "command_complete",
        player: player.username,
        playerIndex: player.playerIndex,
        roundIndex: player.roundIndex,
        completedRounds: player.completedRounds,
        nextCommand: game.commands[player.roundIndex] || ""
      });
      return;
    }

    broadcast(game, {
      type: "progress",
      player: player.username,
      playerIndex: player.playerIndex,
      input: player.input,
      progress: player.progress,
      roundIndex: player.roundIndex,
      completedRounds: player.completedRounds
    });
  }

  function rejectInput(game, player, kind) {
    player.suspicionCount = (player.suspicionCount || 0) + 1;
    console.warn("[antibot]", kind, player.username, "count=" + player.suspicionCount);

    player.input = "";
    player.progress = 0;
    player.inputTimes = [];
    player.roundStartedAt = 0;

    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      send(player.ws, {
        type: "input_rejected",
        reason: kind,
        roundIndex: player.roundIndex,
        completedRounds: player.completedRounds
      });
    }

    if (player.suspicionCount >= MAX_SUSPICION) {
      const opponent = game[getOpponentKey(getPlayerKey(player.playerIndex))];
      finishGame(game, opponent && opponent.username ? opponent.username : null, "antibot");
    }
  }

  function computeVariance(times) {
    if (!Array.isArray(times) || times.length < 3) {
      return Infinity;
    }
    const intervals = [];
    for (let i = 1; i < times.length; i += 1) {
      intervals.push(times[i] - times[i - 1]);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    let sumSq = 0;
    for (const v of intervals) {
      sumSq += (v - mean) * (v - mean);
    }
    return sumSq / intervals.length;
  }

  function tryMatchmaking() {
    while (waitingPlayers.length >= 2) {
      const player0 = waitingPlayers.shift();
      const opponentIndex = waitingPlayers.findIndex((player) => player.sessionKey !== player0.sessionKey);
      if (opponentIndex === -1) {
        waitingPlayers.unshift(player0);
        return;
      }
      const player1 = waitingPlayers.splice(opponentIndex, 1)[0];
      const gameId = "game_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
      const game = {
        id: gameId,
        commands: generateCommands(GAME_ROUNDS),
        status: "awaiting_players",
        startTime: null,
        winner: null,
        reason: null,
        timeoutTimer: null,
        cleanupTimer: null,
        player0: createGamePlayer(player0, 0),
        player1: createGamePlayer(player1, 1)
      };

      activeGames.set(gameId, game);

      bindConnection(player0.ws, player0.username, player0.clientId, gameId, 0);
      bindConnection(player1.ws, player1.username, player1.clientId, gameId, 1);

      send(player0.ws, {
        type: "match_found",
        gameId,
        playerIndex: 0,
        opponent: player1.username,
        commands: game.commands,
        totalRounds: GAME_ROUNDS,
        roundTimeLimitMs: ROUND_TIME_LIMIT_MS
      });

      send(player1.ws, {
        type: "match_found",
        gameId,
        playerIndex: 1,
        opponent: player0.username,
        commands: game.commands,
        totalRounds: GAME_ROUNDS,
        roundTimeLimitMs: ROUND_TIME_LIMIT_MS
      });

      console.log("Match found:", player0.username, "vs", player1.username);
    }
  }

  function startGame(game) {
    if (game.status !== "awaiting_players") {
      return;
    }

    game.status = "active";
    game.startTime = Date.now();

    broadcast(game, {
      type: "game_start",
      startedAt: game.startTime,
      timeLimitMs: ROUND_TIME_LIMIT_MS,
      totalRounds: GAME_ROUNDS
    });

    game.timeoutTimer = setTimeout(() => {
      resolveTimeout(game.id);
    }, ROUND_TIME_LIMIT_MS);

    console.log("Game started:", game.player0.username, "vs", game.player1.username);
  }

  function resolveTimeout(gameId) {
    const game = activeGames.get(gameId);
    if (!game || game.status !== "active" || game.winner) {
      return;
    }

    const player0Score = game.player0.completedRounds + game.player0.progress / 100;
    const player1Score = game.player1.completedRounds + game.player1.progress / 100;

    if (Math.abs(player0Score - player1Score) < 0.001) {
      finishGame(game, null, "timeout_draw");
      return;
    }

    finishGame(
      game,
      player0Score > player1Score ? game.player0.username : game.player1.username,
      "timeout"
    );
  }

  function handlePlayerDisconnect(game, playerKey) {
    const player = game[playerKey];
    const opponent = game[getOpponentKey(playerKey)];

    player.connected = false;
    player.ready = false;
    player.ws = null;

    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;

    if (game.status === "finished") {
      return;
    }

    if (opponent.ws && opponent.ws.readyState === WebSocket.OPEN) {
      send(opponent.ws, {
        type: "opponent_connection_lost",
        graceMs: game.status === "awaiting_players" ? PAGE_TRANSITION_GRACE_MS : DISCONNECT_FORFEIT_MS
      });
    }

    player.disconnectTimer = setTimeout(() => {
      if (player.connected || game.status === "finished") {
        return;
      }

      if (!opponent.connected) {
        finishGame(game, null, "timeout_draw");
        return;
      }

      finishGame(game, opponent.username, "forfeit");
    }, game.status === "awaiting_players" ? PAGE_TRANSITION_GRACE_MS : DISCONNECT_FORFEIT_MS);
  }

  async function finishGame(game, winnerUsername, reason) {
    if (!game || game.status === "finished") {
      return;
    }

    game.status = "finished";
    game.winner = winnerUsername;
    game.reason = reason;

    clearTimeout(game.timeoutTimer);
    clearTimeout(game.player0.disconnectTimer);
    clearTimeout(game.player1.disconnectTimer);

    game.timeoutTimer = null;
    game.player0.disconnectTimer = null;
    game.player1.disconnectTimer = null;

    if (winnerUsername) {
      const loserUsername = winnerUsername === game.player0.username
        ? game.player1.username
        : game.player0.username;
      winStreaks.set(loserUsername, 0);

      winStreaks.set(winnerUsername, (winStreaks.get(winnerUsername) || 0) + 1);

      const rankingUpdates = [rankingStore.addWin(winnerUsername)];
      if (loserUsername && typeof rankingStore.addLoss === "function") {
        rankingUpdates.push(rankingStore.addLoss(loserUsername));
      }

      const results = await Promise.allSettled(rankingUpdates);
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Failed to update ranking:", result.reason);
        }
      }
    }

    broadcast(game, {
      type: "game_over",
      winner: winnerUsername,
      reason,
      totalRounds: GAME_ROUNDS,
      player0Rounds: game.player0.completedRounds,
      player1Rounds: game.player1.completedRounds
    });

    releaseConnection(game.player0);
    releaseConnection(game.player1);

    game.cleanupTimer = setTimeout(() => {
      activeGames.delete(game.id);
    }, CLEANUP_DELAY_MS);

    console.log("Game over:", winnerUsername || "draw", "reason:", reason);
  }

  function createGamePlayer(entry, playerIndex) {
    return {
      username: entry.username,
      clientId: entry.clientId,
      sessionKey: entry.sessionKey,
      ws: entry.ws,
      playerIndex,
      ready: false,
      connected: true,
      input: "",
      progress: 0,
      roundIndex: 0,
      completedRounds: 0,
      disconnectTimer: null,
      inputTimes: [],
      roundStartedAt: 0,
      suspicionCount: 0
    };
  }

  function bindConnection(ws, username, clientId, gameId, playerIndex) {
    const existing = connections.get(ws) || {};
    connections.set(ws, {
      ...existing,
      username,
      clientId,
      sessionKey: existing.sessionKey,
      gameId,
      playerIndex
    });
  }

  function releaseConnection(player) {
    if (!player.ws) {
      return;
    }

    const conn = connections.get(player.ws);
    if (!conn) {
      return;
    }

    connections.set(player.ws, {
      ...conn,
      gameId: null,
      playerIndex: null
    });
  }

  function serializeGame(game) {
    return {
      status: game.status,
      startedAt: game.startTime,
      winner: game.winner,
      reason: game.reason,
      player0: serializePlayer(game.player0),
      player1: serializePlayer(game.player1)
    };
  }

  function serializePlayer(player) {
    return {
      username: player.username,
      connected: player.connected,
      input: player.input,
      progress: player.progress,
      roundIndex: player.roundIndex,
      completedRounds: player.completedRounds
    };
  }

  function identifyPlayerByClient(game, clientId) {
    if (game.player0.clientId === clientId) {
      return "player0";
    }

    if (game.player1.clientId === clientId) {
      return "player1";
    }

    return null;
  }

  function getPlayerKey(playerIndex) {
    return playerIndex === 0 ? "player0" : "player1";
  }

  function getOpponentKey(playerKey) {
    return playerKey === "player0" ? "player1" : "player0";
  }

  function removeWaitingPlayer(identity, ws) {
    const index = waitingPlayers.findIndex((player) => {
      if (ws) {
        return player.ws === ws || player.clientId === identity || player.sessionKey === identity;
      }

      return player.clientId === identity || player.sessionKey === identity;
    });

    if (index !== -1) {
      waitingPlayers.splice(index, 1);
    }
  }

  return wss;
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(game, payload) {
  send(game.player0.ws, payload);
  send(game.player1.ws, payload);
  if (game.spectators) {
    for (const ws of game.spectators) {
      send(ws, payload);
    }
  }
}

function extractIp(req) {
  if (!req) {
    return "";
  }
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) {
    const first = String(fwd).split(",")[0].trim();
    if (first) {
      return first;
    }
  }
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "";
}

function sanitizeUsername(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function sanitizeClientId(value) {
  const clean = String(value || "").trim();
  return clean.slice(0, 80);
}

function createSessionKey(username, ip) {
  return sanitizeUsername(username).toLowerCase() + "::" + String(ip || "unknown").trim();
}

module.exports = {
  createGameSocketServer
};
