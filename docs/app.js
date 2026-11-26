"use strict";

// Interfaz de la PWA. La lógica del robot está en robot-core.js; aquí solo hay
// Bluetooth, formularios y renderizado.

const SERVICE_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0040";
const COMMAND_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0041";
const STATUS_UUID = "e85a8d40-3d8f-4af8-9bb6-71bfc98e0042";
const $ = (id) => document.getElementById(id);

let device = null;
let commandCharacteristic = null;
let statusCharacteristic = null;
let pendingWrite = Promise.resolve();
let deferredInstall = null;
let recoveryPending = false;
let renderQueued = false;
const cards = new Map();

// ==========================================
// UTILIDADES DE INTERFAZ
// ==========================================
function setNotice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function button(label, onClick, { kind = "button-secondary", needs, small = false } = {}) {
  const node = el("button", { type: "button", className: `button ${kind}${small ? " small" : ""}`, textContent: label });
  if (needs) node.dataset.needs = needs;
  node.addEventListener("click", onClick);
  return node;
}

// Ejecuta una acción del núcleo y muestra su resultado o su error.
async function act(fn, success) {
  try {
    const result = await fn();
    if (success) setNotice(typeof success === "function" ? success(result) : success);
    return result;
  } catch (error) {
    setNotice(error.message || String(error), true);
    return undefined;
  } finally {
    updateControls();
  }
}

function reportRun(result, label) {
  if (!result) return;
  if (result.status === "done") setNotice(`${label}: terminado.`);
  else if (result.status === "stopped") setNotice(`${label}: detenido.`);
  else if (result.status === "error") setNotice(`${label}: ${result.error}`, true);
}
const runAction = (label, fn) => act(fn).then((result) => reportRun(result, label));

const num = (id) => Number($(id).value);
const shown = (value) => (value === null || value === undefined ? "—" : `${round1(value)}°`);
const poseText = (pose) => SERVOS.map((n) => `${n} ${round1(pose[n])}°`).join(" · ");

function isConnected() {
  return Boolean(device?.gatt?.connected && commandCharacteristic);
}

function updateControls() {
  const connected = isConnected();
  const running = robot.run.status === "running";
  const canMove = connected && robot.pca && !running;
  document.querySelectorAll("[data-needs]").forEach((node) => {
    const need = node.dataset.needs;
    node.disabled = need === "conn" ? !connected : need === "move" ? !canMove : false;
  });
  $("connect-button").disabled = connected;
  $("disconnect-button").disabled = !connected;
  for (const id of ["stop-button", "release-button", "arm-button"]) $(id).disabled = !connected;
  $("connection-dot").classList.toggle("connected", connected);
  $("connection-label").textContent = connected ? `${device.name || "Spider-BLE"} conectado` : "Sin conectar";
  $("hardware-label").textContent = connected
    ? `PCA9685 ${robot.pca ? "listo" : "no detectado"} · OLED ${robot.oled ? "lista" : "no detectada"}${robot.fw ? ` · ${robot.fw}` : ""}`
    : "Hardware sin consultar";
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderLive();
  });
}

// ==========================================
// BLUETOOTH
// ==========================================
async function writeCommand(text) {
  if (!isConnected()) return false;
  const characteristic = commandCharacteristic;
  const bytes = new TextEncoder().encode(text);
  const write = pendingWrite.catch(() => {}).then(async () => {
    if (!isConnected() || characteristic !== commandCharacteristic) throw new Error("El robot se desconectó");
    if (characteristic.writeValueWithResponse) await characteristic.writeValueWithResponse(bytes);
    else await characteristic.writeValue(bytes);
  });
  pendingWrite = write;
  try { await write; return true; } catch { return false; }
}

function handleStatus(event) {
  const parts = new TextDecoder().decode(event.target.value).trim().split(",");
  if (parts[0] === "P" && parts.length >= 4) {
    onHeader(parts[1] === "1", parts[2] === "1", parts[3]);
    if (!robot.pca) setNotice("PCA9685 no detectado. Revisa alimentación y cableado I²C antes de mover el robot.", true);
  } else if (parts[0] === "S" && parts.length >= 6 && SERVOS.includes(parts[1])) {
    onServoStatus(parts[1], Number(parts[2]), Number(parts[3]), parts[4] === "1", parts[5] === "1");
    if (recoveryPending && allReported()) {
      recoveryPending = false;
      recover();
    }
  }
}

async function recover() {
  const result = await act(() => recoverOnConnect());
  if (!result) return;
  if (!result.applied) {
    setNotice(`Motores sujetos (${result.holding.join(", ")}): se envió solo la velocidad. Pulsa «Enviar perfil al robot» con la araña apoyada para aplicar rangos e inversión.`, true);
  } else if (result.restored === "startup") setNotice("Perfil enviado y postura acostada aplicada con POSE_HOLD.");
  else if (result.restored === "stance") setNotice("Perfil enviado; recuperando la postura de apoyo guardada.");
  else setNotice("Perfil de la página enviado al robot. Los motores siguen libres hasta el primer movimiento.");
}

function disconnected() {
  cancelRun();
  robot.transport = null;
  commandCharacteristic = null;
  statusCharacteristic = null;
  recoveryPending = false;
  resetTelemetry();
  updateControls();
  setNotice("Robot desconectado. El firmware detuvo las trayectorias activas.");
}

async function connect() {
  if (!navigator.bluetooth) { setNotice("Este navegador no admite Web Bluetooth. Usa Chrome o Edge en Android o escritorio.", true); return; }
  if (!window.isSecureContext) { setNotice("Abre la aplicación mediante HTTPS o localhost para usar Bluetooth.", true); return; }
  $("connect-button").disabled = true;
  setNotice("Buscando Spider-BLE…");
  try {
    const selected = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: "Spider-BLE" }], optionalServices: [SERVICE_UUID] });
    if (device) device.removeEventListener("gattserverdisconnected", disconnected);
    device = selected;
    device.addEventListener("gattserverdisconnected", disconnected);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    commandCharacteristic = await service.getCharacteristic(COMMAND_UUID);
    statusCharacteristic = await service.getCharacteristic(STATUS_UUID);
    resetTelemetry();
    loadRobot(device.id || device.name || "default");
    robot.transport = writeCommand;
    recoveryPending = true;
    await statusCharacteristic.startNotifications();
    statusCharacteristic.addEventListener("characteristicvaluechanged", handleStatus);
    setNotice("Robot conectado. Leyendo estado para aplicar el perfil de la página…");
    await writeCommand("STATUS");
  } catch (error) {
    if (device?.gatt?.connected) device.gatt.disconnect();
    robot.transport = null;
    commandCharacteristic = null;
    recoveryPending = false;
    if (error.name === "NotFoundError") setNotice("No se seleccionó ningún robot.");
    else setNotice(`No se pudo conectar: ${error.message || error.name}`, true);
  } finally {
    updateControls();
  }
}

// ==========================================
// PESTAÑAS Y CONTROL INMEDIATO
// ==========================================
function setupTabs() {
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((other) => other.classList.toggle("active", other === tab));
      document.querySelectorAll(".tab-page").forEach((page) => { page.hidden = page.id !== `tab-${tab.dataset.tab}`; });
    });
  });
}

