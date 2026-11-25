"use strict";

const SERVICE_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0040";
const COMMAND_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0041";
const STATUS_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0042";
const SERVOS = ["R1", "R2", "R3", "R4", "L1", "L2", "L3", "L4"];
const STORAGE_PROFILE = "spider-ble-robot-profile";
const STORAGE_SUPPORT = "spider-ble-support-pose";
// El firmware encola 8 órdenes: espaciar las ráfagas evita que descarte alguna.
const BURST_GAP_MS = 40;
const $ = (id) => document.getElementById(id);

let device = null;
let commandCharacteristic = null;
let statusCharacteristic = null;
let pendingWrite = Promise.resolve();
let pcaReady = false;
let deferredInstall = null;
let routineToken = 0;
let routineRunning = false;
let profilePending = false;
const statusSeen = new Set();
const cards = new Map();

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function loadProfile() {
  const saved = loadJson(STORAGE_PROFILE, {});
  return Object.fromEntries(SERVOS.map((name) => [name, { ...DEFAULT_SERVO_PROFILE[name], ...saved[name] }]));
}

let profile = loadProfile();
let supportPose = loadJson(STORAGE_SUPPORT, null);

const clampToRange = (name, value) => Math.round(Math.min(profile[name].max, Math.max(profile[name].min, value)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setNotice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function isConnected() {
  return Boolean(device?.gatt?.connected && commandCharacteristic);
}

function updateControls() {
  const connected = isConnected();
  const canMove = connected && pcaReady && !routineRunning;
  $("connect-button").disabled = connected;
  $("disconnect-button").disabled = !connected;
  $("stop-button").disabled = !connected;
  $("release-button").disabled = !connected;
  $("arm-button").disabled = !connected;
  $("all-button").disabled = !canMove;
  $("mirror-button").disabled = !canMove;
  $("profile-send").disabled = !connected || routineRunning;
  $("support-save").disabled = !connected || routineRunning;
  document.querySelectorAll("[data-face]").forEach((button) => { button.disabled = !connected; });
  document.querySelectorAll("[data-move]").forEach((button) => { button.disabled = !canMove; });
  for (const card of cards.values()) card.button.disabled = !canMove;
  $("connection-dot").classList.toggle("connected", connected);
  $("connection-label").textContent = connected ? (device.name || "Spider-BLE") + " conectado" : "Sin conectar";
  if (!connected) $("hardware-label").textContent = "Hardware sin consultar";
}

// ==========================================
// TARJETAS DE SERVO (rango tomado del perfil)
// ==========================================
function renderServos() {
  const grid = $("servo-grid");
  for (const name of SERVOS) {
    const card = document.createElement("article");
    card.className = "servo-card " + (name.startsWith("L") ? "left" : "right");
    const id = `angle-${name}`;
    card.innerHTML = `<div class="servo-top"><span class="servo-name"><i aria-hidden="true"></i>${name}</span><span class="servo-state">Sin datos</span></div>
      <p class="servo-current">Actual: <strong>—</strong> · Destino: <span>—</span></p>
      <div class="range-head"><label for="${id}">Ángulo</label><output for="${id}">90°</output></div>
      <input class="range" type="range" id="${id}" step="1" value="90">
      <div class="servo-bottom"><span class="servo-bounds"></span><button type="button" class="button button-secondary" disabled>Mover</button></div>`;
    const slider = card.querySelector("input");
    const output = card.querySelector("output");
    const button = card.querySelector("button");
    let edited = false;
    slider.addEventListener("input", () => { output.value = `${slider.value}°`; edited = true; });
    button.addEventListener("click", async () => {
      if (!canSendMovement()) return;
      const angle = clampToRange(name, Number(slider.value));
      if (await sendCommand(`MOVE ${name} ${angle}`)) {
        edited = false;
        setNotice(`${name}: movimiento solicitado a ${angle}°.`);
      }
    });
    grid.append(card);
    cards.set(name, {
      slider, output, button, bounds: card.querySelector(".servo-bounds"),
      state: card.querySelector(".servo-state"),
      current: card.querySelector(".servo-current strong"),
      target: card.querySelector(".servo-current span"),
      targetValue: null, ready: false, pwm: false,
      get edited() { return edited; }
    });
  }
  applyProfileToPage();
}

// Ajusta sliders, límites y textos de la página al perfil guardado.
function applyProfileToPage() {
  for (const name of SERVOS) {
    const { min, max } = profile[name];
    const card = cards.get(name);
    card.slider.min = String(min);
    card.slider.max = String(max);
    card.slider.value = String(clampToRange(name, Number(card.slider.value)));
    card.output.value = `${card.slider.value}°`;
    card.bounds.textContent = `${min}–${max}°`;
  }
  const allMin = Math.max(...SERVOS.map((name) => profile[name].min));
  const allMax = Math.min(...SERVOS.map((name) => profile[name].max));
  const all = $("all-angle");
  all.min = String(allMin);
  all.max = String(allMax);
  all.value = String(Math.min(allMax, Math.max(allMin, Number(all.value))));
  $("all-angle-value").value = `${all.value}°`;
  $("all-range").textContent = `${allMin}–${allMax}° (rango común)`;
  updateMirrorRange();
}

function updateMirrorRange() {
  const right = SERVOS[Number($("mirror-pair").value) - 1];
  const input = $("mirror-angle");
  input.min = String(profile[right].min);
  input.max = String(profile[right].max);
  input.value = String(clampToRange(right, Number(input.value)));
}

// ==========================================
// PERFIL DEL ROBOT
// ==========================================
function renderProfileEditor(source = profile) {
  const body = $("profile-rows");
  body.replaceChildren();
  for (const name of SERVOS) {
    const p = source[name];
    const kind = /[12]$/.test(name) ? "avanza" : "levanta";
    const row = document.createElement("tr");
    row.dataset.servo = name;
    row.innerHTML = `<th scope="row">${name}</th>
      <td><input type="number" data-key="min" min="0" max="180" value="${p.min}" aria-label="${name} mínimo"></td>
      <td><input type="number" data-key="max" min="0" max="180" value="${p.max}" aria-label="${name} máximo"></td>
      <td><input type="number" data-key="speed" min="1" max="180" value="${p.speed}" aria-label="${name} velocidad"></td>
      <td><input type="checkbox" data-key="invert" ${p.invert ? "checked" : ""} aria-label="${name} invertido"></td>
      <td><select data-key="dir" aria-label="${name} sentido"><option value="1">${kind} al subir</option><option value="-1">${kind} al bajar</option></select></td>`;
    row.querySelector("select").value = String(p.dir);
    body.append(row);
  }
}

function readProfileEditor() {
  const next = {};
  for (const row of $("profile-rows").querySelectorAll("tr")) {
    const name = row.dataset.servo;
    const field = (key) => row.querySelector(`[data-key="${key}"]`);
    const min = Number(field("min").value);
    const max = Number(field("max").value);
    const speed = Number(field("speed").value);
    if (![min, max, speed].every(Number.isInteger) || min < 0 || max > 180 || min >= max) {
      throw new Error(`${name}: el rango debe cumplir 0 ≤ mínimo < máximo ≤ 180.`);
    }
    if (speed < 1 || speed > 180) throw new Error(`${name}: la velocidad debe estar entre 1 y 180 °/s.`);
    next[name] = { min, max, speed, invert: field("invert").checked, dir: Number(field("dir").value) };
  }
  return next;
}

function profileCommands() {
  return SERVOS.flatMap((name) => {
    const p = profile[name];
    return [`LIMIT ${name} ${p.min} ${p.max}`, `INVERT ${name} ${p.invert ? 1 : 0}`, `SPEED ${name} ${p.speed}`];
  });
}

function speedCommands() {
  return SERVOS.map((name) => `SPEED ${name} ${profile[name].speed}`);
}

// LIMIT e INVERT liberan el PWM en el firmware: solo se envían con los motores libres o con confirmación.
async function sendProfile({ confirmHeld }) {
  const held = SERVOS.filter((name) => cards.get(name).pwm);
  if (held.length && confirmHeld &&
      !window.confirm(`Enviar rangos e inversión libera el PWM de los motores sujetos (${held.join(", ")}). Si la araña está de pie, se caerá. ¿Continuar?`)) {
    return false;
  }
  if (held.length && !confirmHeld) return false;
  cancelRoutine();
  if (!(await sendBurst(profileCommands()))) return false;
  profilePending = false;
  await sendCommand("STATUS");
  setNotice("Perfil enviado al robot: rangos, inversión y velocidad. Los motores quedan libres hasta el siguiente movimiento.");
  return true;
}

function resolvePendingProfile() {
  if (!profilePending || statusSeen.size < SERVOS.length) return;
  const held = SERVOS.filter((name) => cards.get(name).pwm);
  profilePending = false;
  if (held.length) {
    sendBurst(speedCommands());
    setNotice(`Hay motores sujetos (${held.join(", ")}). Se envió la velocidad; pulsa «Enviar perfil al robot» cuando la araña esté apoyada para aplicar rangos e inversión.`, true);
  } else {
    sendProfile({ confirmHeld: false });
  }
}

function setupProfile() {
  renderProfileEditor();
  $("profile-save").addEventListener("click", () => {
    try {
      profile = readProfileEditor();
    } catch (error) {
      setNotice(error.message, true);
      return;
    }
    localStorage.setItem(STORAGE_PROFILE, JSON.stringify(profile));
    applyProfileToPage();
    renderSupportPose();
    setNotice(isConnected()
      ? "Perfil guardado en la página. Pulsa «Enviar perfil al robot» para aplicarlo al ESP32."
      : "Perfil guardado en la página. Se enviará al conectar el robot.");
  });
  $("profile-reset").addEventListener("click", () => {
    renderProfileEditor(DEFAULT_SERVO_PROFILE);
    setNotice("Valores de fábrica cargados en el editor. Pulsa «Guardar perfil» para conservarlos.");
  });
  $("profile-send").addEventListener("click", () => sendProfile({ confirmHeld: true }));
}

// ==========================================
// CARAS (definidas en robot-profile.js)
// ==========================================
function previewFace(face) {
  const both = { ...EYE_BASE, ...face.eyes };
  const eyes = document.querySelectorAll(".face-preview .eye");
  [face.left, face.right].forEach((single, index) => {
    const e = { ...both, ...single };
    const style = eyes[index].style;
    style.width = `${e.W * 1.1}px`;
    style.height = `${Math.max(3, (e.H * 1.1 * e.O) / 100)}px`;
    style.borderRadius = `${e.R * 1.1}px`;
  });
}

async function showFace(id) {
  const face = FACES.find((item) => item.id === id) || FACES[0];
  previewFace(face);
  for (const command of faceCommands(face)) if (!(await sendCommand(command))) return false;
  return true;
}

function setupFaces() {
  const container = $("face-buttons");
  for (const face of FACES) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.face = face.id;
    button.textContent = face.label;
    button.addEventListener("click", async () => {
      if (await showFace(face.id)) setNotice(`Cara «${face.label}» aplicada.`);
    });
    container.append(button);
  }
  previewFace(FACES[0]);
}

// ==========================================
// ESTADO BLE
// ==========================================
function handleStatus(event) {
  const raw = new TextDecoder().decode(event.target.value).trim();
  const parts = raw.split(",");
  if (parts[0] === "P" && parts.length >= 4) {
    pcaReady = parts[1] === "1";
    const oled = parts[2] === "1";
    $("hardware-label").textContent = `PCA9685 ${pcaReady ? "listo" : "no detectado"} · OLED ${oled ? "lista" : "no detectada"}`;
    if (!pcaReady) setNotice("PCA9685 no detectado. Revisa alimentación y cableado I²C antes de mover el robot.", true);
    updateControls();
  } else if (parts[0] === "S" && parts.length >= 6 && cards.has(parts[1])) {
    const card = cards.get(parts[1]);
    const current = Number(parts[2]);
    const target = Number(parts[3]);
    const enabled = parts[4] === "1";
    const pwm = parts[5] === "1";
    card.current.textContent = Number.isFinite(current) ? `${current}°` : "—";
    card.target.textContent = Number.isFinite(target) ? `${target}°` : "—";
    card.state.textContent = !enabled ? "Deshabilitado" : pwm ? "PWM activo" : "Libre";
    card.state.className = `servo-state ${pwm ? "active" : "free"}`;
    card.pwm = pwm;
    card.ready = enabled && pwm;
    card.targetValue = Number.isFinite(target) ? target : null;
    if (!card.edited && Number.isFinite(target)) {
      card.slider.value = String(target);
      card.output.value = `${card.slider.value}°`;
    }
    statusSeen.add(parts[1]);
    resolvePendingProfile();
  }
}

function disconnected() {
  cancelRoutine();
  for (const card of cards.values()) { card.ready = false; card.pwm = false; }
  commandCharacteristic = null;
  statusCharacteristic = null;
  pcaReady = false;
  profilePending = false;
  updateControls();
  setNotice("Robot desconectado. El firmware detuvo las trayectorias activas.");
}

async function connect() {
  if (!navigator.bluetooth) {
    setNotice("Este navegador no admite Web Bluetooth. Usa Chrome o Edge en Android o escritorio.", true);
    return;
  }
  if (!window.isSecureContext) {
    setNotice("Abre la aplicación mediante HTTPS o localhost para usar Bluetooth.", true);
    return;
  }
  $("connect-button").disabled = true;
  setNotice("Buscando Spider-BLE…");
  try {
    const selected = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Spider-BLE" }],
      optionalServices: [SERVICE_UUID]
    });
    if (device) device.removeEventListener("gattserverdisconnected", disconnected);
    device = selected;
    device.addEventListener("gattserverdisconnected", disconnected);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    commandCharacteristic = await service.getCharacteristic(COMMAND_UUID);
    statusCharacteristic = await service.getCharacteristic(STATUS_UUID);
    statusSeen.clear();
    profilePending = true;
    await statusCharacteristic.startNotifications();
    statusCharacteristic.addEventListener("characteristicvaluechanged", handleStatus);
    updateControls();
    setNotice("Robot conectado. Leyendo estado para aplicar el perfil de la página…");
    await sendCommand("STATUS");
  } catch (error) {
    if (device?.gatt?.connected) device.gatt.disconnect();
    commandCharacteristic = null;
    statusCharacteristic = null;
    pcaReady = false;
    profilePending = false;
    updateControls();
    if (error.name === "NotFoundError") setNotice("No se seleccionó ningún robot.");
    else setNotice(`No se pudo conectar: ${error.message || error.name}`, true);
  } finally {
    updateControls();
  }
}

