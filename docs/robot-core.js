"use strict";

// Núcleo sin interfaz: equivalente BLE de server/main.py del proyecto general.
// Valida, guarda los datos en el navegador y envía órdenes al firmware.
// El firmware no informa cuándo termina un movimiento con rapidez suficiente por BLE,
// así que el núcleo modela cada trayectoria (distancia / velocidad, igual que el firmware)
// y corrige el modelo con cada estado que llega.

const MAX_STEPS = 200;
const MAX_REPEAT = 1000;
const MAX_WAIT_S = 60;
const BLE_COMMAND_LIMIT = 95;
const BURST_GAP_MS = 40;
const STEP_KEYS = new Set(["pose", "pose_all", "pose_parallel", "stance_offset", "speed", "mirror", "center",
  "release", "wait", "wait_done", "eyes", "face", "text", "relative_move", "relative_parallel"]);
const MOOD_TO_FACE = { NORMAL: "normal", HAPPY: "feliz", CONTENTO: "feliz", SAD: "triste", ANGRY: "enojado",
  SLEEP: "dormido", SUENO: "dormido", SURPRISED: "sorprendido" };
const WALK_LEG_ORDER = ["R1", "L2", "R2", "L1"];
const LEG_OF = { R1: "R1", R3: "R1", L1: "L1", L3: "L1", R2: "R2", R4: "R2", L2: "L2", L4: "L2" };

class RobotError extends Error {}
class Cancelled extends Error {}
const fail = (message) => { throw new RobotError(message); };

// ---------- utilidades ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round1 = (value) => Math.round(value * 10) / 10;
const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const fmt = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const now = () => performance.now();

function asciiFold(text) {
  return String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "");
}
function slug(name) {
  return asciiFold(name).trim().toLowerCase().replace(/\s+/g, "_");
}

// ---------- almacenamiento ----------
const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};
const KEY_FACES = "spider-ble-faces";
const KEY_ROUTINES = "spider-ble-routines";
const KEY_PROGRAMS = "spider-ble-programs";
const KEY_LAST_ROBOT = "spider-ble-last-robot";
const robotKey = (id) => `spider-ble-robot:${id}`;

// ---------- estado ----------
const robot = {
  id: "default",
  profile: null,
  faces: {},
  routines: {},
  programs: {},
  telemetry: {},      // n -> {cur, tgt, en, pwm, at}
  motion: {},         // n -> {from, to, t0, commandedAt}
  speed: {},          // velocidad vigente en el firmware
  pca: false,
  oled: false,
  fw: "",
  transport: null,    // async (texto) => boolean
  log: [],
  run: { token: 0, status: "idle", name: "", step: 0, total: 0, loop: 0, repeat: 1, error: "" },
  listeners: new Set()
};

function emit(kind) {
  for (const listener of robot.listeners) listener(kind);
}
function onRobot(listener) {
  robot.listeners.add(listener);
}

function defaultRobotProfile() {
  return {
    servos: clone(DEFAULT_SERVO_PROFILE),
    stance: clone(MEASURED_STANDING_POSE), walkLifts: null, walkSwing: null,
    startupPose: clone(MEASURED_REST_POSE),
    autoStance: true, autoStartup: false
  };
}

function loadRobot(id) {
  let saved = storage.get(robotKey(id), null);
  if (!saved && id !== "default") saved = storage.get(robotKey("default"), null); // ediciones hechas antes de conectar
  const base = defaultRobotProfile();
  robot.id = id;
  robot.profile = { ...base, ...(saved || {}) };
  robot.profile.servos = Object.fromEntries(SERVOS.map((n) => {
    const hard = DEFAULT_SERVO_PROFILE[n];
    const prior = saved?.servos?.[n] || {};
    const min = Math.max(hard.min, isNum(prior.min) ? prior.min : hard.min);
    const max = Math.min(hard.max, isNum(prior.max) ? prior.max : hard.max);
    return [n, { ...hard, ...prior,
      min: min < max ? min : hard.min,
      max: min < max ? max : hard.max }];
  }));
  // Perfiles anteriores guardaban stance:null y autoStance:false, aunque este
  // robot ya tiene una postura calibrada. Respetar posturas personalizadas.
  const legacyMeasured = { R1: 71, R2: 77, R3: 40, R4: 46, L1: 90, L2: 90, L3: 44, L4: 40 };
  if (!saved?.stance || SERVOS.every((n) => saved.stance[n] === legacyMeasured[n])) {
    robot.profile.stance = clone(MEASURED_STANDING_POSE);
    if (!saved?.autoStartup) robot.profile.autoStance = true;
  }
  if (!saved?.startupPose) robot.profile.startupPose = clone(MEASURED_REST_POSE);
  storage.set(KEY_LAST_ROBOT, id);
  saveRobot();
}
function saveRobot() {
  storage.set(robotKey(robot.id), robot.profile);
  emit("profile");
}

function loadCatalogs() {
  const faces = storage.get(KEY_FACES, null);
  robot.faces = {};
  for (const [name, face] of Object.entries(faces || DEFAULT_FACES)) {
    try { robot.faces[name] = normalizeFace(face); } catch { /* cara dañada: se omite */ }
  }
  if (!robot.faces.normal) robot.faces.normal = normalizeFace({});
  robot.routines = storage.get(KEY_ROUTINES, null) || clone(DEFAULT_ROUTINES);
  robot.programs = storage.get(KEY_PROGRAMS, {});
}

function initRobot() {
  loadCatalogs();
  loadRobot(storage.get(KEY_LAST_ROBOT, "default"));
}

const cfg = (n) => robot.profile.servos[n];
const hardRange = (n) => DEFAULT_SERVO_PROFILE[n];
function requireServo(n) {
  if (!SERVOS.includes(n)) fail(`Motor desconocido: ${n}`);
}
function inRange(n, angle) {
  return isNum(angle) && angle >= cfg(n).min && angle <= cfg(n).max;
}

// ---------- modelo de movimiento ----------
function firmwareSpeed(n) {
  return robot.speed[n] ?? cfg(n).speed;
}
function estimate(n) {
  const m = robot.motion[n];
  if (!m) return robot.telemetry[n]?.cur ?? null;
  const distance = m.to - m.from;
  const moved = (firmwareSpeed(n) * (now() - m.t0)) / 1000;
  return Math.abs(distance) <= moved ? m.to : m.from + Math.sign(distance) * moved;
}
function target(n) {
  return robot.motion[n]?.to ?? robot.telemetry[n]?.tgt ?? null;
}
function remainingMs(n) {
  const m = robot.motion[n];
  if (!m) return 0;
  return (Math.abs(m.to - estimate(n)) / firmwareSpeed(n)) * 1000;
}
function setTarget(n, angle, instant = false) {
  const t = robot.telemetry[n];
  if (t && !t.en) return; // el firmware ignora motores deshabilitados
  const from = instant ? angle : (estimate(n) ?? angle);
  robot.motion[n] = { from, to: angle, t0: now(), commandedAt: now() };
  if (t) t.pwm = true;
}
function rebase(n) {
  const current = estimate(n);
  if (current !== null) robot.motion[n] = { from: current, to: robot.motion[n]?.to ?? current, t0: now(), commandedAt: robot.motion[n]?.commandedAt ?? 0 };
}
function freezeAll() {
  for (const n of SERVOS) {
    const current = estimate(n);
    if (current !== null) robot.motion[n] = { from: current, to: current, t0: now(), commandedAt: now() };
  }
}

function onHeader(pca, oled, fw) {
  robot.pca = pca;
  robot.oled = oled;
  robot.fw = fw;
  emit("status");
}
function onServoStatus(n, cur, tgt, en, pwm) {
  robot.telemetry[n] = { cur, tgt, en, pwm, at: now() };
  const m = robot.motion[n];
  // Un estado anterior a la última orden podría traer el objetivo viejo.
  if (!m || now() - m.commandedAt > 500) robot.motion[n] = { from: cur, to: tgt, t0: now(), commandedAt: m?.commandedAt ?? 0 };
  emit("status");
}
function resetTelemetry() {
  robot.telemetry = {};
  robot.motion = {};
  robot.speed = {};
  robot.pca = false;
  emit("status");
}