function setupSafety() {
  $("connect-button").addEventListener("click", connect);
  $("disconnect-button").addEventListener("click", async () => {
    cancelRun();
    if (isConnected()) await writeCommand("STOP");
    if (device?.gatt?.connected) device.gatt.disconnect();
  });
  $("stop-button").addEventListener("click", () => act(() => actStop(), "Movimiento detenido. Los servos conservan su posición actual."));
  $("release-button").addEventListener("click", () => act(() => actRelease(), "Servos liberados. Pulsa Habilitar antes de moverlos de nuevo."));
  $("arm-button").addEventListener("click", () => act(() => actArm(), "Servos habilitados. Los pulsos se activan al recibir movimiento."));
}

function renderRunStatus() {
  const run = robot.run;
  const text = {
    idle: "Sin rutinas en marcha.",
    running: `En marcha: ${run.name} · paso ${run.step}/${run.total}${run.repeat !== 1 ? ` · vuelta ${run.loop}${run.repeat ? `/${run.repeat}` : ""}` : ""}`,
    done: `Terminó: ${run.name}.`,
    stopped: `Detenida: ${run.name}.`,
    error: `Error en ${run.name}: ${run.error}`
  }[run.status];
  $("run-status").textContent = text;
  $("run-status").classList.toggle("error-text", run.status === "error");
}

// ==========================================
// SERVOMOTORES
// ==========================================
function renderServoCards() {
  const grid = $("servo-grid");
  for (const name of SERVOS) {
    const id = `angle-${name}`;
    const card = el("article", { className: `servo-card ${name.startsWith("L") ? "left" : "right"}` });
    card.innerHTML = `<div class="servo-top"><span class="servo-name"><i aria-hidden="true"></i>${name}</span><span class="servo-state">Sin datos</span></div>
      <p class="servo-current">Actual: <strong>—</strong> · Destino: <span>—</span></p>
      <div class="range-head"><label for="${id}">Ángulo</label><output for="${id}">90°</output></div>
      <input class="range" type="range" id="${id}" step="1" value="90">
      <div class="servo-bottom"><span class="servo-bounds"></span><span class="servo-speed"></span></div>`;
    const slider = card.querySelector("input");
    const output = card.querySelector("output");
    let edited = false;
    slider.addEventListener("input", () => { output.value = `${slider.value}°`; edited = true; });
    const actions = el("div", { className: "servo-actions" }, [
      button("Mover", () => act(() => actMove(name, Number(slider.value)), `${name}: movimiento a ${slider.value}°.`).then(() => { edited = false; }), { needs: "move", small: true }),
      button("Sujetar", () => act(() => actVerb("HOLD", name), `${name}: PWM activo en su ángulo actual.`), { needs: "conn", small: true }),
      button("Liberar", () => act(() => actVerb("FREE", name), `${name}: liberado.`), { needs: "conn", small: true }),
      button("Activar", () => act(() => actVerb("ENABLE", name), `${name}: habilitado.`), { needs: "conn", small: true })
    ]);
    card.append(actions);
    grid.append(card);
    cards.set(name, {
      slider, output, state: card.querySelector(".servo-state"), current: card.querySelector(".servo-current strong"),
      target: card.querySelector(".servo-current span"), bounds: card.querySelector(".servo-bounds"), speed: card.querySelector(".servo-speed"),
      get edited() { return edited; }
    });
  }
}

function renderServoRanges() {
  for (const n of SERVOS) {
    const card = cards.get(n);
    const { min, max, speed } = cfg(n);
    card.slider.min = String(min);
    card.slider.max = String(max);
    card.slider.value = String(clamp(Number(card.slider.value), min, max));
    card.output.value = `${card.slider.value}°`;
    card.bounds.textContent = `${min}–${max}°`;
    card.speed.textContent = `${firmwareSpeed(n)} °/s`;
  }
  const allMin = Math.max(...SERVOS.map((n) => cfg(n).min));
  const allMax = Math.min(...SERVOS.map((n) => cfg(n).max));
  const all = $("all-angle");
  all.min = String(allMin);
  all.max = String(allMax);
  all.value = String(clamp(Number(all.value), allMin, allMax));
  $("all-angle-value").value = `${all.value}°`;
  $("all-range").textContent = `Rango común: ${allMin}–${allMax}°`;
  const right = SERVOS[num("mirror-pair") - 1];
  $("mirror-angle").min = String(cfg(right).min);
  $("mirror-angle").max = String(cfg(right).max);
  const speeds = new Set(SERVOS.map((n) => cfg(n).speed));
  $("speed-time-info").textContent = speeds.size === 1
    ? `Ahora: ${[...speeds][0]} °/s ≈ ${round1(90 / [...speeds][0])} s por 90°.` : "Los motores tienen velocidades distintas.";
}

function renderServoLive() {
  for (const n of SERVOS) {
    const card = cards.get(n);
    const t = robot.telemetry[n];
    card.current.textContent = shown(current(n));
    card.target.textContent = shown(target(n));
    card.state.textContent = !t ? "Sin datos" : !t.en ? "Deshabilitado" : t.pwm ? "PWM activo" : "Libre";
    card.state.className = `servo-state ${t?.pwm ? "active" : "free"}`;
    card.speed.textContent = `${firmwareSpeed(n)} °/s`;
    const goal = target(n);
    if (!card.edited && goal !== null) {
      card.slider.value = String(Math.round(goal));
      card.output.value = `${card.slider.value}°`;
    }
  }
}

function renderProfileTable(source = robot.profile.servos) {
  const body = $("profile-rows");
  body.replaceChildren();
  for (const n of SERVOS) {
    const p = source[n];
    const hard = DEFAULT_SERVO_PROFILE[n];
    const row = el("tr", { dataset: { servo: n } });
    row.innerHTML = `<th scope="row">${n}</th>
      <td><input type="number" data-key="min" min="${hard.min}" max="${hard.max}" value="${p.min}" aria-label="${n} mínimo"></td>
      <td><input type="number" data-key="max" min="${hard.min}" max="${hard.max}" value="${p.max}" aria-label="${n} máximo"></td>
      <td><input type="number" data-key="speed" min="1" max="180" value="${p.speed}" aria-label="${n} velocidad"></td>
      <td><input type="checkbox" data-key="invert" ${p.invert ? "checked" : ""} aria-label="${n} invertido"></td>
      <td class="muted">${hard.min}–${hard.max}°</td>`;
    body.append(row);
  }
}

function readProfileTable() {
  const next = {};
  for (const row of $("profile-rows").querySelectorAll("tr")) {
    const field = (key) => row.querySelector(`[data-key="${key}"]`);
    next[row.dataset.servo] = { min: Number(field("min").value), max: Number(field("max").value), speed: Number(field("speed").value), invert: field("invert").checked };
  }
  return next;
}

