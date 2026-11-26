const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const docs = path.join(__dirname, '..', 'docs');
const walkBlock = `[{type:'walk_cycle',legs:Object.fromEntries(['R1','L2','L1','R2']
  .map(name=>[name,{stride:3,lift:5}])),pause:0}]`;

function robotWithReportedPose(holding) {
  const values = new Map();
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
    robot.profile.stance = {...MEASURED_STANDING_POSE};
    const hardware = Object.fromEntries(SERVOS.map(name => [name, {en:true, pwm:${holding}}]));
    robot.transport = async command => {
      const [verb, name] = command.split(' ');
      if (verb === 'ENABLE') hardware[name].en = true;
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
  vm.runInContext('robot.profile.walkSwing = {R1:{min:0,max:72,forward:1}}', context);
  assert.throws(() => vm.runInContext(`buildProgramSteps(${walkBlock}, 1)`, context), /R1 no tiene recorrido/);
});