const allReported = () => SERVOS.every((n) => robot.telemetry[n]);
const held = (n) => Boolean(robot.telemetry[n]?.en && robot.telemetry[n]?.pwm);
const settled = (n) => {
  const current = estimate(n);
  const goal = target(n);
  return current !== null && goal !== null && Math.abs(current - goal) <= 1;
};
const ready = (n) => held(n) && settled(n);
const current = (n) => estimate(n);

function requireAllReady(action = "moverse") {
  for (const n of SERVOS) {
    if (!robot.telemetry[n]) fail(`Falta el estado de ${n}; espera a que el robot lo informe.`);
    if (!held(n)) fail(`${n} debe estar activo y sujeto antes de ${action}.`);
    if (!settled(n)) fail(`${n} aún no llega a su posición objetivo.`);
  }
}

// ---------- envío ----------
function logCommand(cmd, source) {
  robot.log.unshift({ t: Date.now(), source, cmd });
  if (robot.log.length > 300) robot.log.length = 300;
  emit("log");
}
async function send(cmd, source = "manual") {
  if (!robot.transport) fail("Conecta el robot antes de enviar órdenes.");
  const size = new TextEncoder().encode(cmd).length;
  if (size > BLE_COMMAND_LIMIT) fail(`Orden demasiado larga para BLE (${size} bytes): ${cmd}`);
  if (!(await robot.transport(cmd))) fail(`No se pudo enviar «${cmd}».`);
  logCommand(cmd, source);
}
async function sendBurst(commands, source) {
  for (const cmd of commands) {
    await send(cmd, source);
    await sleep(BURST_GAP_MS);
  }
}

// ---------- acciones básicas (act_* de main.py) ----------
async function actMove(n, angle, source = "manual") {
  requireServo(n);
  if (!isNum(angle)) fail(`${n}: ángulo inválido.`);
  const value = round1(clamp(angle, cfg(n).min, cfg(n).max));
  await send(`MOVE ${n} ${fmt(value)}`, source);
  setTarget(n, value);
}

async function actPose(angles, source = "manual", hold = false) {
  const values = SERVOS.map((n) => {
    const value = angles[n];
    if (!isNum(value)) fail(`Falta el ángulo de ${n}.`);
    if (hold && !inRange(n, value)) fail(`${n} quedaría fuera de ${cfg(n).min}°–${cfg(n).max}°.`);
    return round1(clamp(value, cfg(n).min, cfg(n).max));
  });
  await send(`${hold ? "POSE_HOLD" : "POSE"} ${values.map(fmt).join(" ")}`, source);
  SERVOS.forEach((n, i) => setTarget(n, values[i], hold));
}

// Varios motores a la vez: una sola orden POSE si los ocho están sujetos (los demás
// conservan su objetivo); si no, MOVE individuales para no activar motores libres.
async function actParallel(desired, source = "manual") {
  const names = Object.keys(desired);
  if (!names.length) return;
  if (SERVOS.every(held)) {
    const pose = Object.fromEntries(SERVOS.map((n) => [n, n in desired ? desired[n] : target(n)]));
    await actPose(pose, source);
  } else {
    for (const n of names) {
      await actMove(n, desired[n], source);
      await sleep(BURST_GAP_MS);
    }
  }
}

async function actMirror(pair, angle, source = "manual") {
  if (!Number.isInteger(pair) || pair < 1 || pair > 4) fail("Par inválido (1–4).");
  const right = SERVOS[pair - 1];
  const left = SERVOS[pair + 3];
  const r = cfg(right);
  const l = cfg(left);
  const rightAngle = clamp(angle, r.min, r.max);
  const normalized = (rightAngle - r.min) / (r.max - r.min);
  const leftAngle = l.max - normalized * (l.max - l.min);
  await send(`MIRROR ${pair} ${fmt(round1(angle))}`, source);
  setTarget(right, rightAngle);
  setTarget(left, leftAngle);
}

async function actAll(angle, source = "manual") {
  if (!isNum(angle) || angle < 0 || angle > 180) fail("Ángulo inválido (0–180).");
  await send(`ALL ${fmt(round1(angle))}`, source);
  for (const n of SERVOS) setTarget(n, clamp(angle, cfg(n).min, cfg(n).max));
}

async function actCenter(source = "manual") {
  await send("CENTER", source);
  for (const n of SERVOS) setTarget(n, clamp(90, cfg(n).min, cfg(n).max));
}

async function actSpeed(n, speed, source = "manual", persist = true) {
  requireServo(n);
  if (!isNum(speed) || speed < 1 || speed > 180) fail("Velocidad inválida (1–180 °/s).");
  const value = round1(speed);
  await send(`SPEED ${n} ${fmt(value)}`, source);
  rebase(n);
  robot.speed[n] = value;
  if (persist) {
    cfg(n).speed = value;
    saveRobot();
  }
}

async function actSpeedAll(speed, source = "manual") {
  for (const n of SERVOS) {
    await actSpeed(n, speed, source, false);
    cfg(n).speed = round1(speed);
    await sleep(BURST_GAP_MS);
  }
  saveRobot();
}

async function actLimits(n, min, max, source = "manual") {
  requireServo(n);
  const hard = hardRange(n);
  if (!isNum(min) || !isNum(max) || min < hard.min || max > hard.max || min >= max) {
    fail(`${n}: el rango debe cumplir ${hard.min} ≤ mínimo < máximo ≤ ${hard.max}.`);
  }
  await send(`LIMIT ${n} ${fmt(min)} ${fmt(max)}`, source);
  cfg(n).min = min;
  cfg(n).max = max;
  if (robot.telemetry[n]) robot.telemetry[n].pwm = false;
  freezeAll();
  saveRobot();
}

async function actInvert(n, inverted, source = "manual") {
  requireServo(n);
  await send(`INVERT ${n} ${inverted ? 1 : 0}`, source);
  if (cfg(n).invert !== inverted && robot.telemetry[n]) robot.telemetry[n].pwm = false;
  cfg(n).invert = inverted;
  saveRobot();
}

async function actVerb(verb, n, source = "manual") {
  requireServo(n);
  await send(`${verb} ${n}`, source);
  const t = robot.telemetry[n];
  if (!t) return;
  if (verb === "FREE") { t.en = false; t.pwm = false; }
  if (verb === "ENABLE") t.en = true;
  const value = estimate(n);
  if (value !== null) robot.motion[n] = { from: value, to: value, t0: now(), commandedAt: now() };
  emit("status");
}

async function actStop(source = "manual") {
  cancelRun();
  await send("STOP", source);
  freezeAll();
}

async function actRelease(source = "manual") {
  cancelRun();
  await send("RELEASE", source);
  for (const t of Object.values(robot.telemetry)) { t.en = false; t.pwm = false; }
  freezeAll();
  emit("status");
}

async function actArm(source = "manual") {
  await send("ARM", source);
  for (const t of Object.values(robot.telemetry)) t.en = true;
  emit("status");
}

function waitForHeld(names, issuedAt, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    let timer;
    const check = () => {
      if (!names.every((n) => robot.telemetry[n]?.at > issuedAt && held(n))) return;
      clearTimeout(timer);
      robot.listeners.delete(check);
      resolve();
    };
    robot.listeners.add(check);
    timer = setTimeout(() => {
      robot.listeners.delete(check);
      const missing = names.filter((n) => !(robot.telemetry[n]?.at > issuedAt && held(n)));
      for (const n of missing) if (robot.telemetry[n]) robot.telemetry[n].pwm = false;
      emit("status");
      reject(new RobotError(`El robot no confirmó la sujeción de ${missing.join(", ")}. Revisa el PCA9685 y vuelve a intentarlo.`));
    }, timeoutMs);
    check();
  });
}