async function sendCommand(text) {
  if (!isConnected()) {
    setNotice("Conecta el robot antes de enviar comandos.", true);
    return false;
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > BLE_COMMAND_LIMIT) {
    setNotice(`Comando demasiado largo para el robot (${bytes.length} bytes): «${text}».`, true);
    return false;
  }
  const characteristic = commandCharacteristic;
  const write = pendingWrite.catch(() => {}).then(async () => {
    if (!isConnected() || characteristic !== commandCharacteristic) throw new Error("El robot se desconectó");
    if (characteristic.writeValueWithResponse) await characteristic.writeValueWithResponse(bytes);
    else await characteristic.writeValue(bytes);
  });
  pendingWrite = write;
  try { await write; return true; }
  catch (error) { setNotice(`No se pudo enviar «${text}»: ${error.message || error.name}`, true); return false; }
}

async function sendBurst(commands) {
  for (const command of commands) {
    if (!(await sendCommand(command))) return false;
    await delay(BURST_GAP_MS);
  }
  return true;
}

function canSendMovement() {
  if (isConnected() && pcaReady) return true;
  setNotice("Conecta el robot y verifica que el PCA9685 esté listo.", true);
  return false;
}

function setupActions() {
  $("connect-button").addEventListener("click", connect);
  $("disconnect-button").addEventListener("click", async () => {
    cancelRoutine();
    if (isConnected()) await sendCommand("STOP");
    if (device?.gatt?.connected) device.gatt.disconnect();
  });
  $("stop-button").addEventListener("click", async () => {
    cancelRoutine();
    if (await sendCommand("STOP")) setNotice("Movimiento detenido. Los servos conservan su posición actual.");
  });
  $("release-button").addEventListener("click", async () => {
    cancelRoutine();
    if (await sendCommand("RELEASE")) setNotice("Servos liberados. Pulsa Habilitar antes de moverlos de nuevo.");
  });
  $("arm-button").addEventListener("click", async () => {
    if (await sendCommand("ARM")) setNotice("Servos habilitados. Los pulsos se activan al recibir movimiento.");
  });
  $("all-angle").addEventListener("input", (event) => { $("all-angle-value").value = `${event.target.value}°`; });
  $("all-button").addEventListener("click", async () => {
    if (!canSendMovement()) return;
    const angle = Number($("all-angle").value);
    if (await sendCommand(`ALL ${angle}`)) setNotice(`Movimiento de 8 servos solicitado a ${angle}°.`);
  });
  $("mirror-pair").addEventListener("change", updateMirrorRange);
  $("mirror-button").addEventListener("click", async () => {
    if (!canSendMovement()) return;
    const pair = Number($("mirror-pair").value);
    const right = SERVOS[pair - 1];
    const angle = Number($("mirror-angle").value);
    if (!Number.isInteger(angle) || angle < profile[right].min || angle > profile[right].max) {
      setNotice(`Introduce un ángulo entre ${profile[right].min} y ${profile[right].max}° para ${right}.`, true);
      return;
    }
    if (await sendCommand(`MIRROR ${pair} ${angle}`)) setNotice(`Par ${pair}: movimiento en espejo solicitado.`);
  });
}

