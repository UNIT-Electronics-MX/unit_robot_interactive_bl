"use strict";

const SERVICE_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0040";
const COMMAND_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0041";
const STATUS_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0042";
const SERVOS = ["R1", "R2", "R3", "R4", "L1", "L2", "L3", "L4"];
const $ = (id) => document.getElementById(id);

let device = null;
let commandCharacteristic = null;
let statusCharacteristic = null;
let pendingWrite = Promise.resolve();
let pcaReady = false;
let deferredInstall = null;
const cards = new Map();
let routineToken = 0;
let routineRunning = false;

function setNotice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function isConnected() {
  return Boolean(device?.gatt?.connected && commandCharacteristic);
}

function updateControls() {
  const connected = isConnected();
  const canMove = connected && pcaReady;
  $("connect-button").disabled = connected;
  $("disconnect-button").disabled = !connected;
  $("stop-button").disabled = !connected;
  $("release-button").disabled = !connected;
  $("arm-button").disabled = !connected;
  document.querySelectorAll("[data-face]").forEach((button) => { button.disabled = !connected; });
  for (const card of cards.values()) card.button.disabled = !canMove || routineRunning;
  $("all-button").disabled = !canMove || routineRunning;
  $("mirror-button").disabled = !canMove || routineRunning;
  document.querySelectorAll("[data-move]").forEach((button) => { button.disabled = !canMove || routineRunning; });
  $("support-save").disabled = !connected || routineRunning;
  $("connection-dot").classList.toggle("connected", connected);
  $("connection-label").textContent = connected ? (device.name || "Spider-BLE") + " conectado" : "Sin conectar";
  if (!connected) $("hardware-label").textContent = "Hardware sin consultar";
}

function renderServos() {
  const grid = $("servo-grid");
  for (const name of SERVOS) {
    const max = /[12]$/.test(name) ? 160 : 180;
    const card = document.createElement("article");
    card.className = "servo-card " + (name.startsWith("L") ? "left" : "right");
    const id = `angle-${name}`;
    card.innerHTML = `<div class="servo-top"><span class="servo-name"><i aria-hidden="true"></i>${name}</span><span class="servo-state">Sin datos</span></div>
      <p class="servo-current">Actual: <strong>—</strong> · Destino: <span>—</span></p>
      <div class="range-head"><label for="${id}">Ángulo</label><output for="${id}">90°</output></div>
      <input class="range" type="range" id="${id}" min="0" max="${max}" step="1" value="90">
      <div class="servo-bottom"><span class="servo-bounds">0–${max}°</span><button type="button" class="button button-secondary" disabled>Mover</button></div>`;
    const slider = card.querySelector("input");
    const output = card.querySelector("output");
    const button = card.querySelector("button");
    const state = card.querySelector(".servo-state");
    const current = card.querySelector(".servo-current strong");
    const target = card.querySelector(".servo-current span");
    let edited = false;
    slider.addEventListener("input", () => { output.value = `${slider.value}°`; edited = true; });
    button.addEventListener("click", async () => {
      if (!canSendMovement()) return;
      if (await sendCommand(`MOVE ${name} ${slider.value}`)) {
        edited = false;
        setNotice(`${name}: movimiento solicitado a ${slider.value}°.`);
      }
    });
    grid.append(card);
    cards.set(name, { slider, output, button, state, current, target, max, targetValue: null, ready: false, get edited() { return edited; } });
  }
}

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
    card.ready = enabled && pwm;
    card.targetValue = Number.isFinite(target) ? target : null;
    if (!card.edited && Number.isFinite(target)) {
      card.slider.value = String(target);
      card.output.value = `${card.slider.value}°`;
    }
  }
}

function disconnected() {
  cancelRoutine();
  for (const card of cards.values()) card.ready = false;
  commandCharacteristic = null;
  statusCharacteristic = null;
  pcaReady = false;
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
    await statusCharacteristic.startNotifications();
    statusCharacteristic.addEventListener("characteristicvaluechanged", handleStatus);
    updateControls();
    setNotice("Robot conectado. Esperando estado del hardware…");
    await sendCommand("STATUS");
  } catch (error) {
    if (device?.gatt?.connected) device.gatt.disconnect();
    commandCharacteristic = null;
    statusCharacteristic = null;
    pcaReady = false;
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
  const characteristic = commandCharacteristic;
  const bytes = new TextEncoder().encode(text);
  const write = pendingWrite.catch(() => {}).then(async () => {
    if (!isConnected() || characteristic !== commandCharacteristic) throw new Error("El robot se desconectó");
    if (characteristic.writeValueWithResponse) await characteristic.writeValueWithResponse(bytes);
    else await characteristic.writeValue(bytes);
  });
  pendingWrite = write;
  try { await write; return true; }
  catch (error) { setNotice(`No se pudo enviar «${text}»: ${error.message || error.name}`, true); return false; }
}