function requireHoldable(names) {
  if (!robot.pca) fail("PCA9685 no detectado; revisa alimentación y cableado antes de sujetar.");
  if (robot.run.status === "running") fail("Detén la rutina antes de sujetar motores.");
  for (const n of names) {
    requireServo(n);
    if (!robot.telemetry[n]) fail(`Espera a recibir el estado de ${n}.`);
    if (!settled(n)) fail(`${n} aún no está quieto.`);
  }
}

async function holdServos(names, source) {
  requireHoldable(names);
  const pending = names.filter((n) => !held(n));
  const token = robot.run.token;
  const issuedAt = now();
  for (const n of pending) {
    if (token !== robot.run.token) fail("Sujeción interrumpida.");
    if (!robot.telemetry[n].en) {
      await actVerb("ENABLE", n, source);
      await sleep(BURST_GAP_MS);
    }
    await actVerb("HOLD", n, source);
    await sleep(BURST_GAP_MS);
  }
  if (token !== robot.run.token) fail("Sujeción interrumpida.");
  // STATUS inicia una ronda de ocho notificaciones; la escritura BLE por sí sola
  // solo confirma que se encoló la orden.
  await send("STATUS", source);
  await waitForHeld(names, issuedAt);
}

async function actHoldOne(n, source = "manual") {
  await holdServos([n], source);
}

async function actHoldAll(source = "manual") {
  if (!allReported()) fail("Espera a recibir el estado de los ocho servos.");
  await holdServos(SERVOS, source);
}

// ---------- perfil del robot ----------
function profileCommands() {
  return SERVOS.flatMap((n) => {
    const c = cfg(n);
    return [`LIMIT ${n} ${fmt(c.min)} ${fmt(c.max)}`, `INVERT ${n} ${c.invert ? 1 : 0}`, `SPEED ${n} ${fmt(c.speed)}`];
  });
}
async function applyProfile(source = "perfil") {
  await sendBurst(profileCommands(), source);
  for (const n of SERVOS) {
    robot.speed[n] = cfg(n).speed;
    if (robot.telemetry[n]) robot.telemetry[n].pwm = false;
  }
  freezeAll();
  emit("status");
}
async function applySpeeds(source = "perfil") {
  for (const n of SERVOS) {
    await send(`SPEED ${n} ${fmt(cfg(n).speed)}`, source);
    rebase(n);
    robot.speed[n] = cfg(n).speed;
    await sleep(BURST_GAP_MS);
  }
}
function saveServoProfile(next) {
  for (const n of SERVOS) {
    const { min, max, speed, invert } = next[n];
    const hard = hardRange(n);
    if (![min, max, speed].every(isNum) || min < hard.min || max > hard.max || min >= max) {
      fail(`${n}: el rango debe cumplir ${hard.min} ≤ mínimo < máximo ≤ ${hard.max}.`);
    }
    if (speed < 1 || speed > 180) fail(`${n}: la velocidad debe estar entre 1 y 180 °/s.`);
    robot.profile.servos[n] = { min, max, speed, invert: Boolean(invert) };
  }
  saveRobot();
}

// Equivale al reinicio del proyecto general: perfil y, si se pidió, postura guardada.
async function recoverOnConnect() {
  const holding = SERVOS.filter(held);
  const p = robot.profile;
  const pose = p.autoStartup && validPose(p.startupPose) ? p.startupPose
    : p.autoStance && validPose(p.stance) ? p.stance : null;
  if (holding.length) {
    await applySpeeds("inicio");
    if (pose && holding.length < SERVOS.length && holding.every((n) =>
      Math.abs(robot.telemetry[n].cur - pose[n]) <= 1 && settled(n))) {
      if (!robot.pca) fail("PCA9685 no detectado; revisa alimentación y cableado.");
      if (SERVOS.some((n) => !robot.telemetry[n]?.en)) await actArm("inicio");
      const issuedAt = now();
      await actPose(pose, "inicio", true);
      await send("STATUS", "inicio");
      await waitForHeld(SERVOS, issuedAt);
      for (const n of SERVOS) {
        const t = robot.telemetry[n];
        if (Math.abs(t.cur - pose[n]) > 1 || Math.abs(t.tgt - pose[n]) > 1) {
          fail(`${n} no confirmó la postura calibrada; revisa el robot antes de iniciar rutinas.`);
        }
      }
      return { applied: false, restored: pose === p.startupPose ? "startup" : "stance" };
    }
    return { applied: false, holding, readyForRoutines: atStance() };
  }
  if (!robot.pca) fail("PCA9685 no detectado; revisa alimentación y cableado.");
  await applyProfile("inicio");
  if (pose) {
    if (SERVOS.some((n) => !robot.telemetry[n]?.en)) await actArm("inicio");
    const issuedAt = now();
    await actPose(pose, "inicio", true);
    await send("STATUS", "inicio");
    await waitForHeld(SERVOS, issuedAt);
    for (const n of SERVOS) {
      const t = robot.telemetry[n];
      if (Math.abs(t.cur - pose[n]) > 1 || Math.abs(t.tgt - pose[n]) > 1) {
        fail(`${n} no confirmó la postura calibrada; revisa el robot antes de iniciar rutinas.`);
      }
    }
    return { applied: true, restored: pose === p.startupPose ? "startup" : "stance" };
  }
  return { applied: true, restored: null };
}

// ---------- caras ----------
function normalizeFace(raw = {}) {
  if (typeof raw !== "object" || raw === null) fail("Cara inválida.");
  const face = {};
  for (const [key, param] of Object.entries(FACE_PARAMS)) {
    const value = Number(raw[key] ?? DEFAULT_FACE[key]);
    if (!Number.isFinite(value)) fail(`${param.label}: valor inválido.`);
    face[key] = clamp(Math.round(value), param.min, param.max);
  }
  for (const key of Object.keys(FACE_FLAGS)) face[key] = raw[key] === undefined ? DEFAULT_FACE[key] : Boolean(raw[key]);
  for (const side of ["left", "right"]) {
    const override = raw[side];
    if (!override || !Object.keys(override).length) continue;
    face[side] = {};
    for (const [key, value] of Object.entries(override)) {
      if (!EYE_KEYS.includes(key)) fail(`Parámetro de ojo desconocido: ${key}`);
      const param = FACE_PARAMS[key];
      face[side][key] = clamp(Math.round(Number(value)), param.min, param.max);
    }
  }
  return face;
}

function getFace(name) {
  const face = robot.faces[slug(name)];
  if (!face) fail(`No existe la cara «${name}».`);
  return face;
}

// "feliz" | {name, transition_ms, duration_ms, ...cambios}
function parseFaceSpec(spec) {
  if (typeof spec === "string") return { face: getFace(spec), transition: 250, duration: 0 };
  if (typeof spec !== "object" || spec === null) fail("Cara inválida.");
  const { name, transition_ms: transition = 250, duration_ms: duration = 0, ...changes } = spec;
  const base = name ? getFace(name) : DEFAULT_FACE;
  const merged = { ...base, ...changes };
  for (const side of ["left", "right"]) {
    if (base[side] || changes[side]) merged[side] = { ...(base[side] || {}), ...(changes[side] || {}) };
  }
  if (!isNum(transition) || transition < 0 || transition > 5000) fail("Transición inválida (0–5000 ms).");
  if (!isNum(duration) || duration < 0 || duration > 600000) fail("Duración inválida (0–600000 ms).");
  return { face: normalizeFace(merged), transition: Math.round(transition), duration: Math.round(duration) };
}

// Envía la cara completa; los cambios de un solo ojo van en órdenes FACE aparte si no caben.
function faceCommands(face, transition = 250, duration = 0) {
  const head = `FACE T=${transition} D=${duration}`;
  const main = [head];
  for (const [key, param] of Object.entries(FACE_PARAMS)) main.push(`${param.code}=${face[key]}`);
  for (const [key, flag] of Object.entries(FACE_FLAGS)) main.push(`${flag.code}=${face[key] ? 1 : 0}`);
  const commands = [main.join(" ")];
  let extra = head;
  for (const [prefix, side] of [["L.", "left"], ["R.", "right"]]) {
    for (const [key, value] of Object.entries(face[side] || {})) {
      const token = `${prefix}${FACE_PARAMS[key].code}=${value}`;
      if (extra.length + token.length + 1 > BLE_COMMAND_LIMIT) {
        commands.push(extra);
        extra = head;
      }
      extra += ` ${token}`;
    }
  }
  if (extra !== head) commands.push(extra);
  return commands;
}

