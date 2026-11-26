"use strict";

// Datos por defecto que la página envía al robot. El firmware solo ejecuta órdenes:
// rangos (LIMIT), inversión (INVERT), velocidad (SPEED), posturas y caras (FACE).
// Equivalen a los del proyecto general: firmware/arana_api, server/faces.json y server/routines.json.

const SERVOS = ["R1", "R2", "R3", "R4", "L1", "L2", "L3", "L4"];

// Tabla de fábrica del firmware: caderas 0–160°, pies 0–180°, R3 y L4 invertidos, 60 °/s.
const DEFAULT_SERVO_PROFILE = {
  R1: { min: 0, max: 160, invert: false, speed: 60 },
  R2: { min: 0, max: 160, invert: false, speed: 60 },
  R3: { min: 0, max: 180, invert: true, speed: 60 },
  R4: { min: 0, max: 180, invert: false, speed: 60 },
  L1: { min: 0, max: 160, invert: false, speed: 60 },
  L2: { min: 0, max: 160, invert: false, speed: 60 },
  L3: { min: 0, max: 180, invert: false, speed: 60 },
  L4: { min: 0, max: 180, invert: true, speed: 60 }
};

// Patas: motor de giro (avance), motor de elevación y sentido de avance por defecto
// (server/main.py WALK_SWING). La elevación siempre sube con grados positivos.
const LEGS = {
  R1: { swing: "R1", lift: "R3", forward: 1, label: "Delantera derecha" },
  L1: { swing: "L1", lift: "L3", forward: -1, label: "Delantera izquierda" },
  R2: { swing: "R2", lift: "R4", forward: -1, label: "Trasera derecha" },
  L2: { swing: "L2", lift: "L4", forward: -1, label: "Trasera izquierda" }
};
const SWING_SERVOS = ["R1", "R2", "L1", "L2"];
const LIFT_SERVOS = ["R3", "R4", "L3", "L4"];

// Parámetros de cara del comando FACE (server/main.py FACE_PARAMS).
const FACE_PARAMS = {
  w: { code: "W", min: 10, max: 50, label: "Ancho" },
  h: { code: "H", min: 4, max: 56, label: "Alto" },
  r: { code: "R", min: 0, max: 28, label: "Redondez" },
  open: { code: "O", min: 0, max: 100, label: "Apertura %" },
  brow_in: { code: "BI", min: 0, max: 80, label: "Ceja interior (enojo)" },
  brow_out: { code: "BO", min: 0, max: 80, label: "Ceja exterior (tristeza)" },
  lid_bottom: { code: "LB", min: 0, max: 80, label: "Párpado inferior (alegría)" },
  look_x: { code: "X", min: -20, max: 20, label: "Mirada horizontal" },
  look_y: { code: "Y", min: -12, max: 12, label: "Mirada vertical" }
};
const FACE_FLAGS = { auto_blink: { code: "AB", label: "Parpadeo automático" }, auto_look: { code: "AL", label: "Mirada automática" } };
const EYE_KEYS = ["w", "h", "r", "open", "brow_in", "brow_out", "lid_bottom"];
const DEFAULT_FACE = { w: 36, h: 36, r: 9, open: 100, brow_in: 0, brow_out: 0, lid_bottom: 0, look_x: 0, look_y: 0, auto_blink: true, auto_look: true };

// Caras de server/faces.json y, al final, aproximaciones a las caras de Sesame.
const DEFAULT_FACES = {
  normal: {},
  feliz: { lid_bottom: 45 },
  triste: { brow_out: 55 },
  enojado: { brow_in: 55 },
  sorprendido: { w: 40, h: 40, r: 20, auto_blink: false },
  dormido: { open: 10, auto_blink: false, auto_look: false },
  guino: { left: { open: 8 }, right: { lid_bottom: 35 } },
  sospechoso: { open: 45, brow_in: 20, look_x: 10, auto_look: false },
  confundido: { left: { brow_out: 40 }, right: { h: 26, brow_in: 25 } },
  picaro: { lid_bottom: 30, look_x: -8, look_y: 2, auto_look: false, left: { brow_in: 40 } },
  aburrido: { open: 40, look_y: 4, auto_look: false },
  sorprendido_animado: { w: 30, h: 40, r: 15, open: 85, brow_in: 20, brow_out: 20, look_y: -6 },
  enojado_lagrima: { w: 35, h: 45, r: 20, open: 75, brow_in: 60, brow_out: 60, look_y: 8 },
  triste_llorando: { w: 30, h: 50, r: 18, open: 60, brow_in: 70, brow_out: 70, lid_bottom: 2, look_y: 10 },
  fiesta: { w: 40, lid_bottom: 40, look_y: -4 },
  nadar: { h: 26, r: 13, look_y: 4 },
  senalar: { w: 34, h: 40, r: 14, look_x: 14, auto_look: false },
  esfuerzo: { h: 28, brow_in: 40, auto_blink: false },
  reverencia: { open: 45, look_y: 9, auto_look: false },
  tierno: { w: 40, h: 44, r: 20, lid_bottom: 25 },
  raro: { auto_blink: false, auto_look: false, left: { w: 46, h: 46, r: 22 }, right: { w: 22, h: 22, r: 11 } },
  gusano: { h: 18, r: 9 },
  sacudir: { lid_bottom: 35, look_x: -8 },
  encogerse: { brow_out: 40, open: 80, look_y: -5 },
  muerto: { open: 4, auto_blink: false, auto_look: false },
  cangrejo: { w: 40, h: 24, brow_in: 45 },
  caminar: { look_y: -3 }
};

// Rutinas de server/routines.json.
const DEFAULT_ROUTINES = {
  probar_delantera_derecha: {
    description: "Desde la postura de apoyo: R1 adelante y atrás; R3 arriba y regreso. Observa si el pie se despega.",
    repeat: 1,
    steps: [
      { stance_offset: { R1: 5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { R1: -5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { R3: 10 }, wait_done: true }, { stance_offset: {}, wait_done: true }
    ]
  },
  probar_delantera_izquierda: {
    description: "Desde la postura de apoyo: L1 adelante y atrás; L3 arriba y regreso. Observa si el pie se despega.",
    repeat: 1,
    steps: [
      { stance_offset: { L1: -5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { L1: 5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { L3: 10 }, wait_done: true }, { stance_offset: {}, wait_done: true }
    ]
  },
  probar_trasera_derecha: {
    description: "Desde la postura de apoyo: R2 adelante y atrás; R4 arriba y regreso. Observa si el pie se despega.",
    repeat: 1,
    steps: [
      { stance_offset: { R2: -5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { R2: 5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { R4: 10 }, wait_done: true }, { stance_offset: {}, wait_done: true }
    ]
  },
  probar_trasera_izquierda: {
    description: "Desde la postura de apoyo: L2 adelante y atrás; L4 arriba y regreso. Observa si el pie se despega.",
    repeat: 1,
    steps: [
      { stance_offset: { L2: -5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { L2: 5 }, wait_done: true }, { stance_offset: {}, wait_done: true },
      { stance_offset: { L4: 10 }, wait_done: true }, { stance_offset: {}, wait_done: true }
    ]
  },
  saludo_ojos: {
    description: "Saludo con ojos y texto, sin mover las patas.",
    repeat: 1,
    steps: [
      { face: "feliz", text: { text: "Hola Mexico IA", duration_ms: 2500 }, wait: 1 },
      { face: "normal" }
    ]
  }
};
