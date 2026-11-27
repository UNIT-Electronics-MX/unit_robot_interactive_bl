const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const docs = path.join(__dirname, '..', 'docs');
const walkBlock = `[{type:'walk_cycle',legs:Object.fromEntries(['R1','L2','L1','R2']
  .map(name=>[name,{stride:3,lift:5}])),pause:0}]`;

function robotWithReportedPose(holding, savedProfile = null) {
  const values = new Map();
  if (savedProfile) values.set('spider-ble-robot:default', JSON.stringify(savedProfile));
  const context = {
    TextEncoder, performance, setTimeout, clearTimeout,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  };
  vm.createContext(context);
  for (const file of ['robot-profile.js', 'robot-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(docs, file), 'utf8'), context);
  }
  vm.runInContext(`
    initRobot();
    onHeader(true, true, 'test');
    for (const name of SERVOS) onServoStatus(name, MEASURED_STANDING_POSE[name], MEASURED_STANDING_POSE[name], true, ${holding});
    const hardware = Object.fromEntries(SERVOS.map(name => [name, {en:true, pwm:${holding}}]));
    robot.transport = async command => {
      const [verb, name] = command.split(' ');
      if (verb === 'ENABLE') hardware[name].en = true;
      if (verb === 'ARM') for (const motor of SERVOS) hardware[motor].en = true;
      if (verb === 'POSE_HOLD') {
        for (const motor of SERVOS) hardware[motor].pwm = hardware[motor].en;
      }
      if (verb === 'HOLD' && hardware[name].en) {
        hardware[name].pwm = true;
        // Una notificación anterior todavía puede venir en camino.
        setTimeout(() => onServoStatus(name, MEASURED_STANDING_POSE[name], MEASURED_STANDING_POSE[name], true, false), 1);
      }
      if (verb === 'STATUS') setTimeout(() => {
        for (const motor of SERVOS) onServoStatus(motor, MEASURED_STANDING_POSE[motor], MEASURED_STANDING_POSE[motor], hardware[motor].en, hardware[motor].pwm);
      }, 10);
      return true;
    };
  `, context);
  return context;
}

test('calibrated standing and rest poses are available without saving', () => {
  const context = robotWithReportedPose(false);
  assert.equal(vm.runInContext('robot.profile.autoStance', context), true);
  assert.equal(vm.runInContext('robot.profile.stance.R3', context), 70);
  assert.equal(vm.runInContext('robot.profile.startupPose.L4', context), 150);
  assert.equal(vm.runInContext('SERVOS.every(name => cfg(name).speed === 90)', context), true);
});

test('a saved servo speed remains in the robot profile', () => {
  const servos = Object.fromEntries(['R1', 'R2', 'R3', 'R4', 'L1', 'L2', 'L3', 'L4']
    .map(name => [name, { speed: 60 }]));
  const context = robotWithReportedPose(false, { servos });
  assert.equal(vm.runInContext('SERVOS.every(name => cfg(name).speed === 60)', context), true);
});

test('old empty profile receives the calibrated standing pose', () => {
  const context = robotWithReportedPose(false, { stance: null, autoStance: false, startupPose: null });
  assert.equal(vm.runInContext('robot.profile.autoStance', context), true);
  assert.equal(vm.runInContext('robot.profile.stance.R3', context), 70);
});

test('custom saved standing pose remains unchanged', () => {
  const stance = { R1: 88, R2: 88, R3: 72, R4: 72, L1: 88, L2: 88, L3: 72, L4: 72 };
  const context = robotWithReportedPose(false, { stance, autoStance: false });
  assert.equal(vm.runInContext('robot.profile.stance.R1', context), 88);
  assert.equal(vm.runInContext('robot.profile.autoStance', context), false);
});

test('old measured pose and broad limits migrate to the supplied calibration', () => {
  const stance = { R1: 71, R2: 77, R3: 40, R4: 46, L1: 90, L2: 90, L3: 44, L4: 40 };
  const context = robotWithReportedPose(false, {
    stance, autoStance: false,
    servos: { R1: { min: 0, max: 180 }, R2: { min: 0, max: 180 } }
  });
  assert.equal(vm.runInContext('robot.profile.stance.R3', context), 70);
  assert.equal(vm.runInContext('robot.profile.autoStance', context), true);
  assert.equal(vm.runInContext('robot.profile.servos.R1.min', context), 20);
  assert.equal(vm.runInContext('robot.profile.servos.R1.max', context), 128);
  assert.equal(vm.runInContext('robot.profile.servos.R2.min', context), 30);
});

test('connection applies standing pose and confirms all eight PWM outputs', async () => {
  const context = robotWithReportedPose(false);
  const result = await vm.runInContext('recoverOnConnect()', context);
  assert.equal(result.restored, 'stance');
  assert.equal(vm.runInContext('SERVOS.filter(held).length', context), 8);
  assert.equal(vm.runInContext('atStance()', context), true);
  assert.equal(vm.runInContext('robot.log.some(entry => entry.cmd === "POSE_HOLD 90 90 70 70 90 90 70 70")', context), true);
  assert.doesNotThrow(() => vm.runInContext('requireAllReady("ejecutar el movimiento")', context));
});

test('connection rearms disabled motors before applying calibrated pose', async () => {
  const context = robotWithReportedPose(false);
  vm.runInContext('for (const name of SERVOS) { robot.telemetry[name].en = false; hardware[name].en = false; }', context);
  const result = await vm.runInContext('recoverOnConnect()', context);
  assert.equal(result.restored, 'stance');
  assert.equal(vm.runInContext('robot.log.some(entry => entry.cmd === "ARM")', context), true);
  assert.equal(vm.runInContext('SERVOS.filter(held).length', context), 8);
});

test('connection finishes a partially held standing pose', async () => {
  const context = robotWithReportedPose(false);
  vm.runInContext('hardware.R2.pwm = true; onServoStatus("R2", 90, 90, true, true)', context);
  const result = await vm.runInContext('recoverOnConnect()', context);
  assert.equal(result.restored, 'stance');
  assert.equal(vm.runInContext('SERVOS.filter(held).length', context), 8);
  assert.doesNotThrow(() => vm.runInContext('requireAllReady("ejecutar el movimiento")', context));
});

test('reconnection with eight held servos in standing pose is ready without releasing PWM', async () => {
  const context = robotWithReportedPose(true);
  const result = await vm.runInContext('recoverOnConnect()', context);
  assert.equal(result.applied, false);
  assert.equal(result.readyForRoutines, true);
  assert.equal(vm.runInContext('robot.log.some(entry => entry.cmd.startsWith("LIMIT ") || entry.cmd.startsWith("INVERT "))', context), false);
  assert.equal(vm.runInContext('atStance()', context), true);
});

test('reconnection with eight held servos outside standing pose gives a recovery path', async () => {
  const context = robotWithReportedPose(true);
  vm.runInContext('for (const name of ["R3", "R4", "L3", "L4"]) onServoStatus(name, 150, 150, true, true)', context);
  const result = await vm.runInContext('recoverOnConnect()', context);
  assert.equal(result.readyForRoutines, false);
  assert.equal(result.holding.length, 8);
});

test('restore standing pose rearms released motors with one action', async () => {
  const context = robotWithReportedPose(false);
  vm.runInContext('for (const name of SERVOS) { robot.telemetry[name].en = false; hardware[name].en = false; }', context);
  await vm.runInContext('restoreStance()', context);
  assert.equal(vm.runInContext('robot.log.some(entry => entry.cmd === "ARM")', context), true);
  assert.equal(vm.runInContext('SERVOS.filter(held).length', context), 8);
});

test('rest pose moves all feet to 150 degrees in one command', async () => {
  const context = robotWithReportedPose(true);
  await vm.runInContext('restPose()', context);
  assert.equal(vm.runInContext('robot.log[0].cmd', context), 'POSE 90 90 150 150 90 90 150 150');
});

test('walking step uses 12 degrees of advance and a 10 degree trial lift', () => {
  const context = robotWithReportedPose(true);
  const result = vm.runInContext('buildWalkSteps(12)', context);
  assert.equal(result.length, 13);
  assert.equal(result[0].pose_all[2], 80); // R3: 70 + 10
  assert.equal(result[1].pose_all[0], 102); // R1: 90 + 12
  assert.equal(result[1].pose_all[2], 80);
  assert.equal(result[2].pose_all[2], 70);
  assert.equal(result.at(-1).pose_all[0], 90);
  assert.equal(result.at(-1).pose_all[1], 90);
  assert.equal(result.every(step => step._settleMs === 40), true);
});

test('walking step uses each saved foot lift', () => {
  const context = robotWithReportedPose(true);
  vm.runInContext('robot.profile.walkLifts = {R3:20,R4:15,L3:12,L4:18}', context);
  const result = vm.runInContext('buildWalkSteps(12)', context);
  assert.equal(result[0].pose_all[2], 90); // R3
  assert.equal(result[3].pose_all[7], 88); // L4
  assert.equal(result[6].pose_all[3], 85); // R4
  assert.equal(result[9].pose_all[6], 82); // L3
});

test('backward step reverses every hip stroke while keeping the same foot support', () => {
  const context = robotWithReportedPose(true);
  const forward = vm.runInContext('buildWalkSteps(12, 10, 1)', context);
  const backward = vm.runInContext('buildWalkSteps(12, 10, -1)', context);
  const hipIndexes = [0, 1, 4, 5];
  const footIndexes = [2, 3, 6, 7];
  for (let phase = 0; phase < 12; phase++) {
    for (const index of hipIndexes) {
      assert.equal(forward[phase].pose_all[index] + backward[phase].pose_all[index], 180);
    }
    for (const index of footIndexes) {
      assert.equal(backward[phase].pose_all[index], forward[phase].pose_all[index]);
    }
  }
  assert.deepEqual(backward.at(-1).pose_all, forward.at(-1).pose_all);
});

test('backward step checks its own direction against the saved hip range', () => {
  const context = robotWithReportedPose(true);
  vm.runInContext('robot.profile.walkSwing = {R1:{min:85,max:128,forward:1}}', context);
  assert.throws(() => vm.runInContext('buildWalkSteps(12, 10, -1)', context), /R1: la pose actual no deja espacio/);
  assert.doesNotThrow(() => vm.runInContext('buildWalkSteps(12, 10, 1)', context));
});

test('walking step executes thirteen coordinated poses and returns to standing', async () => {
  const context = robotWithReportedPose(true);
  const result = await vm.runInContext('walk(12, 1)', context);
  assert.equal(result.status, 'done', result.error);
  assert.equal(vm.runInContext('robot.log.filter(entry => entry.cmd.startsWith("POSE ")).length', context), 13);
  assert.equal(vm.runInContext('atStance()', context), true);
});

test('walking block explains missing servo hold', () => {
  const context = robotWithReportedPose(false);
  assert.throws(() => vm.runInContext(`buildProgramSteps(${walkBlock}, 1)`, context), /Demostración → Sujeción/);
});

test('holding eight servos enables a complete walking block', async () => {
  const context = robotWithReportedPose(false);
  await vm.runInContext('actHoldAll()', context);
  assert.equal(vm.runInContext('SERVOS.filter(held).length', context), 8);
  assert.doesNotThrow(() => vm.runInContext('requireAllReady("ejecutar el movimiento")', context));
  const result = await vm.runInContext(`runProgramBlocks('caminar', ${walkBlock}, 1)`, context);
  assert.equal(result.status, 'done', result.error);
  assert.equal(vm.runInContext('robot.log.filter(entry => entry.cmd.startsWith("HOLD ")).length', context), 8);
});

test('single hold enables a disabled servo and waits for its reported PWM', async () => {
  const context = robotWithReportedPose(false);
  vm.runInContext(`robot.telemetry.R1.en = false; hardware.R1.en = false`, context);
  await vm.runInContext(`actHoldOne('R1')`, context);
  assert.equal(vm.runInContext('held("R1")', context), true);
  assert.equal(vm.runInContext('robot.log.some(entry => entry.cmd === "ENABLE R1")', context), true);
  assert.equal(vm.runInContext('robot.log.some(entry => entry.cmd === "HOLD R1")', context), true);
});

test('hold all re-enables every servo after release', async () => {
  const context = robotWithReportedPose(false);
  vm.runInContext(`for (const name of SERVOS) { robot.telemetry[name].en = false; hardware[name].en = false; }`, context);
  await vm.runInContext('actHoldAll()', context);
  assert.equal(vm.runInContext('SERVOS.filter(held).length', context), 8);
  assert.equal(vm.runInContext('robot.log.filter(entry => entry.cmd.startsWith("ENABLE ")).length', context), 8);
  assert.doesNotThrow(() => vm.runInContext('requireAllReady("ejecutar el movimiento")', context));
});

test('a queued HOLD without a fresh firmware status cannot unlock movement', async () => {
  const context = robotWithReportedPose(false);
  const confirmation = vm.runInContext(`(() => {
    const sentAt = performance.now();
    robot.telemetry.R1.pwm = true;
    return waitForHeld(['R1'], sentAt, 25);
  })()`, context);
  await assert.rejects(confirmation, /no confirmó la sujeción de R1/);
  assert.equal(vm.runInContext('held("R1")', context), false);
});

test('a complete initial pose lets a walking program start with PWM free', async () => {
  const context = robotWithReportedPose(false);
  const initial = `SERVOS.map(name => ({type:'servo',motor:name,angle:MEASURED_STANDING_POSE[name]}))`;
  const result = await vm.runInContext(`runProgramBlocks('desde_inicio', [...${initial}, ...${walkBlock}], 1)`, context);
  assert.equal(result.status, 'done', result.error);
});

test('walking block respects the saved swing range', () => {
  const context = robotWithReportedPose(true);
  vm.runInContext('robot.profile.walkSwing = {R1:{min:20,max:92,forward:1}}', context);
  assert.throws(() => vm.runInContext(`buildProgramSteps(${walkBlock}, 1)`, context), /R1 no tiene recorrido/);
});
