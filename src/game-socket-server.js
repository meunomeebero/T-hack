const { WebSocketServer, WebSocket } = require("ws");
const {
  CLEANUP_DELAY_MS,
  DISCONNECT_FORFEIT_MS,
  GAME_ROUNDS,
  PAGE_TRANSITION_GRACE_MS,
  ROUND_TIME_LIMIT_MS
} = require("./config");
const { generateCommands } = require("./commands");

function createGameSocketServer(server, rankingStore) {
  const waitingPlayers = [];
  const activeGames = new Map();
  const connections = new Map();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("New connection");

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
    connections.delete(ws);

    if (!conn) {
      return;
    }

    removeWaitingPlayer(conn.clientId, ws);

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
    }
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

    removeWaitingPlayer(clientId);
    connections.set(ws, {
      username,
      clientId,
      gameId: null,
      playerIndex: null
    });

    send(ws, { type: "registered", username, clientId });
    console.log("Registered:", username, clientId);
  }

  function handleGetRankings(ws) {
    send(ws, { type: "rankings", rankings: rankingStore.getTopRankings(10) });
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

    if (waitingPlayers.find((player) => player.clientId === conn.clientId)) {
      return;
    }

    waitingPlayers.push({
      ws,
      username: conn.username,
      clientId: conn.clientId
    });

    send(ws, { type: "searching", message: "Searching for opponent..." });
    tryMatchmaking();
  }

  function handleCancelMatch(ws) {
    const conn = connections.get(ws);
    if (!conn) {
      return;
    }

    removeWaitingPlayer(conn.clientId, ws);
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

    player.input = input;
    player.progress = (normalizedInput.length / normalizedCommand.length) * 100;

    if (normalizedInput === normalizedCommand) {
      player.completedRounds += 1;
      player.roundIndex += 1;
      player.input = "";
      player.progress = 0;

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

  function tryMatchmaking() {
    while (waitingPlayers.length >= 2) {
      const player0 = waitingPlayers.shift();
      const player1 = waitingPlayers.shift();
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

  function finishGame(game, winnerUsername, reason) {
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
      rankingStore.addWin(winnerUsername);
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
      ws: entry.ws,
      playerIndex,
      ready: false,
      connected: true,
      input: "",
      progress: 0,
      roundIndex: 0,
      completedRounds: 0,
      disconnectTimer: null
    };
  }

  function bindConnection(ws, username, clientId, gameId, playerIndex) {
    const existing = connections.get(ws) || {};
    connections.set(ws, {
      ...existing,
      username,
      clientId,
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

  function removeWaitingPlayer(clientId, ws) {
    const index = waitingPlayers.findIndex((player) => {
      if (ws) {
        return player.ws === ws || player.clientId === clientId;
      }

      return player.clientId === clientId;
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
}

function sanitizeUsername(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 20);
}

function sanitizeClientId(value) {
  const clean = String(value || "").trim();
  return clean.slice(0, 80);
}

module.exports = {
  createGameSocketServer
};