// ==========================================
// MOVIMIENTOS SESAME
// ==========================================
function renderSupportPose() {
  if (!supportPose) {
    $("support-pose").textContent = "Sin guardar. Coloca la araña de pie con los cuatro pies apoyados y pulsa Guardar.";
    return;
  }
  const outside = SERVOS.filter((name) => supportPose[name] !== clampToRange(name, supportPose[name]));
  $("support-pose").textContent = SERVOS.map((name) => `${name} ${supportPose[name]}°`).join(" · ") +
    (outside.length ? ` — fuera del rango del perfil: ${outside.join(", ")}` : "");
}

function cancelRoutine() {
  routineToken += 1;
}

function sleepUnlessCancelled(ms, token) {
  return new Promise((resolve) => {
    const end = performance.now() + ms;
    const tick = () => {
      if (token !== routineToken) resolve(false);
      else if (performance.now() >= end) resolve(true);
      else setTimeout(tick, Math.min(40, end - performance.now()));
    };
    tick();
  });
}

function routineReady() {
  if (!canSendMovement()) return false;
  if (routineRunning) { setNotice("Ya hay un movimiento en curso. Pulsa Detener para interrumpirlo.", true); return false; }
  if (!supportPose) { setNotice("Guarda primero la postura de apoyo de tu araña.", true); return false; }
  const outside = SERVOS.filter((name) => supportPose[name] !== clampToRange(name, supportPose[name]));
  if (outside.length) {
    setNotice(`La postura de apoyo está fuera del rango del perfil en ${outside.join(", ")}. Vuelve a guardarla.`, true);
    return false;
  }
  const loose = SERVOS.filter((name) => !cards.get(name).ready);
  if (loose.length) {
    setNotice(`Sujeta los ocho motores en la postura de apoyo antes de empezar. Sin PWM: ${loose.join(", ")}.`, true);
    return false;
  }
  return true;
}