function setupServos() {
  renderServoCards();
  $("all-angle").addEventListener("input", (event) => { $("all-angle-value").value = `${event.target.value}°`; });
  $("all-button").addEventListener("click", () => act(() => actAll(num("all-angle")), `Ocho servos hacia ${$("all-angle").value}°.`));
  $("center-button").addEventListener("click", () => act(() => actCenter(), "Ocho servos hacia 90° (dentro de su rango)."));
  $("mirror-pair").addEventListener("change", renderServoRanges);
  $("mirror-button").addEventListener("click", () => {
    const pair = num("mirror-pair");
    const right = SERVOS[pair - 1];
    const angle = num("mirror-angle");
    if (!Number.isInteger(angle) || !inRange(right, angle)) { setNotice(`Indica un ángulo entre ${cfg(right).min} y ${cfg(right).max}° para ${right}.`, true); return; }
    act(() => actMirror(pair, angle), `Par ${pair}: movimiento en espejo.`);
  });
  $("speed-time-button").addEventListener("click", () => {
    const seconds = num("speed-time");
    if (!(seconds >= 0.5 && seconds <= 90)) { setNotice("Indica entre 0,5 y 90 segundos.", true); return; }
    const speed = clamp(Math.round((90 / seconds) * 10) / 10, 1, 180);
    act(() => actSpeedAll(speed), `Velocidad general: ${speed} °/s (${seconds} s por 90°).`);
  });
  $("profile-save").addEventListener("click", () => act(() => saveServoProfile(readProfileTable()),
    isConnected() ? "Perfil guardado. Pulsa «Enviar perfil al robot» para aplicarlo al ESP32." : "Perfil guardado. Se enviará al conectar el robot."));
  $("profile-reset").addEventListener("click", () => {
    renderProfileTable(DEFAULT_SERVO_PROFILE);
    setNotice("Valores de fábrica cargados en el editor. Pulsa «Guardar perfil» para conservarlos.");
  });
  $("profile-send").addEventListener("click", () => {
    const holding = SERVOS.filter(held);
    if (holding.length && !window.confirm(`Enviar rangos e inversión libera el PWM de los motores sujetos (${holding.join(", ")}). Si la araña está de pie, se caerá. ¿Continuar?`)) return;
    act(async () => { cancelRun(); await applyProfile(); }, "Perfil enviado: rangos, inversión y velocidad. Los motores quedan libres hasta el siguiente movimiento.");
  });
}

// ==========================================
// MOVER PATAS
// ==========================================
const legCards = new Map();

function setupLegs() {
  const pad = $("leg-pad");
  for (const leg of ["L1", "R1", "L2", "R2"]) {
    const info = LEGS[leg];
    const values = el("p", { className: "leg-values" });
    const jog = (servo, sign) => () => {
      const step = num("jog-step");
      if (!(step >= 1 && step <= 180)) { setNotice("El paso manual debe ser de 1–180°.", true); return; }
      const base = target(servo);
      if (base === null) { setNotice(`Aún no hay estado de ${servo}.`, true); return; }
      const angle = base + sign() * step;
      if (!inRange(servo, angle)) { setNotice(`${servo} quedaría en ${round1(angle)}°, fuera de ${cfg(servo).min}°–${cfg(servo).max}°.`, true); return; }
      act(() => actMove(servo, angle), `${info.label}: ${servo} hacia ${round1(angle)}°.`);
    };
    const card = el("article", { className: "leg-card" }, [
      el("h3", { textContent: `${info.label}` }),
      el("p", { className: "small-note", textContent: `Giro ${info.swing} · Elevación ${info.lift}` }),
      values,
      el("div", { className: "leg-buttons" }, [
        button("▲ Adelante", jog(info.swing, () => forwardSign(info.swing)), { needs: "move", small: true }),
        button("▼ Atrás", jog(info.swing, () => -forwardSign(info.swing)), { needs: "move", small: true }),
        button("⤒ Arriba", jog(info.lift, () => 1), { needs: "move", small: true }),
        button("⤓ Abajo", jog(info.lift, () => -1), { needs: "move", small: true })
      ])
    ]);
    legCards.set(leg, values);
    pad.append(card);
  }

  $("stance-save").addEventListener("click", () => act(() => saveStance(), "Postura de apoyo guardada y recuperación automática activada. Calibra de nuevo las elevaciones."));
  $("stance-restore").addEventListener("click", () => act(() => restoreStance(), "Recuperando la postura de apoyo."));
  $("stance-auto").addEventListener("change", (event) => act(() => setAutoStance(event.target.checked),
    event.target.checked ? "Se recuperará la postura de apoyo al conectar tras un reinicio." : "Recuperación automática desactivada."));

  $("swing-save").addEventListener("click", () => {
    const motors = {};
    for (const row of $("swing-rows").querySelectorAll("tr")) {
      const field = (key) => row.querySelector(`[data-key="${key}"]`);
      motors[row.dataset.servo] = { min: Number(field("min").value), max: Number(field("max").value), forward: Number(field("forward").value) };
    }
    act(() => saveWalkSwing(motors), "Recorrido y sentido de avance guardados para este robot.");
  });

  const liftRows = $("lift-rows");
  for (const n of LIFT_SERVOS) {
    const input = el("input", { type: "number", min: 1, max: 180, value: 10, ariaLabel: `Subida de ${n}` });
    const confirm = el("input", { type: "checkbox" });
    input.addEventListener("input", () => { confirm.checked = false; });
    const leg = LEGS[LEG_OF[n]];
    liftRows.append(el("div", { className: "lift-row", dataset: { servo: n } }, [
      el("strong", { textContent: `${n}` }), el("span", { className: "small-note", textContent: leg.label }),
      el("span", { className: "inline-fields" }, [input, el("span", { className: "unit", textContent: "°" })]),
      button("Probar subir y bajar", () => runAction(`Prueba de ${n}`, () => testLift(n, Number(input.value))), { needs: "move", small: true }),
      el("label", { className: "check" }, [confirm, " Sí se despegó"])
    ]));
  }
  $("lifts-save").addEventListener("click", () => {
    const lifts = {};
    const missing = [];
    for (const row of liftRows.querySelectorAll(".lift-row")) {
      const [input, confirm] = row.querySelectorAll("input");
      lifts[row.dataset.servo] = Number(input.value);
      if (!confirm.checked) missing.push(row.dataset.servo);
    }
    if (missing.length) { setNotice(`Confirma visualmente que el pie se despega en: ${missing.join(", ")}.`, true); return; }
    act(() => saveWalkLifts(lifts), "Elevaciones guardadas para este robot.");
  });

  $("walk-one").addEventListener("click", () => runAction("Paso de caminata", () => walk(num("walk-stride"), 1)));
  $("walk-three").addEventListener("click", () => runAction("Tres pasos", () => walk(num("walk-stride"), 3)));

  $("startup-save").addEventListener("click", () => {
    const pose = startupFromBlocks(blocksDraft.blocks);
    if (!pose) { setNotice("El programa actual de Bloques debe empezar con ocho bloques Servo, uno por motor.", true); return; }
    act(() => saveStartupPose(pose, true), "Postura acostada guardada y aplicada con POSE_HOLD. Se aplicará al conectar tras cada reinicio.");
  });
  $("startup-restore").addEventListener("click", () => act(() => restoreStartupPose(), "Postura acostada aplicada."));
  $("startup-auto").addEventListener("change", (event) => act(() => setAutoStartup(event.target.checked),
    event.target.checked ? "Se aplicará la postura acostada al conectar tras un reinicio." : "Inicio acostado automático desactivado.")
    .then(() => renderLegsProfile()));
}