async function actFace(spec, source = "manual") {
  const { face, transition, duration } = parseFaceSpec(spec);
  await sendBurst(faceCommands(face, transition, duration), source);
}

async function actText(text, durationMs = 3000, source = "manual") {
  const message = asciiFold(text).trim().slice(0, 21);
  if (!isNum(durationMs) || durationMs < 0) fail("Duración inválida.");
  await send(message ? `TEXT ${Math.round(durationMs)} ${message}` : "TEXT 0", source);
}

function saveFace(name, raw) {
  const key = slug(name);
  if (!key || key.length > 40) fail("Usa un nombre de 1–40 caracteres.");
  robot.faces[key] = normalizeFace(raw);
  storage.set(KEY_FACES, robot.faces);
  emit("catalog");
  return key;
}
function deleteFace(name) {
  const key = slug(name);
  if (key === "normal") fail("La cara «normal» no se puede borrar.");
  delete robot.faces[key];
  storage.set(KEY_FACES, robot.faces);
  emit("catalog");
}

// ---------- posturas ----------
function validPose(pose) {
  return Boolean(pose) && SERVOS.every((n) => inRange(n, pose[n]));
}

function getStance(requireReady = false) {
  const stance = robot.profile.stance;
  if (!stance || !SERVOS.every((n) => isNum(stance[n]))) fail("Guarda primero la postura de apoyo de los ocho motores.");
  for (const n of SERVOS) {
    if (!inRange(n, stance[n])) fail(`La postura guardada de ${n} ya no cabe en su rango.`);
  }
  if (requireReady) {
    if (!allReported()) fail("La rutina necesita el estado de los ocho servomotores.");
    for (const n of SERVOS) {
      if (!ready(n) || Math.abs(current(n) - stance[n]) > 2) {
        fail("Recupera la postura de apoyo y espera a que termine antes de continuar.");
      }
    }
  }
  return stance;
}
function atStance() {
  try { getStance(true); return true; } catch { return false; }
}

function saveStance() {
  requireAllReady("guardar la postura");
  const pose = {};
  for (const n of SERVOS) {
    const value = round1(current(n));
    if (!inRange(n, value)) fail(`${n} está fuera de su rango (${cfg(n).min}°–${cfg(n).max}°).`);
    pose[n] = value;
  }
  Object.assign(robot.profile, { stance: pose, walkLifts: null, autoStance: true, autoStartup: false });
  saveRobot();
  return pose;
}
function useMeasuredStandingPose() {
  for (const n of SERVOS) {
    if (!inRange(n, MEASURED_STANDING_POSE[n])) fail(`${n}: la postura medida no cabe en su rango actual.`);
  }
  robot.profile.stance = clone(MEASURED_STANDING_POSE);
  robot.profile.walkLifts = null;
  robot.profile.autoStance = true;
  robot.profile.autoStartup = false;
  saveRobot();
  return robot.profile.stance;
}
async function restoreStance() {
  const stance = getStance();
  if (!robot.pca) fail("PCA9685 no detectado; revisa alimentación y cableado.");
  const needsHold = SERVOS.some((n) => !held(n));
  if (SERVOS.some((n) => robot.telemetry[n] && !robot.telemetry[n].en)) await actArm("postura");
  if (needsHold) {
    const issuedAt = now();
    await actPose(stance, "postura", true);
    await send("STATUS", "postura");
    await waitForHeld(SERVOS, issuedAt);
  } else {
    await actPose(stance, "postura");
  }
}
async function restPose() {
  requireAllReady("acostarse");
  if (!validPose(MEASURED_REST_POSE)) fail("La postura de descanso no cabe en los rangos actuales.");
  await actPose(MEASURED_REST_POSE, "descanso");
}
function setAutoStance(enabled) {
  robot.profile.autoStance = Boolean(enabled);
  if (enabled) robot.profile.autoStartup = false;
  saveRobot();
}

function getStartupPose() {
  const pose = robot.profile.startupPose;
  if (!pose) fail("Guarda primero una postura de inicio de los ocho motores.");
  for (const n of SERVOS) if (!inRange(n, pose[n])) fail(`La postura de inicio de ${n} ya no cabe en su rango.`);
  return pose;
}
async function saveStartupPose(angles, applyNow = true) {
  const pose = {};
  for (const n of SERVOS) {
    if (!inRange(n, angles[n])) fail(`${n} quedaría fuera de ${cfg(n).min}°–${cfg(n).max}°.`);
    if (robot.telemetry[n] && !robot.telemetry[n].en) fail(`${n} está deshabilitado.`);
    pose[n] = round1(angles[n]);
  }
  Object.assign(robot.profile, { startupPose: pose, autoStartup: true, autoStance: false });
  saveRobot();
  if (applyNow) await actPose(pose, "inicio", true);
}
async function restoreStartupPose() {
  await actPose(getStartupPose(), "inicio", true);
}
function setAutoStartup(enabled) {
  if (enabled) getStartupPose();
  robot.profile.autoStartup = Boolean(enabled);
  if (enabled) robot.profile.autoStance = false;
  saveRobot();
}

// ---------- marcha ----------
function walkSwingSpec(n) {
  const leg = LEGS[LEG_OF[n]];
  const stored = robot.profile.walkSwing?.[n];
  if (!stored) return { min: cfg(n).min, max: cfg(n).max, forward: leg.forward };
  if (!(cfg(n).min <= stored.min && stored.min < stored.max && stored.max <= cfg(n).max && [1, -1].includes(stored.forward))) {
    fail(`${n}: revisa el recorrido y sentido de avance guardados.`);
  }
  return stored;
}
const forwardSign = (n) => walkSwingSpec(n).forward;

function saveWalkSwing(motors) {
  const next = {};
  for (const n of SWING_SERVOS) {
    const item = motors[n];
    if (!item || !Number.isInteger(item.min) || !Number.isInteger(item.max) || ![1, -1].includes(item.forward)) {
      fail(`${n}: indica mínimo, máximo enteros y sentido.`);
    }
    if (!(cfg(n).min <= item.min && item.min < item.max && item.max <= cfg(n).max)) {
      fail(`${n}: el recorrido debe estar dentro de ${cfg(n).min}°–${cfg(n).max}° con mínimo < máximo.`);
    }
    next[n] = { min: item.min, max: item.max, forward: item.forward };
  }
  robot.profile.walkSwing = next;
  saveRobot();
}

async function testLift(n, lift) {
  if (!LIFT_SERVOS.includes(n)) fail("Elige R3, R4, L3 o L4.");
  const stance = getStance(true);
  if (!Number.isInteger(lift) || lift < 1 || lift > 180) fail("La subida debe ser un entero de 1–180°.");
  if (stance[n] + lift > cfg(n).max) fail(`${n} quedaría en ${stance[n] + lift}°, sobre su máximo de ${cfg(n).max}°.`);
  const raised = { ...stance, [n]: stance[n] + lift };
  return runSteps(`probar_elevacion_${n}`, [{ pose_all: SERVOS.map((s) => raised[s]), wait_done: true },
    { pose_all: SERVOS.map((s) => stance[s]), wait_done: true }], 1);
}

function saveWalkLifts(lifts) {
  const stance = getStance(true);
  const next = {};
  for (const n of LIFT_SERVOS) {
    const lift = lifts[n];
    if (!Number.isInteger(lift) || lift < 1 || lift > 180) fail(`${n}: la subida debe ser un entero de 1–180°.`);
    if (stance[n] + lift > cfg(n).max) fail(`${n}: ${stance[n]}° + ${lift}° supera su máximo de ${cfg(n).max}°.`);
    next[n] = lift;
  }
  robot.profile.walkLifts = next;
  saveRobot();
}

