"use strict";

// Perfil del robot definido por la página. El firmware solo ejecuta: la web le envía
// rangos (LIMIT), inversión (INVERT), velocidad (SPEED) y caras (FACE).
// Valores por defecto = tabla de fábrica del firmware (hombros 0–160°, pies 0–180°,
// R3 y L4 invertidos, 60 °/s). Cada navegador guarda sus cambios.
// dir: +1 si subir grados avanza la cadera o levanta el pie; -1 si los bajan.

const DEFAULT_SERVO_PROFILE = {
  R1: { dir: 1, min: 0, max: 160, invert: false, speed: 60 },
  R2: { dir: 1, min: 0, max: 160, invert: false, speed: 60 },
  R3: { dir: 1, min: 0, max: 180, invert: true, speed: 60 },
  R4: { dir: 1, min: 0, max: 180, invert: false, speed: 60 },
  L1: { dir: -1, min: 0, max: 160, invert: false, speed: 60 },
  L2: { dir: -1, min: 0, max: 160, invert: false, speed: 60 },
  L3: { dir: 1, min: 0, max: 180, invert: false, speed: 60 },
  L4: { dir: 1, min: 0, max: 180, invert: true, speed: 60 }
};

// Caras paramétricas para el comando FACE del firmware.
//   W,H tamaño · R redondez · O % abierto · BI/BO ceja interior/exterior · LB párpado inferior
//   X,Y mirada · AB/AL parpadeo y mirada automáticos. left/right = solo ese ojo.
// Las de Sesame son aproximaciones de sus mapas de bits con estos parámetros.
const EYE_BASE = { W: 36, H: 36, R: 9, O: 100, BI: 0, BO: 0, LB: 0 };
const FACE_BASE = { X: 0, Y: 0, AB: 1, AL: 1 };

const FACES = [
  { id: "normal", label: "Normal", eyes: {} },
  { id: "happy", label: "Feliz", eyes: { LB: 45 } },
  { id: "sad", label: "Triste", eyes: { BO: 55 } },
  { id: "angry", label: "Enfadado", eyes: { BI: 55 } },
  { id: "sleep", label: "Dormido", eyes: { O: 10 }, face: { AB: 0, AL: 0 } },
  { id: "surprised", label: "Sorpresa", eyes: { W: 40, H: 40, R: 20 }, face: { AB: 0 } },
  { id: "wave", label: "Guiño", eyes: { LB: 45 }, right: { O: 15 }, face: { AB: 0 } },
  { id: "dance", label: "Fiesta", eyes: { W: 40, LB: 40 }, face: { Y: -4 } },
  { id: "swim", label: "Nadar", eyes: { H: 26, R: 13 }, face: { Y: 4 } },
  { id: "point", label: "Señalar", eyes: { W: 34, H: 40, R: 14 }, face: { X: 14, AL: 0 } },
  { id: "pushup", label: "Esfuerzo", eyes: { H: 28, BI: 40 }, face: { AB: 0 } },
  { id: "bow", label: "Reverencia", eyes: { O: 45 }, face: { Y: 9, AL: 0 } },
  { id: "cute", label: "Tierno", eyes: { W: 40, H: 44, R: 20, LB: 25 } },
  { id: "freaky", label: "Raro", left: { W: 46, H: 46, R: 22 }, right: { W: 22, H: 22, R: 11 }, face: { AB: 0, AL: 0 } },
  { id: "worm", label: "Gusano", eyes: { H: 18, R: 9 } },
  { id: "shake", label: "Sacudir", eyes: { LB: 35 }, face: { X: -8 } },
  { id: "shrug", label: "Encogerse", eyes: { BO: 40, O: 80 }, face: { Y: -5 } },
  { id: "dead", label: "Muerto", eyes: { O: 4 }, face: { AB: 0, AL: 0 } },
  { id: "crab", label: "Cangrejo", eyes: { W: 40, H: 24, BI: 45 } },
  { id: "walk", label: "Caminar", eyes: {}, face: { Y: -3 } }
];

// Comandos FACE completos: envían todos los parámetros para que la cara no herede valores.
// El firmware acepta menos de 96 bytes por escritura, así que los ajustes de un solo ojo
// van en un segundo FACE (parte de la cara que el primero acaba de fijar).
const BLE_COMMAND_LIMIT = 95;

function faceCommands(face, transitionMs = 250) {
  const both = { ...EYE_BASE, ...face.eyes };
  const main = [`FACE T=${transitionMs}`];
  for (const [key, value] of Object.entries({ ...FACE_BASE, ...face.face })) main.push(`${key}=${value}`);
  for (const [key, value] of Object.entries(both)) main.push(`${key}=${value}`);
  const single = [];
  for (const [prefix, eye] of [["L.", face.left], ["R.", face.right]]) {
    for (const [key, value] of Object.entries(eye || {})) if (both[key] !== value) single.push(`${prefix}${key}=${value}`);
  }
  const commands = [main.join(" ")];
  if (single.length) commands.push(`FACE T=${transitionMs} ${single.join(" ")}`);
  return commands;
}
