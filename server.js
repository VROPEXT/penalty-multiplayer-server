const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);

app.get("/", (_req, res) => {
  res.send("Penalty Kings multiplayer server v11 reconnect grace is running.");
});

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  pingTimeout: 70000,
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000,
    skipMiddlewares: true
  }
});

const rooms = new Map();
let waitingSocketId = null;

const VALID_DIRECTIONS = new Set([-1, 0, 1]);
const VALID_EXPRESSIONS = new Set(["smile", "focus", "cool"]);
const MAX_TURNS = 6;
const GOAL_W = 7.32;
const GOAL_H = 2.44;
const POST_X = GOAL_W / 2;
const INSIDE_POST_X = POST_X - 0.12;
const MAX_REPLAY_X = POST_X + 1.15;

function getSocket(id) {
  return io.sockets.sockets.get(id) || null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanName(name, fallback = "Player") {
  const cleaned = String(name || fallback || "Player")
    .replace(/[^a-zA-Z0-9 _.-]/g, "")
    .trim()
    .slice(0, 12);
  return cleaned || fallback || "Player";
}

function cleanTeam(team) {
  return String(team || "BEL")
    .replace(/[^A-Z]/gi, "")
    .slice(0, 3)
    .toUpperCase() || "BEL";
}

function cleanSearchId(value) {
  return String(value || ("s-" + randomUUID().slice(0, 8)))
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 60);
}

function cleanClientId(value) {
  return String(value || ("c-" + randomUUID().slice(0, 12)))
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 80);
}

function cleanColor(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(0xffffff, Math.round(n)));
}

function cleanProfile(profile = {}) {
  return {
    skin: cleanColor(profile.skin, 0xd99a69),
    boots: cleanColor(profile.boots, 0x111827),
    hair: cleanColor(profile.hair, 0x22150f),
    expression: VALID_EXPRESSIONS.has(profile.expression) ? profile.expression : "smile"
  };
}

function laneFromX(x) {
  if (x < -0.42) return -1;
  if (x > 0.42) return 1;
  return 0;
}

function computeShotTarget(aimNorm, power, precision) {
  aimNorm = clampNumber(aimNorm, -1, 1, 0);
  power = clampNumber(power, 0, 1, 0.65);
  precision = clampNumber(precision, 0, 1, 0.5);

  const sign = aimNorm < -0.025 ? -1 : (aimNorm > 0.025 ? 1 : 0);
  const absAim = Math.abs(aimNorm);
  const sweet = precision >= 0.42 && precision <= 0.58;
  const insideCornerX = GOAL_W / 2 - 0.10;
  const curvedAim = sign * Math.pow(absAim, 0.72);
  let finalX = curvedAim * insideCornerX;

  if (sign !== 0 && absAim > 0.88 && power > 0.70 && sweet) {
    finalX = sign * insideCornerX;
  }

  const miss01 = Math.min(1, Math.abs(precision - 0.5) / 0.5);
  if (!sweet && sign !== 0) {
    finalX += sign * miss01 * 0.95;
  }

  let aimY;
  if (sweet) {
    const greenT = (precision - 0.42) / 0.16;
    aimY = 0.78 + greenT * 1.18;
  } else if (precision < 0.42) {
    aimY = Math.max(0.16, 0.78 - (0.42 - precision) * 2.20);
  } else {
    aimY = 1.96 + (precision - 0.58) * 3.65;
  }

  return {
    aimNorm,
    power,
    precision,
    finalX: clampNumber(finalX, -MAX_REPLAY_X, MAX_REPLAY_X, 0),
    aimY: clampNumber(aimY, 0.16, GOAL_H + 1.05, 1.2),
    direction: laneFromX(finalX),
    sweet,
    miss01
  };
}