// build_walk_steps: un ciclo corto desde la postura de apoyo; nunca recorta un ángulo.
function buildWalkSteps(stride, lift = 10, direction = 1) {
  if (robot.run.status === "running") fail("Ya hay una rutina en marcha; deténla primero.");
  if (!allReported()) fail("La caminata necesita los ocho servomotores.");
  if (!isNum(stride) || stride < 1 || stride > 180) fail("El avance debe ser de 1–180°.");
  if (![1, -1].includes(direction)) fail("El sentido de caminata debe ser adelante o atrás.");
  const lifts = robot.profile.walkLifts;
  if (lifts && !LIFT_SERVOS.every((n) => Number.isInteger(lifts[n]) && lifts[n] > 0)) fail("Vuelve a calibrar la elevación de las cuatro patas.");
  getStance(true);
  const base = {};
  for (const n of SERVOS) {
    if (!held(n)) fail(`${n} debe estar activo y sujeto antes de caminar.`);
    if (!settled(n)) fail(`${n} aún no está en su posición objetivo.`);
    const value = current(n);
    let valid;
    let low = cfg(n).min;
    let high = cfg(n).max;
    if (SWING_SERVOS.includes(n)) {
      const spec = walkSwingSpec(n);
      low = spec.min;
      high = spec.max;
      valid = low <= value && value <= high && low <= value + spec.forward * direction * stride && value + spec.forward * direction * stride <= high;
    } else {
      const legLift = lifts ? lifts[n] : lift;
      valid = isNum(legLift) && legLift >= 1 && legLift <= 180 && low <= value && value + legLift <= high;
    }
    if (!valid) fail(`${n}: la pose actual no deja espacio para el paso dentro de ${low}°–${high}°.`);
    base[n] = value;
  }
  const pose = { ...base };
  const steps = [];
  const add = (changes) => {
    Object.assign(pose, changes);
    steps.push({ pose_all: SERVOS.map((n) => pose[n]), wait_done: true, _settleMs: 40 });
  };
  // Tres patas apoyadas mientras la cuarta se levanta y se coloca adelante.
  for (const swing of WALK_LEG_ORDER) {
    const liftServo = LEGS[swing].lift;
    const legLift = lifts ? lifts[liftServo] : lift;
    add({ [liftServo]: base[liftServo] + legLift });
    add({ [swing]: base[swing] + forwardSign(swing) * direction * stride });
    add({ [liftServo]: base[liftServo] });
  }
  // Con las cuatro patas apoyadas, el giro de regreso empuja el cuerpo.
  add(Object.fromEntries(SWING_SERVOS.map((n) => [n, base[n]])));
  return steps;
}
async function walk(stride, cycles = 1) {
  if (![1, 2, 3].includes(cycles)) fail("Ciclos permitidos: 1–3.");
  return runSteps("paso_de_prueba", buildWalkSteps(stride), cycles);
}

// ---------- rutinas ----------
function validateRoutine(steps, repeat) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) fail(`'steps' debe ser una lista de 1 a ${MAX_STEPS} pasos.`);
  if (!Number.isInteger(repeat) || repeat < 0 || repeat > MAX_REPEAT) fail(`'repeat' debe ser un entero 0–${MAX_REPEAT} (0 = hasta detener).`);
  steps.forEach((s, i) => {
    const bad = () => fail(`Paso ${i}: inválido (wait 0–${MAX_WAIT_S}s; pose/speed: {servo: número}; stance_offset: {servo: cambio}; mirror: [par, ángulo]; release: [servos]).`);
    if (typeof s !== "object" || s === null || Array.isArray(s) || !Object.keys(s).length) bad();
    const unknown = Object.keys(s).filter((key) => !STEP_KEYS.has(key));
    if (unknown.length) fail(`Paso ${i}: claves desconocidas ${unknown.join(", ")}.`);
    if ("wait" in s && !(isNum(s.wait) && s.wait >= 0 && s.wait <= MAX_WAIT_S)) bad();
    for (const key of ["pose", "pose_parallel", "speed", "stance_offset"]) {
      if (key in s) {
        const value = s[key];
        if (typeof value !== "object" || value === null || Array.isArray(value)) bad();
        for (const [n, v] of Object.entries(value)) if (!SERVOS.includes(n) || !isNum(v)) bad();
      }
    }
    if ("pose_parallel" in s && !Object.keys(s.pose_parallel).length) bad();
    if ("stance_offset" in s && Object.values(s.stance_offset).some((v) => Math.abs(v) > 180)) bad();
    if ("pose_all" in s && !(Array.isArray(s.pose_all) && s.pose_all.length === 8 && s.pose_all.every(isNum))) bad();
    if ("mirror" in s && !(Array.isArray(s.mirror) && s.mirror.length === 2)) bad();
    if ("release" in s && !Array.isArray(s.release)) bad();
    if ("eyes" in s) getFace(MOOD_TO_FACE[asciiFold(s.eyes).trim().toUpperCase()] ?? s.eyes);
    if ("face" in s) parseFaceSpec(s.face);
    if ("text" in s && typeof s.text !== "string" && typeof s.text !== "object") bad();
  });
}

function checkStepsForDevice(steps) {
  const stance = steps.some((s) => "stance_offset" in s) ? getStance(true) : null;
  steps.forEach((s, i) => {
    const used = [...Object.keys(s.pose || {}), ...Object.keys(s.pose_parallel || {}), ...Object.keys(s.stance_offset || {}),
      ...Object.keys(s.speed || {}), ...(s.release || [])];
    const bad = used.filter((n) => !SERVOS.includes(String(n).toUpperCase()));
    if (bad.length) fail(`Paso ${i}: el robot no tiene los servos ${bad.join(", ")}.`);
    const check = (n, angle) => {
      if (!inRange(n, angle)) fail(`Paso ${i}: ${n} quedaría fuera de ${cfg(n).min}°–${cfg(n).max}°.`);
    };
    if (stance && s.stance_offset) for (const [n, offset] of Object.entries(s.stance_offset)) check(n, stance[n] + offset);
    for (const [n, angle] of Object.entries(s.pose_parallel || {})) check(n, angle);
    if (s.pose_all) SERVOS.forEach((n, index) => check(n, s.pose_all[index]));
  });
}

function routineName(name) {
  const key = String(name).trim().toLowerCase().replace(/\s+/g, "_");
  if (!key || key.length > 60 || !/^[a-z0-9_-]+$/.test(key)) fail("Usa un nombre de 1–60 letras, números, guiones o guiones bajos.");
  return key;
}
function saveRoutine(name, routine) {
  const key = routineName(name);
  const repeat = routine.repeat ?? 1;
  validateRoutine(routine.steps, repeat);
  robot.routines[key] = { ...routine, description: String(routine.description || "").slice(0, 200), repeat };
  storage.set(KEY_ROUTINES, robot.routines);
  emit("catalog");
  return key;
}
function deleteRoutine(name) {
  delete robot.routines[name];
  storage.set(KEY_ROUTINES, robot.routines);
  emit("catalog");
}
async function runRoutine(name, repeat, amplitude = 1) {
  const routine = robot.routines[name];
  if (!routine) fail(`No existe la rutina «${name}».`);
  if (![1, 2, 3].includes(amplitude)) fail("Amplitud permitida: 1×, 2× o 3×.");
  const times = repeat ?? routine.repeat ?? 1;
  const steps = amplitude === 1 ? routine.steps : routine.steps.map((step) => (
    "stance_offset" in step
      ? { ...step, stance_offset: Object.fromEntries(Object.entries(step.stance_offset).map(([n, offset]) => [n, offset * amplitude])) }
      : step
  ));
  if (amplitude !== 1 && !steps.some((step) => "stance_offset" in step)) fail("Esta rutina no tiene desplazamientos ajustables.");
  validateRoutine(steps, times);
  if (routine.base_pose) {
    requireAllReady("ejecutar la rutina");
    for (const n of SERVOS) {
      if (Math.abs(current(n) - routine.base_pose[n]) > 2) fail("Lleva la araña a la postura con la que se guardó esta secuencia antes de ejecutarla.");
    }
  }
  checkStepsForDevice(steps);
  return runSteps(name, steps, times);
}

