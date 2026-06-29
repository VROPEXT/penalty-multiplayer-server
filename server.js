const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");

// =============================================================================
// Penalty Kings multiplayer server v18 - fast choices + stable quit
// Fixes vs v17:
//  - Explicit CORS middleware on Express level (Northflank/HTTP2 sometimes drops
//    preflight headers, causing the client to see "xhr poll error" on connection)
//  - Try/catch around the zombie sweep so a single bad room never crashes the server
//  - More permissive Socket.IO CORS (origin: "*", credentials: false)
// =============================================================================

const app = express();
const server = http.createServer(app);

// v13: explicit CORS for HTTP routes - guarantees the browser sees Access-Control-Allow-Origin
// on every response, including Socket.IO polling requests.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => {
  res.send("Penalty Kings multiplayer server v18 fast choices + stable quit is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "v18",
    rooms: rooms.size,
    waiting: !!waitingSocketId,
    uptime: process.uptime()
  });
});

const io = new Server(server, {
  // v13: more permissive CORS - allow ANY origin without credentials.
  // This works for static HTML, file:// URLs, and CrazyGames sandboxed iframes.
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  },
  // v13: explicit allowEIO3 for backward compat with older clients
  allowEIO3: true,
  // v13: increased maxHttpBufferSize to be safe with bigger payloads
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 60000,
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

// Tunable timing
const RECONNECT_GRACE_MS = 120000;      // v14: keep rooms alive during proxy/browser reconnects
const TURN_CHOICE_TIMEOUT_MS = 12000;   // v18: safety only; BOTH choices resolve immediately
const ZOMBIE_ROOM_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
const ZOMBIE_SWEEP_INTERVAL_MS = 60 * 1000;    // every minute
const RELIABLE_START_RETRIES = 60;      // v14: keep resending start until both clients confirm
const RELIABLE_START_INTERVAL_MS = 500; // v14: reliable start tick

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

function clearTurnTimer(room) {
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function clearAllRoomTimers(room) {
  if (!room) return;
  clearStartTimer(room);
  clearTurnTimer(room);
  if (room.disconnectTimers) {
    for (const id of Object.keys(room.disconnectTimers)) {
      clearTimeout(room.disconnectTimers[id]);
    }
    room.disconnectTimers = {};
  }
}

function roomHasTwoConnectedPlayers(room) {
  if (!room || !Array.isArray(room.players) || room.players.length < 2) return false;
  return room.players.every((id) => {
    const s = getSocket(id);
    return !!(s && s.connected) && !(room.disconnected && room.disconnected[id]);
  });
}

function emitRoomPaused(room, reason = "waiting-reconnect") {
  if (!room) return;
  for (const id of room.players) {
    const s = getSocket(id);
    if (s && s.connected) {
      s.emit("matchPaused", {
        roomId: room.id,
        reason,
        message: "Match paused while a player reconnects."
      });
    }
  }
}

function resumeRoomIfReady(room) {
  if (!room || !rooms.has(room.id)) return;
  if (!room.gameStarted) return;
  if (room.resolving) return;
  const allReady = room.players.every((id) => room.ready[id]);
  if (!allReady) return;
  if (!roomHasTwoConnectedPlayers(room)) return;
  emitMatchPayload(room, "matchReady");
  startTurnTimeout(room);
  console.log("Room resumed after reconnect:", room.id);
}

function deleteRoom(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearAllRoomTimers(room);
  rooms.delete(roomId);
  console.log("Room deleted:", roomId, "reason:", reason || "unspecified");
}

function touchRoom(room) {
  if (room) room.lastActivity = Date.now();
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

function findPlayerIdByClientId(room, clientId) {
  if (!room || !clientId || !room.clientIds) return null;
  return room.players.find((id) => room.clientIds[id] === clientId) || null;
}

function attachSocketToRoomByClientId(room, socket, data = {}, preferredOldId = null) {
  if (!room || !socket) return false;
  updateSocketProfile(socket, data);
  if (room.players.includes(socket.id)) return true;
  const clientId = cleanClientId(data.clientId || socket.data.clientId);
  let oldId = null;
  if (preferredOldId && room.clientIds && room.clientIds[preferredOldId] === clientId) oldId = preferredOldId;
  if (!oldId) oldId = findPlayerIdByClientId(room, clientId);
  if (!oldId) return false;
  replaceSocketInRoom(room, oldId, socket);
  console.log("Recovered socket by clientId:", room.id, oldId, "->", socket.id);
  return room.players.includes(socket.id);
}

function getRoomForSocketOrClient(data = {}, socket) {
  updateSocketProfile(socket, data);
  let room = data.roomId ? rooms.get(data.roomId) : null;
  if (!room && socket.data.clientId) room = findRoomByClientId(socket.data.clientId);
  if (room && !room.players.includes(socket.id)) {
    attachSocketToRoomByClientId(room, socket, data);
  }
  return room;
}

function getRoomByRoomIdOrClient(data = {}, socket) {
  updateSocketProfile(socket, data);
  let room = data.roomId ? rooms.get(String(data.roomId)) : null;
  if (!room && socket.data.clientId) room = findRoomByClientId(socket.data.clientId);
  return room || null;
}

function resolvePlayerInRoom(room, socket, data = {}, expectedId = null) {
  if (!room || !socket) return null;
  updateSocketProfile(socket, data);
  const cid = socket.data.clientId;

  if (room.players.includes(socket.id)) {
    clearDisconnectTimer(room, socket.id);
    room.clientIds[socket.id] = cid;
    room.names[socket.id] = socket.data.name;
    room.teams[socket.id] = socket.data.team;
    room.profiles[socket.id] = socket.data.profile;
    socket.join(room.id);
    socket.data.roomId = room.id;
    return socket.id;
  }

  let oldId = null;
  if (expectedId && room.clientIds && room.clientIds[expectedId] === cid) oldId = expectedId;
  if (!oldId) oldId = findPlayerIdByClientId(room, cid);
  if (!oldId) return null;

  replaceSocketInRoom(room, oldId, socket);
  return socket.id;
}

function leaveRoomsByClientId(clientId, notifySelfSocket = null, reason = "client-new-match") {
  if (!clientId) return;
  for (const [roomId, room] of Array.from(rooms.entries())) {
    const playerId = findPlayerIdByClientId(room, clientId);
    if (!playerId) continue;
    for (const opponentId of room.players.filter((id) => id !== playerId)) {
      const opp = getSocket(opponentId);
      if (opp) opp.emit("opponentLeft", { roomId, playerId, reason });
    }
    deleteRoom(roomId, reason);
    if (notifySelfSocket) notifySelfSocket.emit("leftMatch", { roomId });
  }
}

function rejectChoice(socket, room, reason, extra = {}) {
  socket.emit("choiceRejected", {
    roomId: room ? room.id : (extra.roomId || null),
    reason,
    ...extra
  });
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
  // v18: choices are also stored by stable clientId, so a socket swap cannot make the
  // server wait until the timeout even though both browsers already locked.
  const stableCid = room.clientIds[newSocket.id] || cleanClientId(newSocket.data.clientId);
  if (stableCid && room.choicesByClient && room.choicesByClient[stableCid]) {
    room.choices[newSocket.id] = { ...(room.choices[newSocket.id] || {}), ...(room.choicesByClient[stableCid] || {}) };
  }
  clearDisconnectTimer(room, oldId);
  newSocket.join(room.id);
  newSocket.data.roomId = room.id;
  touchRoom(room);
  resumeRoomIfReady(room);
}

function scheduleDisconnect(socket, reason = "") {
  removeWaiting(socket, false);
  const roomId = socket.data.roomId;
  const room = roomId ? rooms.get(roomId) : null;
  if (!room || !room.players.includes(socket.id)) return;

  // v14: a Socket.IO "transport close" can happen while the tab is still alive.
  // Do NOT immediately delete the room. Keep it alive and let the client recover.
  room.disconnected[socket.id] = { at: Date.now(), reason: String(reason || "") };
  touchRoom(room);
  // v15: pause gameplay timers immediately. Do not auto-resolve turns while a
  // browser/proxy connection is recovering, otherwise the match can finish while
  // players are looking at a reconnect/lobby state.
  clearTurnTimer(room);
  emitRoomPaused(room, "socket-disconnect");

  for (const opponentId of room.players.filter((id) => id !== socket.id)) {
    const opp = getSocket(opponentId);
    if (opp) {
      opp.emit("opponentConnectionLost", {
        roomId: room.id,
        playerId: socket.id,
        reason: String(reason || "transport-close"),
        graceMs: RECONNECT_GRACE_MS
      });
    }
  }

  clearDisconnectTimer(room, socket.id);
  room.disconnectTimers[socket.id] = setTimeout(() => {
    const latest = rooms.get(room.id);
    if (!latest || !latest.players.includes(socket.id)) return;

    // v14: only a deliberate client namespace disconnect is treated as a real leave.
    // Network/proxy transport closes only keep the room in a reconnecting state.
    const stored = latest.disconnected && latest.disconnected[socket.id];
    const storedReason = stored && stored.reason ? String(stored.reason) : String(reason || "");
    if (storedReason === "client namespace disconnect" && socket.data._manualLeave === true) {
      for (const opponentId of latest.players.filter((id) => id !== socket.id)) {
        const opp = getSocket(opponentId);
        if (opp) opp.emit("opponentLeft", { roomId: latest.id, playerId: socket.id, reason: "manual-disconnect" });
      }
      deleteRoom(latest.id, "manual-disconnect-expired");
      return;
    }

    // Keep the match open instead of forcing lobby. The active client can continue
    // seeing a reconnect message or quit manually.
    for (const opponentId of latest.players.filter((id) => id !== socket.id)) {
      const opp = getSocket(opponentId);
      if (opp) {
        opp.emit("opponentConnectionLost", {
          roomId: latest.id,
          playerId: socket.id,
          reason: "reconnect-grace-expired-but-room-kept",
          graceMs: 0,
          keepRoom: true
        });
      }
    }
    if (latest.disconnectTimers) delete latest.disconnectTimers[socket.id];
    touchRoom(latest);
  }, RECONNECT_GRACE_MS);
}
function leaveAllGameRooms(socket, notifySelf = false) {
  removeWaiting(socket, notifySelf);

  for (const [roomId, room] of rooms.entries()) {
    if (!room.players.includes(socket.id)) continue;

    const opponents = room.players.filter((id) => id !== socket.id);
    for (const opponentId of opponents) {
      io.to(opponentId).emit("opponentLeft", { roomId, playerId: socket.id, reason: "manual-leave" });
    }

    socket.leave(roomId);
    if (socket.data.roomId === roomId) socket.data.roomId = null;
    deleteRoom(roomId, "leave-all-game-rooms");

    if (notifySelf) socket.emit("leftMatch", { roomId });
  }
}

function payloadFor(room, socketId) {
  const opponentId = room.players.find((id) => id !== socketId) || null;
  const shooterId = room.players[room.shooterIndex];
  const keeperId = room.players[1 - room.shooterIndex];
  const clientIds = { ...(room.clientIds || {}) };
  return {
    roomId: room.id,
    youId: socketId,
    opponentId,
    players: room.players.slice(),
    names: { ...room.names },
    teams: { ...room.teams },
    profiles: { ...room.profiles },
    clientIds,
    searchIds: { ...room.searchIds },
    yourSearchId: room.searchIds[socketId] || null,
    yourClientId: clientIds[socketId] || null,
    youClientId: clientIds[socketId] || null,
    opponentClientId: opponentId ? (clientIds[opponentId] || null) : null,
    score: { ...room.score },
    turn: room.turn,
    maxTurns: room.maxTurns,
    shooterId,
    keeperId,
    shooterClientId: clientIds[shooterId] || null,
    keeperClientId: clientIds[keeperId] || null,
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

function startTurnTimeout(room) {
  if (!room) return;
  clearTurnTimer(room);

  // v15: do not run the countdown unless both current sockets are connected.
  // This is the main fix for matches continuing server-side while clients are gone.
  if (!roomHasTwoConnectedPlayers(room)) {
    console.log("Turn timer paused waiting reconnect in room:", room.id);
    emitRoomPaused(room, "waiting-reconnect");
    return;
  }

  room.turnTimer = setTimeout(() => {
    if (!rooms.has(room.id)) return;
    if (!roomHasTwoConnectedPlayers(room)) {
      console.log("Turn auto-resolve skipped; player reconnecting in room:", room.id);
      clearTurnTimer(room);
      emitRoomPaused(room, "waiting-reconnect");
      return;
    }
    // Auto-resolve missing choices with safe defaults so the match never freezes
    // only when both players are actually connected.
    const shooterId = room.players[room.shooterIndex];
    const keeperId = room.players[1 - room.shooterIndex];
    if (!hasChoiceForPlayer(room, shooterId, 'shot')) {
      setChoiceForPlayer(room, shooterId, 'shot', computeShotTarget(0, 0.10, 0.10));
    }
    if (!hasChoiceForPlayer(room, keeperId, 'dive')) {
      setChoiceForPlayer(room, keeperId, 'dive', 0);
    }
    console.log("Turn auto-resolved due to timeout in room:", room.id);
    resolveTurn(room);
  }, TURN_CHOICE_TIMEOUT_MS);
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
    choicesByClient: {},
    choiceTurns: {},
    ready: {},
    gameStarted: false,
    resolving: false,
    startEmitCount: 0,
    startTimer: null,
    turnTimer: null,
    disconnected: {},
    disconnectTimers: {},
    lastActivity: Date.now()
  };

  rooms.set(roomId, room);
  playerA.join(roomId);
  playerB.join(roomId);
  playerA.data.roomId = roomId;
  playerB.data.roomId = roomId;

  console.log("Room created:", roomId, room.names);

  // v12: emit matchFound ONCE up front, then schedule at most RELIABLE_START_RETRIES
  // safety re-emits ONLY if a client has not confirmed it via clientReady.
  // This eliminates the 5.6-second-long start spam in v11.
  emitMatchPayload(room, "matchFound");
  room.startTimer = setInterval(() => {
    if (!rooms.has(roomId)) {
      clearStartTimer(room);
      return;
    }
    room.startEmitCount++;
    // Only re-send to clients that have not confirmed ready
    for (const id of room.players) {
      if (room.ready[id]) continue;
      const s = getSocket(id);
      if (s && s.connected) s.emit("matchFound", payloadFor(room, id));
    }
    maybeStopReliableStart(room);
    if (room.startEmitCount >= RELIABLE_START_RETRIES) clearStartTimer(room);
  }, RELIABLE_START_INTERVAL_MS);

  // v14: do NOT start turn timeout yet. Wait until both browsers send clientReady.
}


function choiceForPlayer(room, playerId, key) {
  if (!room || !playerId) return undefined;
  const direct = room.choices && room.choices[playerId] ? room.choices[playerId][key] : undefined;
  if (direct !== undefined) return direct;
  const cid = room.clientIds && room.clientIds[playerId];
  const byCid = cid && room.choicesByClient && room.choicesByClient[cid] ? room.choicesByClient[cid][key] : undefined;
  if (byCid !== undefined) return byCid;
  return undefined;
}

function setChoiceForPlayer(room, playerId, key, value) {
  if (!room || !playerId) return;
  room.choices[playerId] = { ...(room.choices[playerId] || {}), [key]: value };
  const cid = room.clientIds && room.clientIds[playerId];
  if (cid) {
    room.choicesByClient = room.choicesByClient || {};
    room.choicesByClient[cid] = { ...(room.choicesByClient[cid] || {}), [key]: value, turn: room.turn };
  }
  room.choiceTurns = room.choiceTurns || {};
  room.choiceTurns[playerId] = room.turn;
}

function hasChoiceForPlayer(room, playerId, key) {
  return choiceForPlayer(room, playerId, key) !== undefined;
}

function emitChoiceLockedFast(room, playerId, role) {
  if (!room || !rooms.has(room.id)) return;
  const shooterId = room.players[room.shooterIndex];
  const keeperId = room.players[1 - room.shooterIndex];
  const bothLocked = !!choiceForPlayer(room, shooterId, 'shot') && choiceForPlayer(room, keeperId, 'dive') !== undefined;
  io.to(room.id).emit("choiceLocked", {
    roomId: room.id,
    playerId,
    clientId: room.clientIds[playerId] || null,
    role,
    turn: room.turn,
    bothLocked,
    shooterClientId: room.clientIds[shooterId] || null,
    keeperClientId: room.clientIds[keeperId] || null
  });
  if (bothLocked) {
    io.to(room.id).emit("bothChoicesLocked", {
      roomId: room.id,
      turn: room.turn,
      message: "Both choices locked. Resolving now."
    });
  }
}

function resolveTurn(room) {
  if (!room || room.resolving) return;

  const shooterId = room.players[room.shooterIndex];
  const keeperId = room.players[1 - room.shooterIndex];
  const shot = choiceForPlayer(room, shooterId, 'shot');
  const dive = choiceForPlayer(room, keeperId, 'dive');

  if (!shot || dive === undefined) return;

  room.resolving = true;
  clearStartTimer(room);
  clearTurnTimer(room);
  touchRoom(room);

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
    shooterClientId: room.clientIds[shooterId] || null,
    keeperClientId: room.clientIds[keeperId] || null,
    clientIds: { ...room.clientIds },
    shot,
    dive,
    keeperReach,
    score: { ...room.score },
    turn: room.turn,
    maxTurns: room.maxTurns
  });

  setTimeout(() => {
    // v12 SAFETY: if the room was deleted during the 3s wait (quit, disconnect),
    // do NOT try to emit anything further. The room is gone.
    if (!rooms.has(room.id)) return;

    room.choices = {};
    room.choicesByClient = {};
    room.choiceTurns = {};
    room.turn++;
    room.resolving = false;
    touchRoom(room);

    if (room.turn > room.maxTurns) {
      const a = room.players[0];
      const b = room.players[1];
      let winnerId = null;
      if (room.score[a] > room.score[b]) winnerId = a;
      if (room.score[b] > room.score[a]) winnerId = b;

      io.to(room.id).emit("matchEnd", {
        roomId: room.id,
        score: { ...room.score },
        winnerId,
        winnerClientId: winnerId ? (room.clientIds[winnerId] || null) : null,
        clientIds: { ...room.clientIds }
      });

      for (const id of room.players) {
        const s = getSocket(id);
        if (s && s.data.roomId === room.id) s.data.roomId = null;
      }
      deleteRoom(room.id, "match-end-natural");
      return;
    }

    room.shooterIndex = 1 - room.shooterIndex;

    io.to(room.id).emit("nextTurn", {
      roomId: room.id,
      turn: room.turn,
      score: { ...room.score },
      shooterId: room.players[room.shooterIndex],
      shooterClientId: room.clientIds[room.players[room.shooterIndex]] || null,
      clientIds: { ...room.clientIds }
    });

    // Start choice timeout for next turn
    startTurnTimeout(room);
  }, 3000);
}

// =============================================================================
// v12: Zombie room sweeper - clean up rooms that have not had activity for 5min
// v13: wrapped in try/catch so a bad room can never crash the whole server
// =============================================================================
setInterval(() => {
  try {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
      try {
        const idle = now - (room.lastActivity || 0);
        if (idle > ZOMBIE_ROOM_TIMEOUT_MS) {
          console.log("Zombie room sweep: cleaning up room", roomId, "idle for", idle, "ms");
          for (const id of room.players) {
            const s = getSocket(id);
            if (s) s.emit("opponentLeft", { roomId, reason: "zombie-room" });
          }
          deleteRoom(roomId, "zombie-sweep");
        }
      } catch (innerErr) {
        console.error("[zombie-sweep] error on room", roomId, innerErr);
      }
    }
  } catch (outerErr) {
    console.error("[zombie-sweep] outer error", outerErr);
  }
}, ZOMBIE_SWEEP_INTERVAL_MS);

// v13: global uncaught error handlers so a bad code path never silently kills the server
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  updateSocketProfile(socket, {});

  socket.on("findFunMatch", (data = {}) => {
    updateSocketProfile(socket, data);

    // v17: PLAY AGAINST OTHER means NEW match. Do not recover an old room here.
    // Refresh/reconnect uses recoverRoom instead. This fixes skin/profile changes
    // causing one browser to be stuck rejoining an old hidden room.
    if (data.newMatch === true) {
      leaveRoomsByClientId(socket.data.clientId, null, "new-match-request");
    }
    leaveAllGameRooms(socket, false);

    let waiting = waitingSocketId ? getSocket(waitingSocketId) : null;
    if (waiting && waiting.data && waiting.data.clientId === socket.data.clientId) {
      waitingSocketId = null;
      waiting = null;
    }

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
        resumeRoomIfReady(room);
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
    let room = getRoomByRoomIdOrClient(data, socket);
    if (!room || !findPlayerIdByClientId(room, socket.data.clientId)) {
      socket.emit("roomJoinFailed", { reason: "Could not recover room. Start a new match.", resumeFailed: !!data.resume });
      return;
    }
    resolvePlayerInRoom(room, socket, data);
    socket.emit("recoveredRoom", payloadFor(room, socket.id));
    socket.emit("matchReady", payloadFor(room, socket.id));
    resumeRoomIfReady(room);
    for (const opponentId of room.players.filter((id) => id !== socket.id)) {
      const opp = getSocket(opponentId);
      if (opp) opp.emit("opponentReconnected", { roomId: room.id });
    }
  });

  socket.on("clientReady", (data = {}) => {
    const room = getRoomForSocketOrClient(data, socket);
    const playerId = resolvePlayerInRoom(room, socket, data);
    if (!room || !playerId || !room.players.includes(playerId)) return;
    room.ready[playerId] = true;
    touchRoom(room);

    // Always refresh this player with the authoritative payload.
    socket.emit("matchReady", payloadFor(room, socket.id));
    maybeStopReliableStart(room);

    // v14: start the actual turn timer only when BOTH clients confirmed the arena loaded.
    const allReady = room.players.every((id) => room.ready[id]);
    if (allReady && !room.gameStarted) {
      room.gameStarted = true;
      emitMatchPayload(room, "matchReady");
      if (roomHasTwoConnectedPlayers(room)) {
        startTurnTimeout(room);
        console.log("Room ready, gameplay timer started:", room.id);
      } else {
        emitRoomPaused(room, "waiting-reconnect-before-start");
        console.log("Room ready but timer paused until reconnect:", room.id);
      }
    } else if (allReady && room.gameStarted) {
      resumeRoomIfReady(room);
    }
  });

  socket.on("updateProfile", (data = {}) => {
    updateSocketProfile(socket, data);
    if (waitingSocketId === socket.id) {
      socket.emit("serverNotice", { message: "Profile updated while waiting." });
    }
    for (const room of rooms.values()) {
      const playerId = room.players.includes(socket.id) ? socket.id : findPlayerIdByClientId(room, socket.data.clientId);
      if (playerId) {
        room.names[playerId] = socket.data.name;
        room.teams[playerId] = socket.data.team;
        room.profiles[playerId] = socket.data.profile;
        room.clientIds[playerId] = socket.data.clientId;
        touchRoom(room);
        emitMatchPayload(room, "matchReady");
      }
    }
  });

  socket.on("cancelMatchmaking", () => {
    removeWaiting(socket, true);
  });

  socket.on("leaveMatch", (data = {}) => {
    updateSocketProfile(socket, data);
    const room = getRoomByRoomIdOrClient(data, socket);
    if (room) resolvePlayerInRoom(room, socket, data);
    socket.data._manualLeave = true;
    leaveAllGameRooms(socket, true);
    leaveRoomsByClientId(socket.data.clientId, socket, "manual-leave");
  });

  socket.on("shotChoice", (data = {}) => {
    const room = getRoomForSocketOrClient(data, socket);
    if (!room) return rejectChoice(socket, null, "room-not-found", { roomId: data.roomId || null });
    if (room.resolving) return;

    let shooterId = room.players[room.shooterIndex];
    const playerId = resolvePlayerInRoom(room, socket, data, shooterId);
    shooterId = room.players[room.shooterIndex];
    if (playerId !== shooterId) {
      return rejectChoice(socket, room, "not-current-shooter", {
        expectedRole: "shooter",
        expectedPlayerId: shooterId,
        expectedClientId: room.clientIds[shooterId] || null,
        yourSocketId: socket.id,
        yourClientId: socket.data.clientId
      });
    }

    const aimNorm = clampNumber(data.aimNorm, -1, 1, NaN);
    const power = clampNumber(data.power, 0, 1, NaN);
    const precision = clampNumber(data.precision, 0, 1, NaN);
    if (!Number.isFinite(aimNorm) || !Number.isFinite(power) || !Number.isFinite(precision)) {
      return rejectChoice(socket, room, "bad-shot-payload", { expectedRole: "shooter" });
    }

    setChoiceForPlayer(room, shooterId, "shot", computeShotTarget(aimNorm, power, precision));
    touchRoom(room);

    emitChoiceLockedFast(room, shooterId, "shooter");

    // v18: do not wait for the timeout/retry loop. As soon as both stable-clientId
    // choices are present, resolve immediately on the same tick.
    resolveTurn(room);
  });

  socket.on("diveChoice", (data = {}) => {
    const room = getRoomForSocketOrClient(data, socket);
    if (!room) return rejectChoice(socket, null, "room-not-found", { roomId: data.roomId || null });
    if (room.resolving) return;

    let keeperId = room.players[1 - room.shooterIndex];
    const playerId = resolvePlayerInRoom(room, socket, data, keeperId);
    keeperId = room.players[1 - room.shooterIndex];
    if (playerId !== keeperId) {
      return rejectChoice(socket, room, "not-current-keeper", {
        expectedRole: "keeper",
        expectedPlayerId: keeperId,
        expectedClientId: room.clientIds[keeperId] || null,
        yourSocketId: socket.id,
        yourClientId: socket.data.clientId
      });
    }

    const direction = Number(data.direction);
    if (!VALID_DIRECTIONS.has(direction)) {
      return rejectChoice(socket, room, "bad-dive-payload", { expectedRole: "keeper" });
    }

    setChoiceForPlayer(room, keeperId, "dive", direction);
    touchRoom(room);

    emitChoiceLockedFast(room, keeperId, "keeper");

    // v18: do not wait for the timeout/retry loop. As soon as both stable-clientId
    // choices are present, resolve immediately on the same tick.
    resolveTurn(room);
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected:", socket.id, reason);
    scheduleDisconnect(socket, reason);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Penalty Kings multiplayer server v18 fast choices + stable quit running on port", PORT);
});