function canSendMovement() {
  if (isConnected() && pcaReady) return true;
  setNotice("Conecta el robot y verifica que el PCA9685 esté listo.", true);
  return false;
}

function setupActions() {
  $("connect-button").addEventListener("click", connect);
  $("disconnect-button").addEventListener("click", async () => {
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
  $("mirror-pair").addEventListener("change", (event) => {
    const max = Number(event.target.value) <= 2 ? 160 : 180;
    $("mirror-angle").max = String(max);
    if (Number($("mirror-angle").value) > max) $("mirror-angle").value = String(max);
  });
  $("mirror-button").addEventListener("click", async () => {
    if (!canSendMovement()) return;
    const pair = Number($("mirror-pair").value);
    const angle = Number($("mirror-angle").value);
    if (!Number.isInteger(angle) || angle < 0 || angle > Number($("mirror-angle").max)) {
      setNotice("Introduce un ángulo válido para el par seleccionado.", true);
      return;
    }
    if (await sendCommand(`MIRROR ${pair} ${angle}`)) setNotice(`Par ${pair}: movimiento en espejo solicitado.`);
  });
  document.querySelectorAll("[data-face]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (await sendCommand(`EYES ${button.dataset.face}`)) setNotice(`Expresión ${button.textContent} aplicada.`);
    });
  });
}

// ==========================================
// MOVIMIENTOS SESAME
// ==========================================
const STORAGE_SUPPORT = "spider-ble-support-pose";
const STORAGE_INVERT = "spider-ble-sesame-invert";
// Sentido por defecto de esta araña: + avanza la cadera o levanta el pie.
const DEFAULT_DIRECTION = { R1: 1, R2: 1, L1: -1, L2: -1, R3: 1, R4: 1, L3: 1, L4: 1 };
const DEFAULT_SPEED = 60;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

let supportPose = loadJson(STORAGE_SUPPORT, null);
const invertDirection = loadJson(STORAGE_INVERT, {});

function direction(name) {
  return DEFAULT_DIRECTION[name] * (invertDirection[name] ? -1 : 1);
}

function renderSupportPose() {
  $("support-pose").textContent = supportPose
    ? SERVOS.map((name) => `${name} ${supportPose[name]}°`).join(" · ")
    : "Sin guardar. Coloca la araña de pie con los cuatro pies apoyados y pulsa Guardar.";
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
  const loose = SERVOS.filter((name) => !cards.get(name).ready);
  if (loose.length) {
    setNotice(`Sujeta los ocho motores en la postura de apoyo antes de empezar. Sin PWM: ${loose.join(", ")}.`, true);
    return false;
  }
  return true;
}

// Convierte un cuadro de Sesame en ángulos de esta araña.
function applyFrame(pose, frame, amplitude) {
  for (const [name, angle] of Object.entries(frame.set)) {
    const value = supportPose[name] + direction(name) * sesameDelta(name, angle) * amplitude;
    pose[name] = Math.round(Math.min(cards.get(name).max, Math.max(0, value)));
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
    for (const name of SERVOS) if (!(await sendCommand(`SPEED ${name} ${speed}`))) return;
    await sendCommand(`EYES ${face}`);
    const pose = { ...supportPose };
    for (const frame of frames) {
      if (token !== routineToken) return;
      if (frame.face) await sendCommand(`EYES ${frame.face}`);
      const previous = { ...pose };
      applyFrame(pose, frame, amplitude);
      if (!(await sendPose(pose, previous, frame.wait / tempo, speed, token))) return;
    }
    if (!stay) {
      if (!(await sendPose({ ...supportPose }, pose, 200, speed, token))) return;
      await sendCommand("EYES NORMAL");
    }
    completed = true;
  } finally {
    routineRunning = false;
    if (isConnected()) for (const name of SERVOS) await sendCommand(`SPEED ${name} ${DEFAULT_SPEED}`);
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
      runFrames(gait.label, "NORMAL", gait.intro, gait.cycle, cycles, false);
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
  const invertGrid = $("sesame-invert");
  for (const name of SERVOS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = Boolean(invertDirection[name]);
    box.addEventListener("change", () => {
      invertDirection[name] = box.checked;
      localStorage.setItem(STORAGE_INVERT, JSON.stringify(invertDirection));
    });
    label.append(box, ` ${name}`);
    invertGrid.append(label);
  }
  $("support-save").addEventListener("click", () => {
    const missing = SERVOS.filter((name) => cards.get(name).targetValue === null);
    if (missing.length) { setNotice(`Aún no hay ángulo de ${missing.join(", ")}. Espera el estado del robot.`, true); return; }
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
setupActions();
setupSesame();
setupPwa();
updateControls();
