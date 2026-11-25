"use strict";

// Movimientos del robot Sesame (Dorian Todd, Apache-2.0):
// https://github.com/dorianborian/sesame-robot/blob/main/firmware/movement-sequences.h
//
// Los ángulos de cada cuadro son los ABSOLUTOS de Sesame, copiados sin cambios.
// No se envían tal cual: sesameDelta() los convierte en desplazamientos de
// "avanzar" (R1 R2 L1 L2) y "levantar" (R3 R4 L3 L4) respecto a la postura de pie
// de Sesame, y app.js los aplica sobre la postura de apoyo calibrada de esta araña.
//
// Nombres compartidos: R1/R2/L1/L2 giran la cadera, R3/R4/L3/L4 levantan el pie.
// Pares de pata: R1-R3, R2-R4, L1-L3, L2-L4 (igual que en esta araña).

const SESAME_STAND = { R1: 135, R2: 45, L1: 45, L2: 135, R3: 180, R4: 0, L3: 0, L4: 180 };

// Signo con el que Sesame avanza (caderas) o levanta (pies), deducido de su marcha:
// R1 170 adelanta la pata A; L1 78 y R2 18 empujan hacia atrás; R3 143 y L4 148 levantan A.
const SESAME_SIGN = { R1: 1, R2: 1, L1: -1, L2: -1, R3: -1, R4: 1, L3: 1, L4: -1 };

// Sesame espera 20 ms tras cada setServoAngle además del retardo explícito.
const SESAME_SERVO_DELAY = 20;
const SESAME_FRAME_DELAY = 100;

function sesameFrame(set, delay, face) {
  return { set, wait: delay + SESAME_SERVO_DELAY * Object.keys(set).length, face };
}

function sesameRepeat(times, frames) {
  return Array.from({ length: times }, () => frames).flat();
}

const ALL_90 = { R1: 90, R2: 90, L1: 90, L2: 90, R3: 90, R4: 90, L3: 90, L4: 90 };
const LIFT_A = { R3: 143, L4: 148 };
const SWAP_A_DOWN = { R3: 171, L4: 176, L3: 38, R4: 42 };
const SWAP_B_DOWN = { L3: 10, R4: 14, R3: 143, L4: 148 };

function sesameGait(first, third) {
  const f = (set) => sesameFrame(set, SESAME_FRAME_DELAY);
  return {
    intro: [sesameFrame(SESAME_STAND, 200), f(LIFT_A)],
    cycle: [f(first), f(SWAP_A_DOWN), f(third), f(SWAP_B_DOWN)]
  };
}