function renderLegsProfile() {
  const p = robot.profile;
  $("stance-info").textContent = p.stance ? poseText(p.stance) : "Sin postura de apoyo guardada.";
  $("stance-auto").checked = p.autoStance;
  $("startup-info").textContent = p.startupPose ? poseText(p.startupPose) : "Sin postura de inicio guardada.";
  $("startup-auto").checked = p.autoStartup;
  const body = $("swing-rows");
  body.replaceChildren();
  for (const n of SWING_SERVOS) {
    let spec;
    try { spec = walkSwingSpec(n); } catch { spec = { min: cfg(n).min, max: cfg(n).max, forward: LEGS[LEG_OF[n]].forward }; }
    const row = el("tr", { dataset: { servo: n } });
    row.innerHTML = `<th scope="row">${n}</th>
      <td><input type="number" data-key="min" min="${cfg(n).min}" max="${cfg(n).max}" value="${spec.min}"></td>
      <td><input type="number" data-key="max" min="${cfg(n).min}" max="${cfg(n).max}" value="${spec.max}"></td>
      <td><select data-key="forward"><option value="1">subir grados</option><option value="-1">bajar grados</option></select></td>
      <td class="muted" data-room>—</td>`;
    row.querySelector("select").value = String(spec.forward);
    body.append(row);
  }
  for (const row of $("lift-rows").querySelectorAll(".lift-row")) {
    const saved = p.walkLifts?.[row.dataset.servo];
    const [input, confirm] = row.querySelectorAll("input");
    if (saved) { input.value = String(saved); confirm.checked = true; }
  }
  $("lifts-info").textContent = p.walkLifts ? `Guardadas: ${LIFT_SERVOS.map((n) => `${n} ${p.walkLifts[n]}°`).join(" · ")}` : "Sin elevaciones guardadas.";
}

function renderLegsLive() {
  for (const [leg, node] of legCards) {
    const { swing, lift } = LEGS[leg];
    node.textContent = `${swing} ${shown(current(swing))} · ${lift} ${shown(current(lift))}`;
  }
  for (const row of $("swing-rows").querySelectorAll("tr")) {
    const n = row.dataset.servo;
    const goal = target(n);
    const min = Number(row.querySelector('[data-key="min"]').value);
    const max = Number(row.querySelector('[data-key="max"]').value);
    const forward = Number(row.querySelector('[data-key="forward"]').value);
    row.querySelector("[data-room]").textContent = goal === null ? "—" : `${round1(forward > 0 ? max - goal : goal - min)}°`;
  }
  const p = robot.profile;
  const checks = [
    ["Postura de apoyo guardada", Boolean(p.stance)],
    ["Robot en la postura de apoyo", atStance()],
    ["Recorrido de avance guardado", Boolean(p.walkSwing)],
    ["Elevaciones de las cuatro patas guardadas", Boolean(p.walkLifts)]
  ];
  $("walk-checks").replaceChildren(...checks.map(([label, okay]) => el("li", { className: okay ? "ok" : "pending", textContent: `${okay ? "✓" : "○"} ${label}` })));
}

// ==========================================
// BLOQUES
// ==========================================
const BLOCK_TYPES = {
  servo: { label: "Servo individual", make: () => ({ type: "servo", motor: "R1", angle: Math.round(target("R1") ?? 90) }) },
  move: { label: "Mover pata", make: () => ({ type: "move", leg: "R1", direction: "up", degrees: 5 }) },
  leg_step: { label: "Paso de pata", make: () => ({ type: "leg_step", leg: "R1", stride: 5, lift: 10 }) },
  walk_cycle: { label: "Caminata", make: () => ({ type: "walk_cycle", legs: Object.fromEntries(["R1", "L2", "L1", "R2"].map((l) => [l, { stride: 5, lift: 20 }])), pause: 0 }) },
  face: { label: "Cara", make: () => ({ type: "face", name: "normal", transition_ms: 250, duration_ms: 0 }) },
  wait: { label: "Esperar", make: () => ({ type: "wait", seconds: 0.5 }) },
  home: { label: "Volver al inicio", make: () => ({ type: "home" }) },
  routine: { label: "Rutina guardada", make: () => ({ type: "routine", name: Object.keys(robot.routines)[0] || "", times: 1 }) },
  program: { label: "Programa guardado", make: () => ({ type: "program", name: Object.keys(robot.programs)[0] || "", times: 1 }) }
};
const LEG_OPTIONS = Object.entries(LEGS).map(([id, leg]) => [id, `${leg.label} · ${leg.swing}/${leg.lift}`]);
const DIRECTION_OPTIONS = [["forward", "Adelante"], ["back", "Atrás"], ["up", "Arriba"], ["down", "Abajo"]];

let blocksDraft = { name: "", description: "", cycles: 1, blocks: [] };
const blocksKey = () => `spider-ble-blocks:${robot.id}`;

function saveBlocksDraft() {
  storage.set(blocksKey(), blocksDraft);
  refreshBlocksMeta();
}

function blockFields(block) {
  const integer = (key, label, min, max) => ({ key, label, kind: "number", min, max, step: 1, integer: true });
  const degrees = (key, label) => ({ key, label, kind: "number", min: 0.5, max: 180, step: 0.5 });
  switch (block.type) {
    case "servo": return [{ key: "motor", label: "Motor", kind: "select", options: SERVOS.map((n) => [n, n]) }, { key: "angle", label: "Ángulo", kind: "number", min: 0, max: 180, step: 1 }];
    case "move": return [{ key: "leg", label: "Pata", kind: "select", options: LEG_OPTIONS }, { key: "direction", label: "Dirección", kind: "select", options: DIRECTION_OPTIONS }, degrees("degrees", "Grados")];
    case "leg_step": return [{ key: "leg", label: "Pata", kind: "select", options: LEG_OPTIONS }, degrees("stride", "Avance"), degrees("lift", "Subida")];
    case "walk_cycle": return [...["R1", "L2", "L1", "R2"].flatMap((leg) => [degrees(`legs.${leg}.stride`, `${leg} avance`), degrees(`legs.${leg}.lift`, `${leg} subida`)]),
      { key: "pause", label: "Pausa entre pares (s)", kind: "number", min: 0, max: 5, step: 0.1 }];
    case "face": return [{ key: "name", label: "Cara", kind: "select", options: Object.keys(robot.faces).map((n) => [n, n]) },
      integer("transition_ms", "Transición ms", 0, 5000), integer("duration_ms", "Duración ms", 0, 600000)];
    case "wait": return [{ key: "seconds", label: "Segundos", kind: "number", min: 0, max: 5, step: 0.1 }];
    case "routine": return [{ key: "name", label: "Rutina", kind: "select", options: Object.keys(robot.routines).map((n) => [n, n]) }, integer("times", "Veces", 1, 3)];
    case "program": return [{ key: "name", label: "Programa", kind: "select", options: Object.keys(robot.programs).filter((n) => n !== blocksDraft.name).map((n) => [n, n]) }, integer("times", "Veces", 1, 3)];
    default: return [];
  }
}

const getPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((value, key) => value[key], object)[last] = value;
}

function renderBlocks() {
  const list = $("blocks-list");
  list.replaceChildren();
  blocksDraft.blocks.forEach((block, index) => {
    const fields = blockFields(block).map((field) => {
      const value = getPath(block, field.key);
      let input;
      if (field.kind === "select") {
        input = el("select", {}, field.options.map(([id, label]) => el("option", { value: id, textContent: label })));
        if (!field.options.some(([id]) => id === value)) input.prepend(el("option", { value, textContent: value || "(elige)" }));
        input.value = value;
      } else {
        input = el("input", { type: "number", min: field.min, max: field.max, step: field.step, value });
      }
      input.addEventListener("change", () => {
        const next = field.kind === "select" ? input.value : field.integer ? parseInt(input.value, 10) : Number(input.value);
        setPath(block, field.key, next);
        saveBlocksDraft();
      });
      return el("label", { className: "block-field" }, [field.label, input]);
    });
    const move = (delta) => () => {
      const other = index + delta;
      if (other < 0 || other >= blocksDraft.blocks.length) return;
      [blocksDraft.blocks[index], blocksDraft.blocks[other]] = [blocksDraft.blocks[other], blocksDraft.blocks[index]];
      saveBlocksDraft();
      renderBlocks();
    };
    const remove = () => { blocksDraft.blocks.splice(index, 1); saveBlocksDraft(); renderBlocks(); };
    list.append(el("li", { className: `block block-${block.type}` }, [
      el("div", { className: "block-head" }, [
        el("strong", { textContent: `${index + 1}. ${BLOCK_TYPES[block.type]?.label || block.type}` }),
        el("span", { className: "block-tools" }, [button("↑", move(-1), { small: true }), button("↓", move(1), { small: true }), button("✕", remove, { small: true })])
      ]),
      fields.length ? el("div", { className: "block-fields" }, fields) : null
    ]));
  });
  if (!blocksDraft.blocks.length) list.append(el("li", { className: "empty", textContent: "Añade bloques desde la paleta." }));
  refreshBlocksMeta();
}

function refreshBlocksMeta() {
  const count = blocksDraft.blocks.length ? countProgramSteps(blocksDraft.blocks, blocksDraft.cycles) : 0;
  $("blocks-count").textContent = count === null ? "REVISA LOS BLOQUES" : `${count} PASOS`;
  $("program-convert").hidden = !convertibleSteps(blocksDraft.blocks);
  let error = "";
  if (blocksDraft.blocks.length) {
    try { expandProgramBlocks(blocksDraft.blocks, blocksDraft.cycles); } catch (e) { error = e.message; }
  }
  $("blocks-error").textContent = error;
}

function loadBlocksDraft() {
  blocksDraft = storage.get(blocksKey(), null) || { name: "", description: "", cycles: 1, blocks: [] };
  $("program-name").value = blocksDraft.name;
  $("program-description").value = blocksDraft.description;
  $("program-cycles").value = String(blocksDraft.cycles);
  renderBlocks();
}

function setupBlocks() {
  const palette = $("block-palette");
  for (const [type, spec] of Object.entries(BLOCK_TYPES)) {
    palette.append(button(`+ ${spec.label}`, () => {
      if (blocksDraft.blocks.length >= 60) { setNotice("Máximo 60 bloques por programa.", true); return; }
      blocksDraft.blocks.push(spec.make());
      saveBlocksDraft();
      renderBlocks();
    }, { small: true, kind: `button-secondary palette-${type}` }));
  }
  $("program-name").addEventListener("input", (event) => { blocksDraft.name = event.target.value; saveBlocksDraft(); });
  $("program-description").addEventListener("input", (event) => { blocksDraft.description = event.target.value; saveBlocksDraft(); });
  $("program-cycles").addEventListener("change", (event) => { blocksDraft.cycles = Number(event.target.value); saveBlocksDraft(); });
  $("program-run").addEventListener("click", () => {
    if (programNeedsStance(blocksDraft.blocks) && !atStance()) { setNotice("Este programa usa una rutina relativa a la postura de apoyo: recupérala antes de ejecutar.", true); return; }
    runAction("Programa de bloques", () => runProgramBlocks("programa_de_bloques", blocksDraft.blocks, blocksDraft.cycles));
  });
  $("program-save").addEventListener("click", () => act(() => {
    const key = saveProgram(blocksDraft.name, blocksDraft);
    blocksDraft.name = key;
    $("program-name").value = key;
    saveBlocksDraft();
    return key;
  }, (key) => `Programa «${key}» guardado.`));
  $("program-new").addEventListener("click", () => {
    blocksDraft = { name: "", description: "", cycles: 1, blocks: [] };
    saveBlocksDraft();
    loadBlocksDraft();
  });
  $("program-convert").addEventListener("click", () => {
    const conversion = convertibleSteps(blocksDraft.blocks);
    if (!conversion) return;
    blocksDraft.blocks.splice(conversion.first, conversion.last - conversion.first + 1, { type: "walk_cycle", legs: conversion.legs, pause: conversion.pause });
    saveBlocksDraft();
    renderBlocks();
    setNotice("Los cuatro pasos se convirtieron en un bloque Caminata.");
  });
}

function renderProgramsList() {
  const items = Object.entries(robot.programs).map(([name, program]) => el("div", { className: "item" }, [
    el("div", {}, [el("strong", { textContent: name }), el("span", { className: "small-note", textContent: ` ${program.blocks.length} bloques · ${program.cycles} ciclo(s)${program.description ? ` · ${program.description}` : ""}` })]),
    el("span", { className: "item-tools" }, [
      button("Cargar", () => {
        blocksDraft = { name, description: program.description || "", cycles: program.cycles, blocks: clone(program.blocks) };
        saveBlocksDraft();
        loadBlocksDraft();
        setNotice(`Programa «${name}» cargado en el editor.`);
      }, { small: true }),
      button("▶", () => runSavedProgram(name), { small: true, needs: "move" }),
      button("Borrar", () => { if (window.confirm(`¿Borrar el programa «${name}»?`)) act(() => deleteProgram(name), `Programa «${name}» borrado.`); }, { small: true })
    ])
  ]));
  $("programs-list").replaceChildren(...(items.length ? items : [el("p", { className: "small-note", textContent: "Aún no hay programas guardados." })]));
}

function runSavedProgram(name) {
  const program = robot.programs[name];
  if (program && programNeedsStance(program.blocks) && !atStance()) { setNotice(`«${name}» usa una rutina relativa a la postura de apoyo: recupérala antes de ejecutar.`, true); return; }
  runAction(`Programa «${name}»`, () => runProgram(name));
}

// ==========================================
// PROBADOR RÁPIDO
// ==========================================
let sequence = { frames: [], cycles: 1 };
const sequenceKey = () => `spider-ble-sequence:${robot.id}`;