// Convierte un cuadro de Sesame en ángulos de esta araña, dentro del rango del perfil.
function applyFrame(pose, frame, amplitude) {
  for (const [name, angle] of Object.entries(frame.set)) {
    pose[name] = clampToRange(name, supportPose[name] + profile[name].dir * sesameDelta(name, angle) * amplitude);
  }
}

async function sendPose(pose, previous, baseWait, speed, token) {
  if (!(await sendCommand(`POSE ${SERVOS.map((name) => pose[name]).join(" ")}`))) return false;
  const travel = Math.max(...SERVOS.map((name) => Math.abs(pose[name] - previous[name])));
  return sleepUnlessCancelled(Math.max(baseWait, (travel / speed) * 1000 + 40), token);
}

async function runFrames(title, face, intro, cycle, cycles, stay) {
  if (!routineReady()) return;
  const token = ++routineToken;
  const amplitude = Number($("sesame-amplitude").value) / 100;
  const tempo = Number($("sesame-tempo").value) / 100;
  const speed = Number($("sesame-speed").value);
  const frames = [...intro, ...Array.from({ length: cycles }, () => cycle).flat()];
  routineRunning = true;
  updateControls();
  setNotice(`${title}: en curso…`);
  let completed = false;
  try {
    if (!(await sendBurst(SERVOS.map((name) => `SPEED ${name} ${speed}`)))) return;
    await showFace(face);
    const pose = { ...supportPose };
    for (const frame of frames) {
      if (token !== routineToken) return;
      if (frame.face) await showFace(frame.face);
      const previous = { ...pose };
      applyFrame(pose, frame, amplitude);
      if (!(await sendPose(pose, previous, frame.wait / tempo, speed, token))) return;
    }
    if (!stay) {
      if (!(await sendPose({ ...supportPose }, pose, 200, speed, token))) return;
      await showFace("normal");
    }
    completed = true;
  } finally {
    routineRunning = false;
    if (isConnected()) await sendBurst(speedCommands());
    updateControls();
    setNotice(completed ? `${title}: terminado.` : `${title}: interrumpido.`, !completed && token === routineToken);
  }
}