function updateSocketProfile(socket, data = {}) {
  socket.data.name = cleanName(data.name, socket.data.name || "Player");
  socket.data.team = cleanTeam(data.team || socket.data.team || "BEL");
  socket.data.profile = cleanProfile(data.profile || socket.data.profile || {});
  socket.data.searchId = cleanSearchId(data.searchId || socket.data.searchId);
  socket.data.clientId = cleanClientId(data.clientId || socket.data.clientId);
  socket.data.clientVersion = String(data.clientVersion || socket.data.clientVersion || "unknown").slice(0, 24);
}

function clearStartTimer(room) {
  if (room && room.startTimer) {
    clearInterval(room.startTimer);
    room.startTimer = null;
  }
}

function removeWaiting(socket, notifySelf = false) {
  if (waitingSocketId === socket.id) {
    waitingSocketId = null;
    if (notifySelf) socket.emit("matchmakingCancelled", { reason: "cancelled", searchId: socket.data.searchId });
  }
}

function findRoomByClientId(clientId) {
  if (!clientId) return null;
  for (const room of rooms.values()) {
    for (const id of room.players) {
      if (room.clientIds && room.clientIds[id] === clientId) return room;
    }
  }
  return null;
}

function clearDisconnectTimer(room, socketId) {
  if (room && room.disconnectTimers && room.disconnectTimers[socketId]) {
    clearTimeout(room.disconnectTimers[socketId]);
    delete room.disconnectTimers[socketId];
  }
  if (room && room.disconnected) delete room.disconnected[socketId];
}

function replaceSocketInRoom(room, oldId, newSocket) {
  if (!room || !oldId || !newSocket || oldId === newSocket.id) return;
  const idx = room.players.indexOf(oldId);
  if (idx === -1) return;
  room.players[idx] = newSocket.id;
  const transfer = (obj, fallback) => {
    obj[newSocket.id] = obj[oldId] === undefined ? fallback : obj[oldId];
    delete obj[oldId];
  };
  transfer(room.names, cleanName(newSocket.data.name));
  transfer(room.teams, cleanTeam(newSocket.data.team));
  transfer(room.profiles, cleanProfile(newSocket.data.profile));
  transfer(room.searchIds, cleanSearchId(newSocket.data.searchId));
  transfer(room.clientIds, cleanClientId(newSocket.data.clientId));
  transfer(room.score, 0);
  transfer(room.ready, false);
  if (room.choices[oldId]) { room.choices[newSocket.id] = room.choices[oldId]; delete room.choices[oldId]; }
  clearDisconnectTimer(room, oldId);
  newSocket.join(room.id);
  newSocket.data.roomId = room.id;
}

function scheduleDisconnect(socket) {
  removeWaiting(socket, false);
  const roomId = socket.data.roomId;
  const room = roomId ? rooms.get(roomId) : null;
  if (!room || !room.players.includes(socket.id)) return;
  room.disconnected[socket.id] = Date.now();
  for (const opponentId of room.players.filter((id) => id !== socket.id)) {
    const opp = getSocket(opponentId);
    if (opp) opp.emit("opponentConnectionLost", { roomId: room.id, playerId: socket.id, graceMs: 45000 });
  }
  clearDisconnectTimer(room, socket.id);
  room.disconnectTimers[socket.id] = setTimeout(() => {
    const latest = rooms.get(room.id);
    if (!latest || !latest.players.includes(socket.id)) return;
    for (const opponentId of latest.players.filter((id) => id !== socket.id)) {
      const opp = getSocket(opponentId);
      if (opp) opp.emit("opponentLeft", { roomId: latest.id, playerId: socket.id, reason: "disconnect-timeout" });
    }
    clearStartTimer(latest);
    rooms.delete(latest.id);
  }, 45000);
}

function leaveAllGameRooms(socket, notifySelf = false) {
  removeWaiting(socket, notifySelf);

  for (const [roomId, room] of rooms.entries()) {
    if (!room.players.includes(socket.id)) continue;

    clearStartTimer(room);
    const opponents = room.players.filter((id) => id !== socket.id);
    for (const opponentId of opponents) {
      io.to(opponentId).emit("opponentLeft", { roomId, playerId: socket.id });
    }

    socket.leave(roomId);
    if (socket.data.roomId === roomId) socket.data.roomId = null;
    rooms.delete(roomId);

    if (notifySelf) socket.emit("leftMatch", { roomId });
  }
}