// ---------- ejecución de pasos (exec_step) ----------
function cancelRun() {
  robot.run.token += 1;
}
function guard(token) {
  if (token !== robot.run.token) throw new Cancelled();
}
async function sleepCancellable(ms, token) {
  const end = now() + ms;
  while (now() < end) {
    guard(token);
    await sleep(Math.min(40, end - now()));
  }
  guard(token);
}
async function waitMotionDone(token, timeoutMs = 10000, settleMs = 120) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    guard(token);
    const remaining = Math.max(0, ...SERVOS.map(remainingMs));
    if (remaining <= 0) break;
    await sleep(Math.min(remaining + 20, 200));
  }
  // Margen para el bucle de 20 ms del firmware y la latencia BLE.
  await sleepCancellable(settleMs, token);
}
function poseReached(desired) {
  return Object.entries(desired).every(([n, v]) => held(n) && Math.abs(target(n) - v) <= 0.1 && Math.abs(current(n) - v) <= 0.1);
}
function requireHeldStill(n) {
  if (!held(n) || !settled(n)) fail(`${n} debe estar sujeto y quieto.`);
}

async function execStep(s, token) {
  const src = "rutina";
  if ("eyes" in s) {
    guard(token);
    await actFace(MOOD_TO_FACE[asciiFold(s.eyes).trim().toUpperCase()] ?? s.eyes, src);
  }
  if ("face" in s) { guard(token); await actFace(s.face, src); }
  if ("text" in s) {
    guard(token);
    const t = s.text;
    await actText(typeof t === "object" ? t.text || "" : t, typeof t === "object" ? t.duration_ms ?? 0 : 0, src);
  }
  for (const [n, v] of Object.entries(s.speed || {})) { guard(token); await actSpeed(n, v, src); }
  if (s.center) { guard(token); await actCenter(src); }
  if (s.mirror) { guard(token); await actMirror(s.mirror[0], s.mirror[1], src); }
  if (s.pose_all) {
    const desired = Object.fromEntries(SERVOS.map((n, i) => [n, s.pose_all[i]]));
    guard(token);
    if (!poseReached(desired)) await actPose(desired, src);
  }
  if (s.relative_move) {
    const [n, delta] = s.relative_move;
    requireHeldStill(n);
    const angle = current(n) + delta;
    if (!inRange(n, angle)) fail(`${n} quedaría fuera de ${cfg(n).min}°–${cfg(n).max}°.`);
    guard(token);
    await actMove(n, angle, src);
  }
  if (s.relative_parallel) {
    const desired = {};
    for (const [n, delta] of Object.entries(s.relative_parallel)) {
      requireHeldStill(n);
      const angle = current(n) + delta;
      if (!inRange(n, angle)) fail(`${n} quedaría fuera de ${cfg(n).min}°–${cfg(n).max}°.`);
      desired[n] = angle;
    }
    guard(token);
    await actParallel(desired, src);
  }
  if (s.stance_offset) {
    const stance = getStance();
    const desired = Object.fromEntries(SERVOS.map((n) => [n, stance[n] + (s.stance_offset[n] || 0)]));
    guard(token);
    if (!poseReached(desired)) await actPose(desired, src);
  }
  if (s.pose_parallel) {
    const desired = Object.fromEntries(Object.entries(s.pose_parallel).filter(([n, v]) => !poseReached({ [n]: v })));
    guard(token);
    await actParallel(desired, src);
  }
  for (const [n, v] of Object.entries(s.pose || {})) {
    guard(token);
    if (!poseReached({ [n]: v })) await actMove(n, v, src);
  }
  for (const n of s.release || []) { guard(token); await actVerb("FREE", n, src); }
  if (s.wait_done) await waitMotionDone(token, 10000, s._settleMs ?? 120);
  if ("wait" in s) await sleepCancellable(s.wait * 1000, token);
}

// before/after: preparación y limpieza dentro de la misma ejecución (cancelable desde el inicio).
async function runSteps(name, steps, repeat = 1, { before, after } = {}) {
  if (robot.run.status === "running") fail("Ya hay una rutina en marcha; deténla primero.");
  if (!robot.transport) fail("Conecta el robot antes de ejecutar.");
  const token = ++robot.run.token;
  Object.assign(robot.run, { status: "running", name, step: 0, total: steps.length, loop: 0, repeat, error: "" });
  emit("run");
  let status = "done";
  let message = "";
  try {
    if (before) await before(() => guard(token));
    for (let loop = 0; repeat === 0 || loop < repeat; loop++) {
      robot.run.loop = loop + 1;
      for (let i = 0; i < steps.length; i++) {
        guard(token);
        robot.run.step = i + 1;
        emit("run");
        await execStep(steps[i], token);
      }
    }
  } catch (error) {
    if (error instanceof Cancelled || token !== robot.run.token) status = "stopped";
    else { status = "error"; message = error.message; }
  }
  // La limpieza termina antes de publicar el estado final: la interfaz sigue bloqueada mientras tanto.
  if (after && robot.transport) {
    try { await after(); } catch (error) { if (status !== "error") message = error.message; }
  }
  Object.assign(robot.run, { status, error: message });
  emit("run");
  return { ...robot.run };
}

// ---------- probador rápido ----------
function prepareQuickSequence(frames, cycles) {
  if (![1, 2, 3].includes(cycles) || !Array.isArray(frames) || !frames.length || frames.length > 40) {
    fail("La prueba admite 1–40 pasos y 1–3 ciclos.");
  }
  if (robot.run.status === "running") fail("Espera a que termine el movimiento actual.");
  requireAllReady("probar");
  const base = Object.fromEntries(SERVOS.map((n) => [n, round1(current(n))]));
  const steps = frames.map((frame, index) => {
    if ("wait" in frame && !(isNum(frame.wait) && frame.wait >= 0 && frame.wait <= 2)) fail(`Paso ${index + 1}: la pausa debe ser de 0–2 segundos.`);
    const pose = SERVOS.map((n) => base[n] + (frame.offsets[n] || 0));
    SERVOS.forEach((n, i) => {
      if (!inRange(n, pose[i])) fail(`Paso ${index + 1}: ${n} quedaría fuera de ${cfg(n).min}°–${cfg(n).max}°.`);
    });
    return { pose_all: pose, wait_done: true, ...(frame.wait ? { wait: frame.wait } : {}) };
  });
  if (Object.keys(frames.at(-1).offsets).length) steps.push({ pose_all: SERVOS.map((n) => base[n]), wait_done: true });
  return { base, steps };
}
async function quickTest(frames, cycles) {
  const { steps } = prepareQuickSequence(frames, cycles);
  return runSteps("prueba_rapida", steps, cycles);
}
function quickSave(name, frames, cycles) {
  const key = routineName(name);
  const previous = robot.routines[key];
  if (previous && !previous.quick_frames) fail("Ese nombre ya corresponde a otra rutina; elige uno distinto.");
  const { base, steps } = prepareQuickSequence(frames, cycles);
  robot.routines[key] = {
    description: "Pasos calibrables de esta araña",
    repeat: cycles,
    steps: steps.map((step) => ({ pose_parallel: Object.fromEntries(SERVOS.map((n, i) => [n, step.pose_all[i]])),
      wait_done: true, ...(step.wait ? { wait: step.wait } : {}) })),
    base_pose: base,
    quick_frames: frames.map((frame) => ({ stance_offset: frame.offsets, ...(frame.wait ? { wait: frame.wait } : {}) }))
  };
  storage.set(KEY_ROUTINES, robot.routines);
  emit("catalog");
  return key;
}

// ---------- programas de bloques ----------
const isDegree = (value) => isNum(value) && value > 0 && value <= 180;
const sameKeys = (block, keys) => Object.keys(block).length === keys.length && keys.every((key) => key in block);