function saveSequence() {
  storage.set(sequenceKey(), sequence);
  renderSequence();
}

function sequenceRangeIssue(offsets) {
  for (const [n, delta] of Object.entries(offsets)) {
    const base = current(n);
    if (Math.abs(delta) > 180) return n;
    if (base !== null && !inRange(n, base + delta)) return n;
  }
  return null;
}

function appendFrames(frames) {
  if (sequence.frames.length + frames.length > 40) { $("seq-error").textContent = "Máximo 40 pasos por prueba."; return; }
  const issue = frames.map((frame) => sequenceRangeIssue(frame.offsets)).find(Boolean);
  if (issue) { $("seq-error").textContent = `${issue} excedería su rango desde la postura actual.`; return; }
  sequence.frames.push(...frames);
  $("seq-error").textContent = "";
  saveSequence();
}

function setupSequence() {
  $("seq-leg").replaceChildren(...LEG_OPTIONS.map(([id, label]) => el("option", { value: id, textContent: label })));
  const legs = $("seq-legs");
  for (const [id, leg] of Object.entries(LEGS)) {
    legs.append(el("div", { className: "seq-leg", dataset: { leg: id } }, [
      el("label", { className: "check" }, [el("input", { type: "checkbox" }), ` ${leg.label}`]),
      el("label", {}, ["Avance", el("input", { type: "number", min: 1, max: 180, value: 5, dataset: { key: "stride" } })]),
      el("label", {}, ["Subida", el("input", { type: "number", min: 1, max: 180, value: 10, dataset: { key: "lift" } })])
    ]));
  }
  const pause = () => {
    const value = num("seq-pause");
    if (!(value >= 0 && value <= 2)) throw new RobotError("La pausa debe ser de 0–2 s.");
    return value;
  };
  $("seq-add").addEventListener("click", () => {
    try {
      const leg = LEGS[$("seq-leg").value];
      const direction = $("seq-direction").value;
      const degrees = num("seq-degrees");
      if (!(degrees > 0 && degrees <= 180)) throw new RobotError("Indica más de 0° y hasta 180°.");
      const servo = ["forward", "back"].includes(direction) ? leg.swing : leg.lift;
      const sign = direction === "forward" ? forwardSign(leg.swing) : direction === "back" ? -forwardSign(leg.swing) : direction === "up" ? 1 : -1;
      const last = sequence.frames.at(-1)?.offsets ?? {};
      const offsets = { ...last, [servo]: (last[servo] || 0) + sign * degrees };
      if (!offsets[servo]) delete offsets[servo];
      const label = `${leg.label}: ${DIRECTION_OPTIONS.find(([id]) => id === direction)[1]} ${degrees}° (${servo})`;
      appendFrames([{ label, offsets, wait: pause() }]);
    } catch (error) { $("seq-error").textContent = error.message; }
  });
  $("seq-step").addEventListener("click", () => {
    try {
      const selected = [...legs.querySelectorAll(".seq-leg")].filter((row) => row.querySelector("input[type=checkbox]").checked);
      if (!selected.length) throw new RobotError("Selecciona al menos una pata para este paso.");
      const wait = pause();
      const raised = {};
      const advanced = {};
      for (const row of selected) {
        const leg = LEGS[row.dataset.leg];
        const stride = Number(row.querySelector('[data-key="stride"]').value);
        const lift = Number(row.querySelector('[data-key="lift"]').value);
        if (!(stride > 0 && stride <= 180 && lift > 0 && lift <= 180)) throw new RobotError("Cada avance y subida debe ser mayor que 0° y hasta 180°.");
        raised[leg.lift] = lift;
        advanced[leg.swing] = forwardSign(leg.swing) * stride;
      }
      const label = selected.map((row) => LEGS[row.dataset.leg].swing).join(" + ");
      const prefix = sequence.frames.length && Object.keys(sequence.frames.at(-1).offsets).length ? [{ label: "Volver a la postura inicial", offsets: {}, wait }] : [];
      appendFrames([...prefix,
        { label: `${label}: subir`, offsets: { ...raised }, wait },
        { label: `${label}: adelantar`, offsets: { ...raised, ...advanced }, wait },
        { label: `${label}: bajar`, offsets: { ...advanced }, wait },
        { label: "Volver a la postura inicial", offsets: {}, wait }]);
    } catch (error) { $("seq-error").textContent = error.message; }
  });
  $("seq-cycles").addEventListener("change", (event) => { sequence.cycles = Number(event.target.value); saveSequence(); });
  $("seq-test").addEventListener("click", () => runAction("Prueba rápida", () => quickTest(sequence.frames, sequence.cycles)));
  $("seq-save").addEventListener("click", () => act(() => quickSave($("seq-name").value, sequence.frames, sequence.cycles),
    (key) => `Secuencia guardada como rutina «${key}». Solo se ejecuta desde la postura con la que se guardó.`));
  $("seq-clear").addEventListener("click", () => { sequence.frames = []; saveSequence(); });
}

function loadSequence() {
  sequence = storage.get(sequenceKey(), null) || { frames: [], cycles: 1 };
  $("seq-cycles").value = String(sequence.cycles);
  renderSequence();
}

function renderSequence() {
  const list = $("seq-frames");
  list.replaceChildren(...sequence.frames.map((frame, index) => {
    const move = (delta) => () => {
      const other = index + delta;
      if (other < 0 || other >= sequence.frames.length) return;
      [sequence.frames[index], sequence.frames[other]] = [sequence.frames[other], sequence.frames[index]];
      saveSequence();
    };
    const offsets = Object.entries(frame.offsets).map(([n, v]) => `${n} ${v > 0 ? "+" : ""}${v}°`).join(", ") || "postura inicial";
    return el("li", { className: "frame" }, [
      el("span", {}, [el("strong", { textContent: frame.label }), el("span", { className: "small-note", textContent: ` · ${offsets}${frame.wait ? ` · pausa ${frame.wait}s` : ""}` })]),
      el("span", { className: "block-tools" }, [button("↑", move(-1), { small: true }), button("↓", move(1), { small: true }),
        button("✕", () => { sequence.frames.splice(index, 1); saveSequence(); }, { small: true })])
    ]);
  }));
  $("seq-count").textContent = `${sequence.frames.length}/40 PASOS`;
}

// ==========================================
// RUTINAS
// ==========================================
function renderRoutinesList() {
  const make = (name, routine, demo) => el("div", { className: "item" }, [
    el("div", {}, [el("strong", { textContent: name }), el("span", { className: "small-note", textContent: ` ${routine.steps.length} pasos${routine.description ? ` · ${routine.description}` : ""}` })]),
    el("span", { className: "item-tools" }, [
      button("▶", () => runAction(`Rutina «${name}»`, () => runRoutine(name)), { small: true, needs: "move" }),
      demo ? null : button("Editar", () => editRoutine(name), { small: true }),
      demo ? null : button("Borrar", () => { if (window.confirm(`¿Borrar la rutina «${name}»?`)) act(() => deleteRoutine(name), `Rutina «${name}» borrada.`); }, { small: true })
    ])
  ]);
  const entries = Object.entries(robot.routines);
  $("routines-list").replaceChildren(...entries.map(([name, routine]) => make(name, routine, false)));
  $("demo-routines").replaceChildren(...entries.map(([name, routine]) => make(name, routine, true)));
}