function payloadFor(room, socketId) {
  const opponentId = room.players.find((id) => id !== socketId) || null;
  return {
    roomId: room.id,
    youId: socketId,
    opponentId,
    players: room.players.slice(),
    names: { ...room.names },
    teams: { ...room.teams },
    profiles: { ...room.profiles },
    clientIds: { ...(room.clientIds || {}) },
    searchIds: { ...room.searchIds },
    yourSearchId: room.searchIds[socketId] || null,
    yourClientId: room.clientIds ? (room.clientIds[socketId] || null) : null,
    score: { ...room.score },
    turn: room.turn,
    maxTurns: room.maxTurns,
    shooterId: room.players[room.shooterIndex],
    serverTime: Date.now()
  };
}

function emitMatchPayload(room, eventName = "matchFound") {
  for (const id of room.players) {
    const socket = getSocket(id);
    if (socket && socket.connected) {
      socket.emit(eventName, payloadFor(room, id));
    }
  }
}

function maybeStopReliableStart(room) {
  if (!room) return;
  const allReady = room.players.every((id) => room.ready[id]);
  if (allReady) clearStartTimer(room);
}

function makeRoom(playerA, playerB) {
  if (!playerA?.connected || !playerB?.connected || playerA.id === playerB.id) return;

  const roomId = "room-" + randomUUID().slice(0, 8);
  const room = {
    id: roomId,
    players: [playerA.id, playerB.id],
    names: {
      [playerA.id]: cleanName(playerA.data.name, "Player 1"),
      [playerB.id]: cleanName(playerB.data.name, "Player 2")
    },
    teams: {
      [playerA.id]: cleanTeam(playerA.data.team),
      [playerB.id]: cleanTeam(playerB.data.team)
    },
    profiles: {
      [playerA.id]: cleanProfile(playerA.data.profile),
      [playerB.id]: cleanProfile(playerB.data.profile)
    },
    searchIds: {
      [playerA.id]: cleanSearchId(playerA.data.searchId),
      [playerB.id]: cleanSearchId(playerB.data.searchId)
    },
    clientIds: {
      [playerA.id]: cleanClientId(playerA.data.clientId),
      [playerB.id]: cleanClientId(playerB.data.clientId)
    },
    score: {
      [playerA.id]: 0,
      [playerB.id]: 0
    },
    turn: 1,
    maxTurns: MAX_TURNS,
    shooterIndex: 0,
    choices: {},
    ready: {},
    resolving: false,
    startEmitCount: 0,
    startTimer: null,
    disconnected: {},
    disconnectTimers: {}
  };

  rooms.set(roomId, room);
  playerA.join(roomId);
  playerB.join(roomId);
  playerA.data.roomId = roomId;
  playerB.data.roomId = roomId;

  console.log("Room created:", roomId, room.names, room.searchIds, room.profiles);

  // Reliable start: if one tab misses the first event, it receives the room payload again.
  emitMatchPayload(room, "matchFound");
  emitMatchPayload(room, "forceStartMatch");
  room.startTimer = setInterval(() => {
    if (!rooms.has(roomId)) {
      clearStartTimer(room);
      return;
    }
    room.startEmitCount++;
    emitMatchPayload(room, room.startEmitCount % 2 ? "matchFound" : "matchStart");
    emitMatchPayload(room, "forceStartMatch");
    maybeStopReliableStart(room);
    if (room.startEmitCount >= 16) clearStartTimer(room);
  }, 350);
}