function validateProgram(blocks, cycles) {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 60) fail("El programa necesita 1–60 bloques.");
  if (![1, 2, 3].includes(cycles)) fail("Ciclos permitidos: 1–3.");
  blocks.forEach((block, i) => {
    let valid = false;
    switch (block?.type) {
      case "routine":
      case "program":
        valid = sameKeys(block, ["type", "name", "times"]) && typeof block.name === "string" && block.name.trim() && [1, 2, 3].includes(block.times);
        break;
      case "move":
        valid = sameKeys(block, ["type", "leg", "direction", "degrees"]) && block.leg in LEGS
          && ["forward", "back", "up", "down"].includes(block.direction) && isDegree(block.degrees);
        break;
      case "servo":
        valid = sameKeys(block, ["type", "motor", "angle"]) && SERVOS.includes(block.motor) && isNum(block.angle) && block.angle >= 0 && block.angle <= 180;
        break;
      case "leg_step":
        valid = sameKeys(block, ["type", "leg", "stride", "lift"]) && block.leg in LEGS && isDegree(block.stride) && isDegree(block.lift);
        break;
      case "walk_cycle":
        valid = sameKeys(block, ["type", "legs", "pause"]) && typeof block.legs === "object"
          && Object.keys(block.legs).length === 4 && Object.keys(LEGS).every((leg) => {
            const item = block.legs[leg];
            return item && sameKeys(item, ["stride", "lift"]) && isDegree(item.stride) && isDegree(item.lift);
          }) && isNum(block.pause) && block.pause >= 0 && block.pause <= 5;
        break;
      case "face":
        valid = sameKeys(block, ["type", "name", "transition_ms", "duration_ms"]) && slug(block.name) in robot.faces
          && Number.isInteger(block.transition_ms) && block.transition_ms >= 0 && block.transition_ms <= 5000
          && Number.isInteger(block.duration_ms) && block.duration_ms >= 0 && block.duration_ms <= 600000;
        break;
      case "wait":
        valid = sameKeys(block, ["type", "seconds"]) && isNum(block.seconds) && block.seconds >= 0 && block.seconds <= 5;
        break;
      case "home":
        valid = sameKeys(block, ["type"]);
        break;
      default:
        valid = false;
    }
    if (!valid) fail(`Bloque ${i + 1} inválido: revisa sus campos y rangos.`);
  });
}

function expandProgramBlocks(blocks, cycles, ancestors = []) {
  validateProgram(blocks, cycles);
  const expanded = [];
  blocks.forEach((block, index) => {
    if (block.type !== "program") expanded.push(block);
    else {
      if (ancestors.includes(block.name)) fail(`Bloque ${index + 1}: referencia circular al programa «${block.name}».`);
      const saved = robot.programs[block.name];
      if (!saved) fail(`Bloque ${index + 1}: ya no existe el programa «${block.name}».`);
      const child = expandProgramBlocks(saved.blocks, saved.cycles, [...ancestors, block.name]);
      for (let i = 0; i < block.times * saved.cycles; i++) {
        expanded.push(...child);
        if (child.some((item) => ["move", "leg_step", "walk_cycle"].includes(item.type)) && child.at(-1).type !== "home") expanded.push({ type: "home" });
        if (expanded.length > MAX_STEPS) fail(`El programa expandido supera ${MAX_STEPS} pasos.`);
      }
    }
    if (expanded.length > MAX_STEPS) fail(`El programa expandido supera ${MAX_STEPS} pasos.`);
  });
  return expanded;
}

function programRangeError(index, servo, value, delta, field) {
  const c = cfg(servo);
  const room = Math.floor(delta > 0 ? c.max - value : value - c.min);
  const fix = room >= 1 ? `Reduce ${field} a ${room}° o menos.` : "No queda recorrido en esa dirección: cambia de sentido o vuelve a la postura inicial.";
  return new RobotError(`Bloque ${index}: ${servo} está en ${round1(value)}°; el movimiento de ${delta > 0 ? "+" : ""}${delta}° pediría ${round1(value + delta)}°, `
    + `pero su rango es ${c.min}°–${c.max}°. ${fix}`);
}

function groupParallelServoSteps(steps) {
  const grouped = [];
  let pending = {};
  const flush = () => {
    if (Object.keys(pending).length) grouped.push({ pose_parallel: pending, wait_done: true });
    pending = {};
  };
  for (const step of steps) {
    if (step.pose_parallel && step.single) {
      const [n, angle] = Object.entries(step.pose_parallel)[0];
      if (n in pending) flush();
      pending[n] = angle;
    } else {
      flush();
      grouped.push(step);
    }
  }
  flush();
  return grouped;
}

function groupConsecutiveLegSteps(blocks) {
  const grouped = [];
  let pending = [];
  let seen = new Set();
  const flush = () => {
    if (pending.length === 1) grouped.push(pending[0]);
    else if (pending.length) grouped.push([pending[0][0], { type: "leg_step_group", items: pending }]);
    pending = [];
    seen = new Set();
  };
  blocks.forEach((block, i) => {
    const index = i + 1;
    if (block.type === "leg_step") {
      if (seen.has(block.leg)) flush();
      pending.push([index, block]);
      seen.add(block.leg);
    } else {
      flush();
      grouped.push([index, block]);
    }
  });
  flush();
  return grouped;
}