function editRoutine(name) {
  const routine = robot.routines[name];
  $("routine-name").value = name;
  if (routine.quick_frames) {
    sequence = { frames: routine.quick_frames.map((frame, i) => ({ label: `Paso ${i + 1}`, offsets: frame.stance_offset, wait: frame.wait || 0 })), cycles: routine.repeat || 1 };
    $("seq-name").value = name;
    $("seq-cycles").value = String(sequence.cycles);
    saveSequence();
    setNotice(`«${name}» es una secuencia rápida: se cargó también en el probador.`);
  }
  const { description, repeat, steps } = routine;
  $("routine-json").value = JSON.stringify({ description, repeat, steps }, null, 2);
}

function setupRoutines() {
  $("routine-new").addEventListener("click", () => {
    $("routine-name").value = "";
    $("routine-json").value = JSON.stringify({ description: "", repeat: 1, steps: [{ face: "feliz", wait: 1 }, { face: "normal" }] }, null, 2);
  });
  $("routine-save").addEventListener("click", () => act(() => {
    let data;
    try { data = JSON.parse($("routine-json").value); } catch (error) { throw new RobotError(`JSON inválido: ${error.message}`); }
    const previous = robot.routines[$("routine-name").value.trim()];
    return saveRoutine($("routine-name").value, { ...(previous?.base_pose ? { base_pose: previous.base_pose, quick_frames: previous.quick_frames } : {}), ...data });
  }, (key) => `Rutina «${key}» guardada.`));
}

// ==========================================
// CARITAS
// ==========================================
let faceDraft = normalizeFace({});