function setupSesame() {
  const moves = $("sesame-moves");
  for (const move of SESAME_MOVES) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.move = move.id;
    button.textContent = move.label;
    button.addEventListener("click", () => runFrames(move.label, move.face, move.frames, [], 0, move.stay));
    moves.append(button);
  }
  const gaits = $("sesame-gaits");
  for (const gait of SESAME_GAITS) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.move = gait.id;
    button.textContent = gait.label;
    button.addEventListener("click", () => {
      const cycles = Math.min(20, Math.max(1, Number($("sesame-cycles").value) || 1));
      runFrames(gait.label, gait.face, gait.intro, gait.cycle, cycles, false);
    });
    gaits.append(button);
  }
  for (const id of ["sesame-amplitude", "sesame-tempo", "sesame-speed"]) {
    const input = $(id);
    const output = $(`${id}-value`);
    const unit = id === "sesame-speed" ? "°/s" : "%";
    const refresh = () => { output.value = `${input.value}${unit}`; };
    input.addEventListener("input", refresh);
    refresh();
  }
  $("support-save").addEventListener("click", () => {
    const missing = SERVOS.filter((name) => cards.get(name).targetValue === null);
    if (missing.length) { setNotice(`Aún no hay ángulo de ${missing.join(", ")}. Espera el estado del robot.`, true); return; }
    const outside = SERVOS.filter((name) => {
      const value = cards.get(name).targetValue;
      return value !== clampToRange(name, value);
    });
    if (outside.length) { setNotice(`No se guardó: ${outside.join(", ")} está fuera del rango del perfil.`, true); return; }
    supportPose = Object.fromEntries(SERVOS.map((name) => [name, cards.get(name).targetValue]));
    localStorage.setItem(STORAGE_SUPPORT, JSON.stringify(supportPose));
    renderSupportPose();
    setNotice("Postura de apoyo guardada en este navegador.");
  });
  renderSupportPose();
}

function setupPwa() {
  const refreshNetwork = () => {
    const online = navigator.onLine;
    $("network-state").textContent = online ? "Control local listo" : "Disponible sin conexión";
    $("network-state").classList.toggle("online", online);
  };
  window.addEventListener("online", refreshNetwork);
  window.addEventListener("offline", refreshNetwork);
  refreshNetwork();
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      $("install-help").textContent = "No se pudo guardar la interfaz para uso sin conexión.";
    });
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event;
    $("install-button").hidden = false;
  });
  $("install-button").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $("install-button").hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    $("install-button").hidden = true;
    $("install-help").textContent = "Aplicación instalada y lista para abrirse sin internet.";
  });
}

renderServos();
setupProfile();
setupFaces();
setupActions();
setupSesame();
setupPwa();
updateControls();