function buildProgramSteps(rawBlocks, cycles) {
  const blocks = expandProgramBlocks(rawBlocks, cycles);
  if (robot.run.status === "running") fail("Espera a que termine el movimiento actual.");
  const needsPose = blocks.some((block) => ["move", "leg_step", "walk_cycle", "home"].includes(block.type));
  // Una postura completa al inicio permite arrancar el programa con PWM libre.
  const initial = {};
  for (const block of blocks) {
    if (block.type !== "servo" || block.motor in initial) break;
    initial[block.motor] = block.angle;
    if (Object.keys(initial).length === 8) break;
  }
  const hasInitialPose = Object.keys(initial).length === 8;
  const start = {};
  if (needsPose) {
    if (!allReported()) fail("Los bloques de movimiento necesitan los ocho motores.");
    for (const n of SERVOS) {
      if (!robot.telemetry[n].en) fail(`${n} está deshabilitado; pulsa «Habilitar servos» primero.`);
      if (!hasInitialPose && !ready(n)) fail(`${n} debe estar sujeto y quieto. Usa «Demostración → Sujeción» antes de ejecutar la caminata.`);
      start[n] = round1(current(n));
    }
  }
  // Ocho bloques Servo al comienzo (por ejemplo, el programa "parado") son el punto de regreso.
  let home = { ...start };
  if (hasInitialPose) home = { ...start, ...initial };
  const homePose = SERVOS.map((n) => home[n]);
  const steps = [];
  let hasMove = false;
  let simulated = { ...start };
  let positionKnown = needsPose;
  const simulate = (index, servo, delta, field) => {
    if (!positionKnown) return;
    const next = simulated[servo] + delta;
    if (!inRange(servo, next)) throw programRangeError(index, servo, simulated[servo], delta, field);
    simulated[servo] = next;
  };
  for (const [index, block] of groupConsecutiveLegSteps(blocks)) {
    switch (block.type) {
      case "routine": {
        const routine = robot.routines[block.name];
        if (!routine) fail(`Ya no existe la rutina «${block.name}».`);
        validateRoutine(routine.steps, 1);
        checkStepsForDevice(routine.steps);
        for (let i = 0; i < block.times; i++) steps.push(...routine.steps);
        positionKnown = false;
        break;
      }
      case "servo": {
        const { motor, angle } = block;
        if (!inRange(motor, angle)) fail(`Bloque ${index}: ${motor} recibiría ${angle}°, fuera de ${cfg(motor).min}°–${cfg(motor).max}°.`);
        if (!ready(motor) && !(hasInitialPose && robot.telemetry[motor]?.en)) fail(`Bloque ${index}: sujeta ${motor} y espera a que termine su movimiento.`);
        steps.push({ pose_parallel: { [motor]: angle }, wait_done: true, single: true });
        if (positionKnown) simulated[motor] = angle;
        break;
      }
      case "move": {
        const { swing, lift } = LEGS[block.leg];
        const sign0 = forwardSign(swing);
        const servo = ["forward", "back"].includes(block.direction) ? swing : lift;
        const sign = servo === swing ? (block.direction === "forward" ? sign0 : -sign0) : (block.direction === "up" ? 1 : -1);
        const delta = sign * block.degrees;
        simulate(index, servo, delta, "Grados");
        steps.push({ relative_move: [servo, delta], wait_done: true });
        hasMove = true;
        break;
      }
      case "leg_step_group": {
        const phases = [{}, {}, {}, {}];
        const sources = {};
        for (const [sourceIndex, item] of block.items) {
          const { swing, lift } = LEGS[item.leg];
          const sign = forwardSign(swing);
          phases[0][lift] = item.lift;
          phases[1][swing] = sign * item.stride;
          phases[2][lift] = -item.lift;
          phases[3][swing] = -sign * item.stride;
          sources[swing] = [sourceIndex, "Avance"];
          sources[lift] = [sourceIndex, "Subida"];
        }
        for (const phase of phases) {
          for (const [servo, delta] of Object.entries(phase)) simulate(sources[servo][0], servo, delta, sources[servo][1]);
          steps.push({ relative_parallel: phase, wait_done: true });
        }
        hasMove = true;
        break;
      }
      case "leg_step": {
        const { swing, lift } = LEGS[block.leg];
        const sign = forwardSign(swing);
        for (const [servo, delta] of [[lift, block.lift], [swing, sign * block.stride], [lift, -block.lift], [swing, -sign * block.stride]]) {
          simulate(index, servo, delta, servo === swing ? "Avance" : "Subida");
          steps.push({ relative_move: [servo, delta], wait_done: true });
        }
        hasMove = true;
        break;
      }
      case "walk_cycle": {
        // Par diagonal A (R1+L2), par B (L1+R2) y empuje final de las cuatro patas apoyadas.
        const phases = [{}, {}, {}, {}, {}, {}, {}];
        const sources = {};
        for (const leg of ["R1", "L2", "L1", "R2"]) {
          const { swing, lift } = LEGS[leg];
          const setting = block.legs[leg];
          const advance = forwardSign(swing) * setting.stride;
          if (positionKnown) {
            const spec = walkSwingSpec(swing);
            if (simulated[swing] < spec.min || simulated[swing] > spec.max || simulated[swing] + advance < spec.min || simulated[swing] + advance > spec.max) {
              fail(`Bloque ${index}: ${swing} no tiene recorrido para avanzar ${setting.stride}° dentro de ${spec.min}°–${spec.max}°.`);
            }
          }
          const [first, second, third] = ["R1", "L2"].includes(leg) ? [0, 1, 2] : [3, 4, 5];
          phases[first][lift] = setting.lift;
          phases[second][swing] = advance;
          phases[third][lift] = -setting.lift;
          phases[6][swing] = -advance;
          sources[swing] = "Avance";
          sources[lift] = "Subida";
        }
        phases.forEach((phase, phaseIndex) => {
          for (const [servo, delta] of Object.entries(phase)) simulate(index, servo, delta, sources[servo]);
          steps.push({ relative_parallel: phase, wait_done: true });
          if (phaseIndex === 2 && block.pause) steps.push({ wait: block.pause });
        });
        hasMove = true;
        break;
      }
      case "wait":
        steps.push({ wait: block.seconds });
        break;
      case "face":
        steps.push({ face: { name: block.name, transition_ms: block.transition_ms, duration_ms: block.duration_ms } });
        break;
      case "home":
        steps.push({ pose_all: homePose, wait_done: true });
        simulated = { ...home };
        positionKnown = true;
        break;
      default:
        fail(`Bloque ${index}: tipo desconocido.`);
    }
  }
  if (hasMove && blocks.at(-1).type !== "home") steps.push({ pose_all: homePose, wait_done: true });
  const grouped = groupParallelServoSteps(steps).map(({ single, ...step }) => step);
  if (grouped.length > MAX_STEPS) fail(`El programa expandido supera ${MAX_STEPS} pasos.`);
  return grouped;
}

function countProgramSteps(blocks, cycles = 1) {
  try {
    return expandProgramBlocks(blocks, cycles).reduce((total, block) => {
      if (block.type === "walk_cycle") return total + 7 + (block.pause ? 1 : 0);
      if (block.type === "leg_step") return total + 4;
      if (block.type === "routine") return total + (robot.routines[block.name]?.steps.length || 0) * block.times;
      return total + 1;
    }, 0);
  } catch {
    return null;
  }
}

function programName(name) {
  const key = String(name).trim().toLowerCase().replace(/\s+/g, "_");
  if (!/^[a-z0-9_-]{1,60}$/.test(key)) fail("Usa un nombre de 1–60 letras, números, guiones o guiones bajos.");
  return key;
}
function saveProgram(name, program) {
  const key = programName(name);
  const cycles = program.cycles ?? 1;
  const blocks = program.blocks;
  const previous = robot.programs[key];
  robot.programs[key] = { description: String(program.description || "").slice(0, 200), cycles, blocks };
  try {
    expandProgramBlocks(blocks, cycles, [key]);
  } catch (error) {
    if (previous) robot.programs[key] = previous; else delete robot.programs[key];
    throw error;
  }
  storage.set(KEY_PROGRAMS, robot.programs);
  emit("catalog");
  return key;
}
function deleteProgram(name) {
  delete robot.programs[name];
  storage.set(KEY_PROGRAMS, robot.programs);
  emit("catalog");
}
async function runProgramBlocks(name, blocks, cycles) {
  return runSteps(name, buildProgramSteps(blocks, cycles), cycles);
}
async function runProgram(name) {
  const program = robot.programs[name];
  if (!program) fail(`No existe el programa «${name}».`);
  return runProgramBlocks(name, program.blocks, program.cycles);
}

// ¿Usa el programa (o uno anidado) una rutina con stance_offset?
function programNeedsStance(blocks, seen = []) {
  return blocks.some((block) => {
    if (block.type === "routine") return (robot.routines[block.name]?.steps || []).some((s) => "stance_offset" in s);
    if (block.type === "program" && !seen.includes(block.name)) {
      return programNeedsStance(robot.programs[block.name]?.blocks || [], [...seen, block.name]);
    }
    return false;
  });
}

// Ocho bloques Servo distintos al inicio del programa = postura acostada de inicio.
function startupFromBlocks(blocks) {
  let expanded;
  try { expanded = expandProgramBlocks(blocks, 1); } catch { return null; }
  const pose = {};
  for (const block of expanded.slice(0, 8)) {
    if (block.type !== "servo" || block.motor in pose) return null;
    pose[block.motor] = block.angle;
  }
  return Object.keys(pose).length === 8 ? pose : null;
}

// Cuatro pasos de pata (R1 y L2, luego L1 y R2, con una espera opcional entre pares) → caminata.
function convertibleSteps(blocks) {
  const indices = blocks.flatMap((block, index) => (block.type === "leg_step" ? [index] : []));
  if (indices.length !== 4) return null;
  const first = indices[0];
  const last = indices[3];
  const segment = blocks.slice(first, last + 1);
  if (segment.some((block) => block.type !== "leg_step" && block.type !== "wait")) return null;
  const steps = segment.filter((block) => block.type === "leg_step");
  if (new Set(steps.map((block) => block.leg)).size !== 4
    || !["R1", "L2"].every((name) => steps.slice(0, 2).some((block) => block.leg === name))
    || !["L1", "R2"].every((name) => steps.slice(2).some((block) => block.leg === name))) return null;
  const waits = segment.filter((block) => block.type === "wait");
  if (waits.length > 1 || (waits.length === 1
    && segment.slice(0, segment.indexOf(waits[0])).filter((block) => block.type === "leg_step").length !== 2)) return null;
  return {
    first, last,
    legs: Object.fromEntries(steps.map((block) => [block.leg, { stride: block.stride, lift: block.lift }])),
    pause: waits[0]?.seconds ?? 0
  };
}