function resolveTurn(room) {
  if (!room || room.resolving) return;

  const shooterId = room.players[room.shooterIndex];
  const keeperId = room.players[1 - room.shooterIndex];
  const shot = room.choices[shooterId]?.shot;
  const dive = room.choices[keeperId]?.dive;

  if (!shot || dive === undefined) return;

  room.resolving = true;
  clearStartTimer(room);

  const inFrame = Math.abs(shot.finalX) <= INSIDE_POST_X && shot.aimY > 0.18 && shot.aimY < GOAL_H - 0.04;
  const tooWeak = shot.power < 0.16;
  let resultType = inFrame && !tooWeak ? "GOAL" : "MISS";

  const keeperX = dive * 2.78;
  const keeperY = shot.aimY > 1.35 ? 1.48 : 0.72;
  const distanceToKeeper = Math.hypot(shot.finalX - keeperX, shot.aimY - keeperY);
  const sameLane = shot.direction === dive;

  const baseReach = sameLane ? 1.04 : 0.52;
  const weakBonus = (1 - shot.power) * 0.55;
  const centerBonus = Math.abs(shot.finalX) < 0.72 ? 0.3 : 0;
  const keeperReach = baseReach + weakBonus + centerBonus;

  if (resultType === "GOAL" && sameLane && distanceToKeeper <= keeperReach) {
    resultType = "SAVED";
  }

  const goal = resultType === "GOAL";
  if (goal) room.score[shooterId]++;

  io.to(room.id).emit("turnResult", {
    roomId: room.id,
    goal,
    resultType,
    shooterId,
    keeperId,
    shot,
    dive,
    keeperReach,
    score: { ...room.score },
    turn: room.turn,
    maxTurns: room.maxTurns
  });

  setTimeout(() => {
    if (!rooms.has(room.id)) return;

    room.choices = {};
    room.turn++;
    room.resolving = false;

    if (room.turn > room.maxTurns) {
      const a = room.players[0];
      const b = room.players[1];
      let winnerId = null;
      if (room.score[a] > room.score[b]) winnerId = a;
      if (room.score[b] > room.score[a]) winnerId = b;

      io.to(room.id).emit("matchEnd", {
        roomId: room.id,
        score: { ...room.score },
        winnerId
      });

      for (const id of room.players) {
        const s = getSocket(id);
        if (s && s.data.roomId === room.id) s.data.roomId = null;
      }
      rooms.delete(room.id);
      return;
    }

    room.shooterIndex = 1 - room.shooterIndex;

    io.to(room.id).emit("nextTurn", {
      roomId: room.id,
      turn: room.turn,
      score: { ...room.score },
      shooterId: room.players[room.shooterIndex]
    });
  }, 3000);
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  updateSocketProfile(socket, {});

  socket.on("findFunMatch", (data = {}) => {
    updateSocketProfile(socket, data);

    // If this browser was already in a room and reconnected, recover instead of creating a bad duplicate.
    const recoverableRoom = findRoomByClientId(socket.data.clientId);
    if (recoverableRoom) {
      const oldId = recoverableRoom.players.find((id) => recoverableRoom.clientIds[id] === socket.data.clientId);
      replaceSocketInRoom(recoverableRoom, oldId, socket);
      socket.emit("recoveredRoom", payloadFor(recoverableRoom, socket.id));
      emitMatchPayload(recoverableRoom, "forceStartMatch");
      return;
    }

    // A new search is always clean: remove this socket from old waiting/rooms first.
    leaveAllGameRooms(socket, false);

    const waiting = waitingSocketId ? getSocket(waitingSocketId) : null;
    if (!waiting || !waiting.connected || waiting.id === socket.id) {
      waitingSocketId = socket.id;
      socket.emit("waitingForPlayer", {
        message: "Waiting for another player",
        searchId: socket.data.searchId
      });
      socket.emit("serverNotice", { message: "Waiting for another player. Open a second tab to test." });
      return;
    }

    waitingSocketId = null;
    makeRoom(waiting, socket);
  });

  socket.on("getMyRoom", (data = {}) => {
    updateSocketProfile(socket, data);
    let roomId = socket.data.roomId;
    let room = roomId ? rooms.get(roomId) : null;
    if ((!room || !room.players.includes(socket.id)) && socket.data.clientId) {
      room = findRoomByClientId(socket.data.clientId);
      if (room) {
        const oldId = room.players.find((id) => room.clientIds[id] === socket.data.clientId);
        replaceSocketInRoom(room, oldId, socket);
      }
    }
    if (!room || !room.players.includes(socket.id)) {
      socket.emit("serverNotice", { message: "No room assigned yet", searchId: cleanSearchId(data.searchId || socket.data.searchId) });
      return;
    }
    socket.emit("myRoom", payloadFor(room, socket.id));
  });

  socket.on("recoverRoom", (data = {}) => {
    updateSocketProfile(socket, data);
    const room = findRoomByClientId(socket.data.clientId);
    if (!room) {
      socket.emit("roomJoinFailed", { reason: "Could not recover room. Start a new match." });
      return;
    }
    const oldId = room.players.find((id) => room.clientIds[id] === socket.data.clientId);
    replaceSocketInRoom(room, oldId, socket);
    socket.emit("recoveredRoom", payloadFor(room, socket.id));
    emitMatchPayload(room, "forceStartMatch");
    for (const opponentId of room.players.filter((id) => id !== socket.id)) {
      const opp = getSocket(opponentId);
      if (opp) opp.emit("opponentReconnected", { roomId: room.id });
    }
  });

  socket.on("clientReady", (data = {}) => {
    const room = rooms.get(data.roomId);
    if (!room || !room.players.includes(socket.id)) return;
    room.ready[socket.id] = true;
    maybeStopReliableStart(room);
  });

  socket.on("updateProfile", (data = {}) => {
    updateSocketProfile(socket, data);
    if (waitingSocketId === socket.id) {
      socket.emit("serverNotice", { message: "Profile updated while waiting." });
    }
    for (const room of rooms.values()) {
      if (room.players.includes(socket.id)) {
        room.names[socket.id] = socket.data.name;
        room.teams[socket.id] = socket.data.team;
        room.profiles[socket.id] = socket.data.profile;
      }
    }
  });

  socket.on("cancelMatchmaking", () => {
    removeWaiting(socket, true);
  });

  socket.on("leaveMatch", () => {
    leaveAllGameRooms(socket, true);
  });

  socket.on("shotChoice", (data = {}) => {
    const room = rooms.get(data.roomId);
    if (!room || room.resolving) return;

    const shooterId = room.players[room.shooterIndex];
    if (socket.id !== shooterId) return;

    const aimNorm = clampNumber(data.aimNorm, -1, 1, NaN);
    const power = clampNumber(data.power, 0, 1, NaN);
    const precision = clampNumber(data.precision, 0, 1, NaN);
    if (!Number.isFinite(aimNorm) || !Number.isFinite(power) || !Number.isFinite(precision)) return;

    room.choices[socket.id] = {
      ...room.choices[socket.id],
      shot: computeShotTarget(aimNorm, power, precision)
    };

    io.to(room.id).emit("choiceLocked", {
      roomId: room.id,
      playerId: socket.id,
      role: "shooter"
    });

    resolveTurn(room);
  });

  socket.on("diveChoice", (data = {}) => {
    const room = rooms.get(data.roomId);
    if (!room || room.resolving) return;

    const keeperId = room.players[1 - room.shooterIndex];
    if (socket.id !== keeperId) return;

    const direction = Number(data.direction);
    if (!VALID_DIRECTIONS.has(direction)) return;

    room.choices[socket.id] = {
      ...room.choices[socket.id],
      dive: direction
    };

    io.to(room.id).emit("choiceLocked", {
      roomId: room.id,
      playerId: socket.id,
      role: "keeper"
    });

    resolveTurn(room);
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected:", socket.id, reason);
    scheduleDisconnect(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Penalty Kings multiplayer server v11 reconnect grace running on port", PORT);
});