// face: id de una cara de FACES (robot-profile.js); Sesame usa una cara propia por movimiento.
// stay: true si Sesame termina sin volver a la postura de pie.
const SESAME_MOVES = [
  { id: "stand", label: "De pie", face: "normal", stay: true, frames: [sesameFrame(SESAME_STAND, 0)] },
  { id: "rest", label: "Descansar", face: "sleep", stay: true, frames: [sesameFrame(ALL_90, 0)] },
  {
    id: "wave", label: "Saludar", face: "wave", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ R4: 80, L3: 180, L2: 90, R1: 100 }, 200),
      sesameFrame({ L3: 180 }, 300),
      ...sesameRepeat(4, [sesameFrame({ L3: 180 }, 300), sesameFrame({ L3: 100 }, 300)])
    ]
  },
  {
    id: "dance", label: "Bailar", face: "dance", frames: [
      sesameFrame({ R1: 90, R2: 90, L1: 90, L2: 90, R4: 160, R3: 160, L3: 10, L4: 10 }, 300),
      ...sesameRepeat(5, [
        sesameFrame({ R4: 115, R3: 115, L3: 10, L4: 10 }, 300),
        sesameFrame({ R4: 160, R3: 160, L3: 65, L4: 65 }, 300)
      ])
    ]
  },
  {
    id: "swim", label: "Nadar", face: "swim", frames: [
      sesameFrame(ALL_90, 0),
      ...sesameRepeat(4, [
        sesameFrame({ R1: 135, R2: 45, L1: 45, L2: 135 }, 400),
        sesameFrame({ R1: 90, R2: 90, L1: 90, L2: 90 }, 400)
      ])
    ]
  },
  {
    id: "point", label: "Señalar", face: "point", frames: [
      sesameFrame({ L2: 90, R1: 135, R2: 100, L4: 180, L1: 25, L3: 145, R4: 80, R3: 170 }, 2000)
    ]
  },
  {
    id: "pushup", label: "Flexiones", face: "pushup", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ L1: 0, R1: 180, L3: 90, R3: 90 }, 500),
      ...sesameRepeat(4, [sesameFrame({ L3: 0, R3: 180 }, 600), sesameFrame({ L3: 90, R3: 90 }, 500)])
    ]
  },
  {
    id: "bow", label: "Reverencia", face: "bow", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ L1: 0, R1: 180, L3: 0, R3: 180, L2: 180, R2: 0, R4: 0, L4: 180 }, 600),
      sesameFrame({ L3: 90, R3: 90 }, 3000)
    ]
  },
  {
    id: "cute", label: "Tierno", face: "cute", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ L2: 160, R2: 20, R4: 180, L4: 0, L1: 0, R1: 180, L3: 180, R3: 0 }, 200),
      ...sesameRepeat(5, [sesameFrame({ R4: 180, L4: 45 }, 300), sesameFrame({ R4: 135, L4: 0 }, 300)])
    ]
  },
  {
    id: "freaky", label: "Raro", face: "freaky", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ L1: 0, R1: 180, L2: 180, R2: 0, R4: 90, R3: 0 }, 200),
      ...sesameRepeat(3, [sesameFrame({ R3: 25 }, 400), sesameFrame({ R3: 0 }, 400)])
    ]
  },
  {
    id: "worm", label: "Gusano", face: "worm", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ R1: 180, R2: 0, L1: 0, L2: 180, R4: 90, R3: 90, L3: 90, L4: 90 }, 200),
      ...sesameRepeat(5, [
        sesameFrame({ R3: 45, L3: 135, R4: 45, L4: 135 }, 300),
        sesameFrame({ R3: 135, L3: 45, R4: 135, L4: 45 }, 300)
      ])
    ]
  },
  {
    id: "shake", label: "Sacudir", face: "shake", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ R1: 135, L1: 45, L3: 90, R3: 90, L2: 90, R2: 90 }, 200),
      ...sesameRepeat(5, [sesameFrame({ R4: 45, L4: 135 }, 300), sesameFrame({ R4: 0, L4: 180 }, 300)])
    ]
  },
  {
    id: "shrug", label: "Encogerse", face: "dead", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ R3: 90, R4: 90, L3: 90, L4: 90 }, 1000),
      sesameFrame({ R3: 0, R4: 180, L3: 180, L4: 0 }, 1500, "shrug")
    ]
  },
  {
    id: "dead", label: "Hacerse el muerto", face: "dead", stay: true, frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ R3: 90, R4: 90, L3: 90, L4: 90 }, 0)
    ]
  },
  {
    id: "crab", label: "Cangrejo", face: "crab", frames: [
      sesameFrame(SESAME_STAND, 200),
      sesameFrame({ R1: 90, R2: 90, L1: 90, L2: 90, R4: 0, R3: 180, L3: 45, L4: 135 }, 0),
      ...sesameRepeat(5, [
        sesameFrame({ R4: 45, R3: 135, L3: 0, L4: 180 }, 300),
        sesameFrame({ R4: 0, R3: 180, L3: 45, L4: 135 }, 300)
      ])
    ]
  }
];

// Marchas de Sesame ("remastered movement" de @sAIreous). En Sesame se repiten
// mientras se mantiene pulsado el botón; aquí se repiten un número de ciclos.
const SESAME_GAITS = [
  { id: "forward", face: "walk", label: "▲ Adelante", ...sesameGait({ R1: 170, L2: 106, L1: 78, R2: 18 }, { L1: 10, R2: 76, R1: 102, L2: 164 }) },
  { id: "backward", face: "walk", label: "▼ Atrás", ...sesameGait({ R1: 102, L2: 164, L1: 10, R2: 76 }, { L1: 78, R2: 18, R1: 170, L2: 106 }) },
  { id: "left", face: "walk", label: "↺ Girar izquierda", ...sesameGait({ R1: 166, L2: 160, L1: 12, R2: 18 }, { L1: 78, R2: 76, R1: 102, L2: 106 }) },
  { id: "right", face: "walk", label: "↻ Girar derecha", ...sesameGait({ R1: 102, L2: 106, L1: 78, R2: 76 }, { L1: 10, R2: 18, R1: 170, L2: 164 }) }
];

// Desplazamiento semántico (+ = avanzar la cadera o levantar el pie) de un ángulo de Sesame.
function sesameDelta(name, sesameAngle) {
  return (sesameAngle - SESAME_STAND[name]) * SESAME_SIGN[name];
}