function drawFace(canvas, face) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#05070c";
  ctx.fillRect(0, 0, 128, 64);
  const eye = (cx, left, override = {}) => {
    const p = { ...face, ...override };
    const w = Math.trunc(p.w);
    const h = Math.max(2, Math.trunc((p.h * p.open) / 100));
    const r = Math.max(0, Math.min(Math.trunc(p.r), Math.trunc(h / 2), Math.trunc(w / 2)));
    const x = cx - Math.trunc(w / 2) + Math.trunc(face.look_x);
    const y = 32 - Math.trunc(h / 2) + Math.trunc(face.look_y);
    ctx.fillStyle = "#d9ed9c";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.fill();
    if (h < 8) return;
    ctx.fillStyle = "#05070c";
    if (p.lid_bottom > 0) {
      const yc = y + Math.trunc((h * (100 - p.lid_bottom)) / 100);
      const radius = Math.trunc(w * 0.75);
      ctx.beginPath();
      ctx.arc(x + Math.trunc(w / 2), yc + radius, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    const cut = (leftSide, pct) => {
      const depth = Math.trunc((h * pct) / 100);
      if (depth < 1) return;
      ctx.beginPath();
      if (leftSide) { ctx.moveTo(x - 1, y - 1); ctx.lineTo(x + Math.trunc(w * 0.9), y - 1); ctx.lineTo(x - 1, y + depth); }
      else { ctx.moveTo(x + w + 1, y - 1); ctx.lineTo(x + Math.trunc(w * 0.1), y - 1); ctx.lineTo(x + w + 1, y + depth); }
      ctx.closePath();
      ctx.fill();
    };
    if (p.brow_in > 0) cut(!left, p.brow_in);
    if (p.brow_out > 0) cut(left, p.brow_out);
  };
  eye(36, true, face.left);
  eye(92, false, face.right);
}

function renderFaceEditor() {
  for (const [key, param] of Object.entries(FACE_PARAMS)) {
    const input = $(`face-${key}`);
    input.value = String(faceDraft[key]);
    input.parentElement.querySelector("output").value = String(faceDraft[key]);
  }
  for (const key of Object.keys(FACE_FLAGS)) $(`face-${key}`).checked = faceDraft[key];
  for (const side of ["left", "right"]) {
    for (const key of EYE_KEYS) $(`face-${side}-${key}`).value = faceDraft[side]?.[key] ?? "";
  }
  drawFace($("face-canvas"), faceDraft);
}

function readEyeOverrides() {
  for (const side of ["left", "right"]) {
    const override = {};
    for (const key of EYE_KEYS) {
      const raw = $(`face-${side}-${key}`).value;
      if (raw !== "") override[key] = Number(raw);
    }
    if (Object.keys(override).length) faceDraft[side] = override; else delete faceDraft[side];
  }
}

function selectFace(name) {
  faceDraft = clone(robot.faces[name] || normalizeFace({}));
  $("face-select").value = name;
  $("face-name").value = name;
  renderFaceEditor();
}

function setupFaces() {
  const grid = $("face-params");
  for (const [key, param] of Object.entries(FACE_PARAMS)) {
    const input = el("input", { type: "range", className: "range", id: `face-${key}`, min: param.min, max: param.max, step: 1 });
    const output = el("output", { htmlFor: `face-${key}` });
    input.addEventListener("input", () => { faceDraft[key] = Number(input.value); output.value = input.value; drawFace($("face-canvas"), faceDraft); });
    grid.append(el("div", { className: "param" }, [el("div", { className: "range-head" }, [el("label", { htmlFor: `face-${key}`, textContent: param.label }), output]), input]));
  }
  for (const [key, flag] of Object.entries(FACE_FLAGS)) {
    const input = el("input", { type: "checkbox", id: `face-${key}` });
    input.addEventListener("change", () => { faceDraft[key] = input.checked; });
    grid.append(el("label", { className: "check" }, [input, ` ${flag.label}`]));
  }
  const eyes = $("face-eyes");
  for (const key of EYE_KEYS) {
    const param = FACE_PARAMS[key];
    const cell = (side) => {
      const input = el("input", { type: "number", id: `face-${side}-${key}`, min: param.min, max: param.max, placeholder: "—" });
      input.addEventListener("input", () => { readEyeOverrides(); drawFace($("face-canvas"), faceDraft); });
      return el("td", {}, [input]);
    };
    eyes.append(el("tr", {}, [el("th", { scope: "row", textContent: param.label }), cell("left"), cell("right")]));
  }
  $("face-select").addEventListener("change", (event) => selectFace(event.target.value));
  const transition = () => parseInt($("face-transition").value, 10) || 0;
  const duration = () => parseInt($("face-duration").value, 10) || 0;
  $("face-send").addEventListener("click", () => act(() => actFace({ ...faceDraft, transition_ms: transition(), duration_ms: duration() }), "Cara enviada al robot."));
  $("face-save").addEventListener("click", () => act(() => {
    readEyeOverrides();
    const key = saveFace($("face-name").value, faceDraft);
    selectFace(key);
    return key;
  }, (key) => `Cara «${key}» guardada.`));
  $("face-delete").addEventListener("click", () => {
    const name = $("face-select").value;
    if (!window.confirm(`¿Borrar la cara «${name}»?`)) return;
    act(() => { deleteFace(name); selectFace("normal"); }, `Cara «${name}» borrada.`);
  });
  $("text-send").addEventListener("click", () => act(() => actText($("text-message").value, num("text-duration")), "Texto enviado a la pantalla."));
  $("text-clear").addEventListener("click", () => act(() => actText("", 0), "Texto borrado."));
  $("status-screen").addEventListener("click", () => act(() => send("EYES STATUS"), "Pantalla de estado alternada."));
}

function renderFacesCatalog() {
  const names = Object.keys(robot.faces);
  const selected = $("face-select").value;
  $("face-select").replaceChildren(...names.map((n) => el("option", { value: n, textContent: n })));
  if (names.includes(selected)) $("face-select").value = selected; else selectFace("normal");
  $("demo-faces").replaceChildren(...names.map((name) => button(name.replace(/_/g, " "), () => act(() => actFace(name), `Cara «${name}» aplicada.`), { needs: "conn", kind: "chip" })));
}

// ==========================================
// SESAME
// ==========================================
function sesameSteps(intro, cycle, cycles, stay, face) {
  const stance = getStance();
  requireAllReady("ejecutar el movimiento");
  const amplitude = num("sesame-amplitude") / 100;
  const tempo = num("sesame-tempo") / 100;
  const speed = num("sesame-speed");
  const frames = [...intro, ...Array.from({ length: cycles }, () => cycle).flat()];
  const faceStep = (name) => (robot.faces[name] ? { face: name } : null);
  const steps = [faceStep(face)].filter(Boolean);
  const pose = { ...stance };
  for (const frame of frames) {
    const previous = { ...pose };
    for (const [n, angle] of Object.entries(frame.set)) {
      const sign = SWING_SERVOS.includes(n) ? forwardSign(n) : 1;
      pose[n] = round1(clamp(stance[n] + sign * sesameDelta(n, angle) * amplitude, cfg(n).min, cfg(n).max));
    }
    const travel = (Math.max(...SERVOS.map((n) => Math.abs(pose[n] - previous[n]))) / speed) * 1000;
    const extra = Math.max(0, frame.wait / tempo - travel) / 1000;
    steps.push({ ...(frame.face && robot.faces[frame.face] ? { face: frame.face } : {}), pose_all: SERVOS.map((n) => pose[n]), wait_done: true,
      ...(extra > 0.01 ? { wait: Math.round(extra * 1000) / 1000 } : {}) });
  }
  if (!stay) {
    steps.push({ pose_all: SERVOS.map((n) => stance[n]), wait_done: true });
    if (robot.faces.normal) steps.push({ face: "normal" });
  }
  return { steps, speed };
}

async function runSesame(label, face, intro, cycle, cycles, stay) {
  const { steps, speed } = sesameSteps(intro, cycle, cycles, stay, face);
  return runSteps(`sesame_${label}`, steps, 1, {
    // Velocidad temporal de la coreografía; al terminar o detenerse vuelve la del perfil.
    before: async (check) => {
      for (const n of SERVOS) {
        check();
        await actSpeed(n, speed, "sesame", false);
        await sleep(BURST_GAP_MS);
      }
    },
    after: () => applySpeeds("sesame")
  });
}

function setupSesame() {
  for (const move of SESAME_MOVES) {
    $("sesame-moves").append(button(move.label, () => runAction(move.label, () => runSesame(move.id, move.face, move.frames, [], 0, move.stay)), { needs: "move", kind: "chip" }));
  }
  for (const gait of SESAME_GAITS) {
    $("sesame-gaits").append(button(gait.label, () => {
      const cycles = clamp(Math.round(num("sesame-cycles")) || 1, 1, 20);
      runAction(gait.label, () => runSesame(gait.id, gait.face, gait.intro, gait.cycle, cycles, false));
    }, { needs: "move", kind: "chip" }));
  }
  for (const id of ["sesame-amplitude", "sesame-tempo", "sesame-speed"]) {
    const input = $(id);
    const unit = id === "sesame-speed" ? "°/s" : "%";
    const refresh = () => { $(`${id}-value`).value = `${input.value}${unit}`; };
    input.addEventListener("input", refresh);
    refresh();
  }
}

// ==========================================
// DEMOSTRACIÓN Y BITÁCORA
// ==========================================
function renderDemoPrograms() {
  const items = Object.entries(robot.programs).map(([name, program]) => el("div", { className: "item" }, [
    el("div", {}, [el("strong", { textContent: name }), el("span", { className: "small-note", textContent: program.description ? ` ${program.description}` : "" })]),
    el("span", { className: "item-tools" }, [button("▶ Ejecutar", () => runSavedProgram(name), { small: true, needs: "move", kind: "button-dark" })])
  ]));
  $("demo-programs").replaceChildren(...(items.length ? items : [el("p", { className: "small-note", textContent: "Guarda programas en «Bloques y rutinas» para verlos aquí." })]));
}

function renderLog() {
  $("log-rows").replaceChildren(...robot.log.map((entry) => el("tr", {}, [
    el("td", { textContent: new Date(entry.t).toLocaleTimeString() }), el("td", { textContent: entry.source }), el("td", { className: "mono", textContent: entry.cmd })
  ])));
}

// ==========================================
// RENDERIZADO
// ==========================================
function renderProfileDependent() {
  renderProfileTable();
  renderServoRanges();
  renderLegsProfile();
  $("sesame-stance").textContent = robot.profile.stance
    ? `Postura de apoyo: ${poseText(robot.profile.stance)}` : "Guarda la postura de apoyo en «Mover patas» antes de usar Sesame.";
}

function renderCatalogs() {
  renderFacesCatalog();
  renderProgramsList();
  renderDemoPrograms();
  renderRoutinesList();
  renderBlocks();
  updateControls();
}

function renderLive() {
  renderServoLive();
  renderLegsLive();
  renderRunStatus();
  updateControls();
}

let lastProfileRobot = null;
onRobot((kind) => {
  if (kind === "profile") {
    renderProfileDependent();
    if (lastProfileRobot !== robot.id) {
      lastProfileRobot = robot.id;
      loadBlocksDraft();
      loadSequence();
    }
  }
  if (kind === "catalog") renderCatalogs();
  if (kind === "log") renderLog();
  scheduleRender();
});

function setupPwa() {
  const refreshNetwork = () => {
    $("network-state").textContent = navigator.onLine ? "Control local listo" : "Disponible sin conexión";
    $("network-state").classList.toggle("online", navigator.onLine);
  };
  window.addEventListener("online", refreshNetwork);
  window.addEventListener("offline", refreshNetwork);
  refreshNetwork();
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js").catch(() => { $("install-help").textContent = "No se pudo guardar la interfaz para uso sin conexión."; });
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

setupTabs();
setupSafety();
setupServos();
setupLegs();
setupBlocks();
setupSequence();
setupRoutines();
setupFaces();
setupSesame();
setupPwa();
$("log-clear").addEventListener("click", () => { robot.log.length = 0; renderLog(); });
initRobot();
renderCatalogs();
renderLive();
