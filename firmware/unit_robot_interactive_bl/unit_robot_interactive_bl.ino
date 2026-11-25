// ============================================================================
// ARANA ROBOTICA - ESP32-C6 + PCA9685 + OLED + Bluetooth Low Energy
// Variante autonoma del firmware arana_api para la PWA unit_robot_interactive_bl.
// Los motores arrancan libres; la referencia logica de 90 grados NO es una medida.
// ============================================================================

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define FW_VERSION "2.6-BLE"

// ---- Opciones ----
#define ENABLE_OLED       1     // 0 = sin pantalla

// ==========================================
// HARDWARE
// ==========================================
#define SDA_PIN 6
#define SCL_PIN 7
// 400 kHz: un cuadro completo del OLED tarda ~25 ms (a 100 kHz serian ~100 ms y la
// animacion de los ojos frenaria a los servos). Si vuelven reinicios raros, prueba 100000.
#define I2C_CLOCK 400000

#define PCA9685_ADDR 0x40
#define SERVO_FREQ 50
#define NUM_SERVOS 8

// OLED SSD1306 128x64 en el mismo bus I2C
#define OLED_ADDR 0x3C
#define OLED_W 128
#define OLED_H 64

// Valores iniciales: requieren calibracion
#define SERVO_MIN_US 600
#define SERVO_MAX_US 2400

#define UPDATE_INTERVAL_MS 20
#define SERIAL_BUFFER_SIZE 256   // FACE con todos los parametros cabe de sobra

// Servicio GATT propio. Cada notificacion de estado cabe en el MTU minimo (20 bytes).
#define BLE_SERVICE_UUID "e85a8d40-3d8f-4af8-9bb6-71bfc98e0040"
#define BLE_COMMAND_UUID "e85a8d40-3d8f-4af8-9bb6-71bfc98e0041"
#define BLE_STATUS_UUID  "e85a8d40-3d8f-4af8-9bb6-71bfc98e0042"
#define BLE_COMMAND_SIZE 96

Adafruit_PWMServoDriver pwm(PCA9685_ADDR);
Adafruit_SSD1306 display(OLED_W, OLED_H, &Wire, -1);

// Tipos de los ojos. Deben ir ANTES de la primera funcion: Arduino genera los
// prototipos de las funciones ahi, y algunos usan estos tipos.
struct EyeP  { float w, h, r, open, bi, bo, lb; };
struct FaceP { EyeP e[2]; float x, y; };      // e[0] = izquierdo, e[1] = derecho; x,y = mirada

bool pcaOk = false;
bool oledOk = false;
volatile bool bleConnected = false;
bool previousBleConnected = false;
volatile bool stopRequested = false;
QueueHandle_t commandQueue = nullptr;
BLECharacteristic* statusCharacteristic = nullptr;
char lastCmd[22] = "-";
struct BleCommand { char text[BLE_COMMAND_SIZE]; };
bool statusBurst = false;
uint8_t statusIndex = 0;

// ==========================================
// CONFIGURACION DE SERVOMOTORES
// ==========================================
struct ServoConfig {
  const char* name;
  uint8_t channel;

  float minAngle;
  float maxAngle;

  float currentAngle;
  float targetAngle;

  float speed;       // grados por segundo

  bool inverted;
  bool enabled;
  bool moving;
  bool signalActive;
};

// R3 y L4 invertidos. Posicion inicial logica de 90 grados.
ServoConfig servos[NUM_SERVOS] = {
  {"R1", 0, 0, 160, 90, 90, 60, false, true, false, false},
  {"R2", 1, 0, 160, 90, 90, 60, false, true, false, false},
  {"R3", 2, 0, 180, 90, 90, 60, true,  true, false, false},
  {"R4", 3, 0, 180, 90, 90, 60, false, true, false, false},

  {"L1", 4, 0, 160, 90, 90, 60, false, true, false, false},
  {"L2", 5, 0, 160, 90, 90, 60, false, true, false, false},
  {"L3", 6, 0, 180, 90, 90, 60, false, true, false, false},
  {"L4", 7, 0, 180, 90, 90, 60, true,  true, false, false}
};

// Limites fisicos de fabrica (copiados de la tabla al arrancar)
float hardMin[NUM_SERVOS];
float hardMax[NUM_SERVOS];

// ==========================================
// ACCESO AL PCA9685 (no hace nada si no esta conectado)
// ==========================================
void pcaWriteUs(uint8_t channel, uint16_t us) {
  if (pcaOk) pwm.writeMicroseconds(channel, us);
}

void pcaOff(uint8_t channel) {
  if (pcaOk) pwm.setPWM(channel, 0, 0);
}

bool detectPca() {
  Wire.beginTransmission(PCA9685_ADDR);
  return Wire.endTransmission() == 0;
}

void initPca() {
  pwm.begin();
  pwm.setPWMFreq(SERVO_FREQ);
  delay(10);
  // Ningun motor se mueve automaticamente.
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    pwm.setPWM(servos[i].channel, 0, 0);
    servos[i].signalActive = false;
    servos[i].moving = false;
  }
}

// ==========================================
// CONVERSION DE ANGULOS
// ==========================================
float physicalAngle(uint8_t id, float angle) {
  ServoConfig &s = servos[id];
  angle = constrain(angle, s.minAngle, s.maxAngle);
  if (s.inverted) {
    angle = s.minAngle + s.maxAngle - angle;
  }
  return angle;
}

uint16_t angleToPulse(float angle) {
  angle = constrain(angle, 0.0f, 180.0f);
  return (uint16_t)(SERVO_MIN_US + (angle / 180.0f) * (SERVO_MAX_US - SERVO_MIN_US));
}

// ==========================================
// ESCRITURA / LIBERAR / ACTIVAR
// ==========================================
void writeServo(uint8_t id, float angle) {
  if (id >= NUM_SERVOS) return;
  ServoConfig &s = servos[id];
  if (!s.enabled) return;

  angle = constrain(angle, s.minAngle, s.maxAngle);
  pcaWriteUs(s.channel, angleToPulse(physicalAngle(id, angle)));

  s.currentAngle = angle;
  s.signalActive = pcaOk;
}

void freeServo(uint8_t id) {
  if (id >= NUM_SERVOS) return;
  ServoConfig &s = servos[id];
  s.moving = false;
  s.targetAngle = s.currentAngle;
  s.enabled = false;
  s.signalActive = false;
  pcaOff(s.channel);
  Serial.printf("%s liberado\n", s.name);
}

void enableServo(uint8_t id) {
  if (id >= NUM_SERVOS) return;
  ServoConfig &s = servos[id];
  s.enabled = true;
  s.moving = false;
  s.targetAngle = s.currentAngle;
  // No activa pulsos hasta recibir MOVE o HOLD.
  Serial.printf("%s habilitado\n", s.name);
}

// ==========================================
// DEFINIR OBJETIVO
// ==========================================
void moveServo(uint8_t id, float angle) {
  if (id >= NUM_SERVOS) return;
  ServoConfig &s = servos[id];

  if (!s.enabled) {
    Serial.printf("%s deshabilitado\n", s.name);
    return;
  }
  if (!pcaOk) {
    Serial.println("PCA9685 no conectado: movimiento ignorado");
    return;
  }

  float target = constrain(angle, s.minAngle, s.maxAngle);
  if (target != angle) {
    Serial.printf("%s: angulo limitado a %.1f\n", s.name, target);
  }
  s.targetAngle = target;

  // Si el servo estaba liberado, se comienza desde la posicion logica estimada.
  if (!s.signalActive) {
    writeServo(id, s.currentAngle);
  }

  s.moving = fabsf(s.targetAngle - s.currentAngle) > 0.05f;
  Serial.printf("%s: %.1f -> %.1f | %.1f grados/s\n",
                s.name, s.currentAngle, s.targetAngle, s.speed);
}

// ==========================================
// ACTUALIZACION NO BLOQUEANTE
// ==========================================
void updateServos() {
  static uint32_t lastUpdate = 0;
  uint32_t now = millis();
  uint32_t elapsed = now - lastUpdate;
  if (elapsed < UPDATE_INTERVAL_MS) return;
  lastUpdate = now;

  // Evita saltos grandes tras pausas (por ejemplo, durante una consulta HTTP).
  float dt = (elapsed > 40 ? 40 : elapsed) / 1000.0f;

  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    ServoConfig &s = servos[i];
    if (!s.enabled || !s.moving) continue;

    float error = s.targetAngle - s.currentAngle;
    float step = s.speed * dt;

    if (fabsf(error) <= step) {
      writeServo(i, s.targetAngle);
      s.moving = false;
    } else {
      writeServo(i, s.currentAngle + (error > 0 ? 1.0f : -1.0f) * step);
    }
  }
}

// ==========================================
// CONTROL DE PARES EN ESPEJO (R1-L1 ... R4-L4)
// ==========================================
void moveMirror(uint8_t pair, float angle) {
  if (pair < 1 || pair > 4) return;
  uint8_t right = pair - 1;
  uint8_t left  = pair + 3;
  ServoConfig &r = servos[right];
  ServoConfig &l = servos[left];

  float rightAngle = constrain(angle, r.minAngle, r.maxAngle);
  float normalized = (rightAngle - r.minAngle) / (r.maxAngle - r.minAngle);
  float leftAngle = l.maxAngle - normalized * (l.maxAngle - l.minAngle);

  moveServo(right, rightAngle);
  moveServo(left, leftAngle);
}

// ==========================================
// MOVIMIENTOS GLOBALES
// ==========================================
void moveAll(float angle) {
  for (uint8_t i = 0; i < NUM_SERVOS; i++) moveServo(i, angle);
}

void movePose(float angles[NUM_SERVOS]) {
  for (uint8_t i = 0; i < NUM_SERVOS; i++) moveServo(i, angles[i]);
}

// Postura ya calibrada: activar PWM directamente en cada angulo guardado.
// No pasa por los 90 grados logicos que aparecen tras un reinicio.
void holdPose(float angles[NUM_SERVOS]) {
  if (!pcaOk) { Serial.println("PCA9685 no conectado: postura ignorada"); return; }
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    const ServoConfig &s = servos[i];
    if (!s.enabled || !isfinite(angles[i]) || angles[i] < s.minAngle || angles[i] > s.maxAngle) {
      Serial.println("Postura calibrada invalida: revisar motores y rangos");
      return;
    }
  }
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    ServoConfig &s = servos[i];
    float angle = angles[i];
    s.targetAngle = angle;
    s.moving = false;
    writeServo(i, angle);
  }
}

void stopAll() {
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    servos[i].targetAngle = servos[i].currentAngle;
    servos[i].moving = false;
  }
  Serial.println("Movimientos detenidos");
}

// ==========================================
// ESTADO / AYUDA
// ==========================================
void printStatus() {
  Serial.println("\n========== ESTADO ==========");
  Serial.printf("PCA9685: %s | OLED: %s | BLE: %s\n",
                pcaOk ? "OK" : "NO", oledOk ? "OK" : "NO", bleConnected ? "CONECTADO" : "LIBRE");
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    ServoConfig &s = servos[i];
    Serial.printf("%s CH%d | %.1f -> %.1f | Rango %.0f-%.0f | Vel %.1f | INV:%d | %s | %s\n",
                  s.name, s.channel, s.currentAngle, s.targetAngle,
                  s.minAngle, s.maxAngle, s.speed, s.inverted,
                  s.enabled ? "ON" : "OFF", s.signalActive ? "PWM" : "FREE");
  }
  Serial.println("============================");
}

void printHelp() {
  Serial.println("\n--- COMANDOS ---");
  Serial.println("MOVE R1 120 | SPEED R1 45 | LIMIT R1 20 140 | INVERT R3 1");
  Serial.println("MIRROR 1 60 | ALL 90 | POSE 90 90 90 90 90 90 90 90");
  Serial.println("POSE_HOLD a1 a2 a3 a4 a5 a6 a7 a8 (postura calibrada)");
  Serial.println("CENTER | STOP | FREE R1 | ENABLE R1 | HOLD R1 | STATUS | HELP");
  Serial.println("BLE: RELEASE (todos libres) | ARM (todos habilitados)");
  Serial.println("EYES HAPPY | EYES SAD 3000 | EYES NORMAL | EYES STATUS (ver estado)");
  Serial.println("FACE T=300 O=60 BI=30 L.O=10 X=8  (ojos por parametros) | TEXT 3000 hola");
}

int findServo(const char* name) {
  for (int i = 0; i < NUM_SERVOS; i++) {
    if (strcmp(name, servos[i].name) == 0) return i;
  }
  return -1;
}

// ==========================================
// CARA / OJOS PARAMETRICOS (estado; lo usan los comandos EYES, FACE y TEXT)
// ==========================================
// Cada ojo se dibuja a partir de numeros. El servidor guarda "caras" con nombre
// y las manda con el comando FACE; el ESP32 hace la transicion suave entre caras.
//   w,h = tamano | r = redondez | open = % abierto | bi/bo = ceja interior/exterior (%)
//   lb = parpado inferior (%), sube desde abajo (ojos felices "^")
// (EyeP y FaceP estan definidos al inicio del archivo)

enum Mood { MOOD_NORMAL, MOOD_HAPPY, MOOD_SAD, MOOD_ANGRY, MOOD_SLEEP, MOOD_SURPRISED };
const char* MOOD_NAMES[] = {"NORMAL", "HAPPY", "SAD", "ANGRY", "SLEEP", "SURPRISED"};
const int NUM_MOODS = 6;

FaceP faceCur, faceFrom, faceTo;
uint32_t faceT0 = 0, faceDur = 0;
bool faceAnimating = false;
bool faceDirty = true;            // forzar redibujo
uint32_t faceRevertAt = 0;        // 0 = la cara se queda
bool autoBlink = true, autoLook = true;
bool showStatusScreen = false;    // EYES STATUS alterna ojos / pantalla de estado

char screenText[22] = "";         // texto corto bajo los ojos (21 caracteres)
uint32_t textUntil = 0;           // 0 = sin limite de tiempo

float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

FaceP presetFace(int m) {
  FaceP f;
  EyeP n = {36, 36, 9, 100, 0, 0, 0};
  f.e[0] = n; f.e[1] = n; f.x = 0; f.y = 0;
  for (int i = 0; i < 2; i++) {
    EyeP &e = f.e[i];
    switch (m) {
      case MOOD_HAPPY:     e.lb = 45; break;
      case MOOD_SAD:       e.bo = 55; break;
      case MOOD_ANGRY:     e.bi = 55; break;
      case MOOD_SLEEP:     e.open = 10; break;
      case MOOD_SURPRISED: e.w = 40; e.h = 40; e.r = 20; break;
      default: break;
    }
  }
  return f;
}

void applyFace(const FaceP &target, uint32_t transitionMs, uint32_t durationMs) {
  faceFrom = faceCur;
  faceTo = target;
  faceT0 = millis();
  faceDur = transitionMs;
  faceAnimating = transitionMs > 0;
  if (!faceAnimating) faceCur = target;
  faceRevertAt = durationMs ? millis() + durationMs : 0;
  faceDirty = true;
}

int moodFromName(const char* n) {
  for (int i = 0; i < NUM_MOODS; i++) if (strcmp(n, MOOD_NAMES[i]) == 0) return i;
  return -1;
}

void setMood(int m, uint32_t durationMs) {
  autoBlink = (m != MOOD_SLEEP && m != MOOD_SURPRISED);
  autoLook  = (m != MOOD_SLEEP);
  applyFace(presetFace(m), 250, durationMs);
  Serial.printf("Ojos: %s%s\n", MOOD_NAMES[m], durationMs ? " (temporal)" : "");
}

// FACE T=300 D=0 W=36 H=36 R=9 O=100 BI=0 BO=0 LB=0 X=0 Y=0 AB=1 AL=1 L.O=10 R.BI=30
//   T = transicion (ms), D = duracion antes de volver a normal (ms, 0 = se queda)
//   X,Y = mirada | AB/AL = parpadeo / mirada automatica (1 o 0)
//   Sin prefijo = ambos ojos; L. = solo el izquierdo; R. = solo el derecho.
//   Lo que no se indica se conserva.
void cmdFace(char* rest) {
  FaceP t = faceTo;
  uint32_t T = 250, D = 0;
  int n = 0;
  for (char* tok = strtok(rest, " ,\t"); tok; tok = strtok(NULL, " ,\t")) {
    char* eq = strchr(tok, '=');
    if (!eq) continue;
    *eq = '\0';
    for (char* p = tok; *p; ++p) *p = toupper((unsigned char)*p);
    float v = atof(eq + 1);
    int eyeSel = -1;                     // -1 ambos, 0 izquierdo, 1 derecho
    const char* key = tok;
    if ((key[0] == 'L' || key[0] == 'R') && key[1] == '.') { eyeSel = key[0] == 'L' ? 0 : 1; key += 2; }
    n++;
    if (eyeSel == -1) {
      if (!strcmp(key, "T"))  { T = (uint32_t)clampf(v, 0, 5000);   continue; }
      if (!strcmp(key, "D"))  { D = (uint32_t)clampf(v, 0, 600000); continue; }
      if (!strcmp(key, "X"))  { t.x = clampf(v, -20, 20);            continue; }
      if (!strcmp(key, "Y"))  { t.y = clampf(v, -12, 12);            continue; }
      if (!strcmp(key, "AB")) { autoBlink = v != 0;                  continue; }
      if (!strcmp(key, "AL")) { autoLook = v != 0;                   continue; }
    }
    for (int i = 0; i < 2; i++) {
      if (eyeSel != -1 && eyeSel != i) continue;
      EyeP &e = t.e[i];
      if      (!strcmp(key, "W"))  e.w    = clampf(v, 10, 50);
      else if (!strcmp(key, "H"))  e.h    = clampf(v, 4, 56);
      else if (!strcmp(key, "R"))  e.r    = clampf(v, 0, 28);
      else if (!strcmp(key, "O"))  e.open = clampf(v, 0, 100);
      else if (!strcmp(key, "BI")) e.bi   = clampf(v, 0, 80);
      else if (!strcmp(key, "BO")) e.bo   = clampf(v, 0, 80);
      else if (!strcmp(key, "LB")) e.lb   = clampf(v, 0, 80);
      else { Serial.printf("FACE: clave desconocida %s\n", key); break; }
    }
  }
  showStatusScreen = false;
  applyFace(t, T, D);
  Serial.printf("Cara: %d parametros, transicion %lu ms\n", n, (unsigned long)T);
}

// TEXT <ms> <mensaje>   (ms = 0: se queda;  "TEXT 0" sin mensaje lo borra)
void cmdText(char* rest) {
  while (*rest == ' ') rest++;
  char* endp = rest;
  uint32_t ms = strtoul(rest, &endp, 10);
  rest = endp;
  while (*rest == ' ') rest++;
  strlcpy(screenText, rest, sizeof(screenText));
  textUntil = (ms && screenText[0]) ? millis() + ms : 0;
  showStatusScreen = false;
  faceDirty = true;
  Serial.printf("Texto: \"%s\"\n", screenText);
}

bool startsWithWord(const char* line, const char* w) {
  size_t n = strlen(w);
  for (size_t i = 0; i < n; i++) {
    if (toupper((unsigned char)line[i]) != w[i]) return false;
  }
  return line[n] == ' ' || line[n] == '\t' || line[n] == '\0';
}

// ==========================================
// PROCESAMIENTO DE COMANDOS (serial y BLE usan el mismo)
// ==========================================
void processCommand(char* line) {
  // FACE y TEXT se procesan antes de partir en palabras (TEXT conserva mayusculas)
  if (startsWithWord(line, "FACE")) { cmdFace(line + 4); return; }
  if (startsWithWord(line, "TEXT")) { cmdText(line + 4); return; }

  char* args[12];
  int count = 0;

  char* token = strtok(line, " ,\t");
  while (token && count < 12) {
    args[count++] = token;
    token = strtok(NULL, " ,\t");
  }
  if (count == 0) return;

  for (int i = 0; i < count; i++) {
    for (char* p = args[i]; *p; ++p) *p = toupper((unsigned char)*p);
  }

  const char* cmd = args[0];

  if (strcmp(cmd, "HELP") == 0)   { printHelp();   return; }
  if (strcmp(cmd, "STATUS") == 0) { printStatus(); return; }
  if (strcmp(cmd, "STOP") == 0)   { stopAll();     return; }
  if (strcmp(cmd, "CENTER") == 0) { moveAll(90);   return; }

  if (strcmp(cmd, "ALL") == 0 && count == 2) { moveAll(atof(args[1])); return; }

  if (strcmp(cmd, "POSE") == 0 && count == 9) {
    float angles[NUM_SERVOS];
    for (int i = 0; i < NUM_SERVOS; i++) angles[i] = atof(args[i + 1]);
    movePose(angles);
    return;
  }
  if (strcmp(cmd, "POSE_HOLD") == 0 && count == 9) {
    float angles[NUM_SERVOS];
    for (int i = 0; i < NUM_SERVOS; i++) angles[i] = atof(args[i + 1]);
    holdPose(angles);
    return;
  }

  if (strcmp(cmd, "MIRROR") == 0 && count == 3) {
    int pair = atoi(args[1]);
    if (pair < 1 || pair > 4) { Serial.println("Par invalido (1-4)"); return; }
    moveMirror(pair, atof(args[2]));
    return;
  }

  // EYES <NORMAL|HAPPY|SAD|ANGRY|SLEEP|SURPRISED|STATUS> [ms]
  if (strcmp(cmd, "EYES") == 0 && count >= 2) {
    if (strcmp(args[1], "STATUS") == 0) {
      showStatusScreen = !showStatusScreen;
      Serial.printf("Pantalla: %s\n", showStatusScreen ? "estado" : "ojos");
      return;
    }
    int m = moodFromName(args[1]);
    if (m < 0) { Serial.println("Expresion invalida: NORMAL HAPPY SAD ANGRY SLEEP SURPRISED STATUS"); return; }
    showStatusScreen = false;
    setMood(m, count >= 3 ? (uint32_t)atol(args[2]) : 0);
    return;
  }

  if (count < 2) { Serial.println("Comando incompleto"); return; }

  int id = findServo(args[1]);
  if (id < 0) { Serial.println("Motor no encontrado"); return; }
  ServoConfig &s = servos[id];

  if (strcmp(cmd, "MOVE") == 0 && count == 3) {
    moveServo(id, atof(args[2]));
  }
  else if (strcmp(cmd, "SPEED") == 0 && count == 3) {
    s.speed = constrain((float)atof(args[2]), 1.0f, 180.0f);
    Serial.printf("%s velocidad %.1f grados/s\n", s.name, s.speed);
  }
  else if (strcmp(cmd, "LIMIT") == 0 && count == 4) {
    float low = atof(args[2]);
    float high = atof(args[3]);
    if (low < 0 || high > 180 || low >= high) { Serial.println("Rango invalido"); return; }
    s.moving = false;
    s.minAngle = low;
    s.maxAngle = high;
    s.currentAngle = constrain(s.currentAngle, low, high);
    s.targetAngle = s.currentAngle;
    // Requiere verificar posicion fisica antes de enviar una nueva orden.
    s.signalActive = false;
    pcaOff(s.channel);
    Serial.println("Limites actualizados; PWM liberado");
  }
  else if (strcmp(cmd, "INVERT") == 0 && count == 3) {
    bool newValue = atoi(args[2]) != 0;
    if (s.inverted != newValue) {
      s.moving = false;
      s.inverted = newValue;
      pcaOff(s.channel);           // evitar giro inmediato
      s.signalActive = false;
    }
    Serial.printf("%s inversion: %d\n", s.name, s.inverted);
  }
  else if (strcmp(cmd, "FREE") == 0 && count == 2)   { freeServo(id); }
  else if (strcmp(cmd, "ENABLE") == 0 && count == 2) { enableServo(id); }
  else if (strcmp(cmd, "HOLD") == 0 && count == 2) {
    if (s.enabled && pcaOk) {
      s.moving = false;
      s.targetAngle = s.currentAngle;
      writeServo(id, s.currentAngle);
      Serial.printf("%s PWM activo\n", s.name);
    }
  }
  else {
    Serial.println("Comando invalido. HELP");
  }
}

// ==========================================
// LECTURA SERIAL NO BLOQUEANTE
// ==========================================
void readSerial() {
  static char buffer[SERIAL_BUFFER_SIZE];
  static size_t pos = 0;

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (pos > 0) {
        buffer[pos] = '\0';
        processCommand(buffer);
        pos = 0;
      }
    } else if (pos < sizeof(buffer) - 1) {
      buffer[pos++] = c;
    } else {
      pos = 0;
      Serial.println("Comando demasiado largo");
    }
  }
}

// El callback BLE solo encola texto; toda escritura I2C y el parser corren en loop().
class RobotServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleConnected = true; }
  void onDisconnect(BLEServer*) override {
    bleConnected = false;
    stopRequested = true;
  }
};

class RobotCommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String value = characteristic->getValue();
    if (value.isEmpty() || value.length() >= BLE_COMMAND_SIZE || commandQueue == nullptr) return;
    if (value.equalsIgnoreCase("STOP")) {
      stopRequested = true;
      return;
    }
    BleCommand command{};
    value.toCharArray(command.text, sizeof(command.text));
    xQueueSend(commandQueue, &command, 0);
  }
};

void notifyBle(const char* message) {
  if (!bleConnected || statusCharacteristic == nullptr) return;
  statusCharacteristic->setValue(String(message));
  statusCharacteristic->notify();
}

void sendBleHeader() {
  char message[20];
  snprintf(message, sizeof(message), "P,%d,%d,%s", pcaOk, oledOk, FW_VERSION);
  notifyBle(message);
}

void sendBleServo(uint8_t index) {
  const ServoConfig &s = servos[index];
  char message[20];
  snprintf(message, sizeof(message), "S,%s,%d,%d,%d,%d", s.name,
           (int)roundf(s.currentAngle), (int)roundf(s.targetAngle),
           s.enabled, s.signalActive);
  notifyBle(message);
}

void processBleCommand(char* command) {
  strlcpy(lastCmd, command, sizeof(lastCmd));
  if (strcmp(command, "STATUS") == 0) {
    sendBleHeader();
  } else if (strcmp(command, "RELEASE") == 0) {
    stopAll();
    for (uint8_t i = 0; i < NUM_SERVOS; i++) freeServo(i);
  } else if (strcmp(command, "ARM") == 0) {
    for (uint8_t i = 0; i < NUM_SERVOS; i++) enableServo(i);
  } else {
    processCommand(command);
  }
  statusBurst = true;
  statusIndex = 0;
}

void updateBle() {
  if (stopRequested) {
    stopRequested = false;
    xQueueReset(commandQueue); // STOP descarta ordenes de movimiento pendientes.
    stopAll();
    statusBurst = true;
    statusIndex = 0;
  }
  if (bleConnected != previousBleConnected) {
    previousBleConnected = bleConnected;
    if (bleConnected) {
      Serial.println("[BLE] App conectada");
      sendBleHeader();
      statusBurst = true;
      statusIndex = 0;
    } else {
      Serial.println("[BLE] App desconectada; movimientos detenidos");
      BLEDevice::startAdvertising();
    }
  }
  BleCommand command{};
  if (bleConnected && xQueueReceive(commandQueue, &command, 0) == pdTRUE) {
    processBleCommand(command.text);
  }
  static uint32_t lastStatus = 0;
  static uint32_t lastHeader = 0;
  const uint32_t now = millis();
  if (!bleConnected) return;
  if (now - lastHeader >= 5000) {
    lastHeader = now;
    sendBleHeader();
  }
  if (now - lastStatus >= (statusBurst ? 100u : 250u)) {
    lastStatus = now;
    sendBleServo(statusIndex);
    statusIndex = (statusIndex + 1) % NUM_SERVOS;
    if (statusIndex == 0) statusBurst = false;
  }
}

void setupBle() {
  commandQueue = xQueueCreate(8, sizeof(BleCommand));
  if (commandQueue == nullptr) {
    Serial.println("[BLE] Sin memoria para comandos");
    return;
  }
  BLEDevice::init("Spider-BLE");
  BLEDevice::setMTU(185);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new RobotServerCallbacks());
  BLEService* service = server->createService(BLE_SERVICE_UUID);
  BLECharacteristic* command = service->createCharacteristic(
    BLE_COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE);
  command->setCallbacks(new RobotCommandCallbacks());
  statusCharacteristic = service->createCharacteristic(
    BLE_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  statusCharacteristic->addDescriptor(new BLE2902());
  statusCharacteristic->setValue(String("P,0,0,") + FW_VERSION);
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
  Serial.println("[BLE] Spider-BLE anunciando");
}

// ==========================================
// OLED
// ==========================================
void oledMessage(const char* l1, const char* l2) {
  if (!oledOk) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(l1);
  display.println(l2);
  display.display();
}

// ==========================================
// OJOS: DIBUJO Y ANIMACION
// ==========================================
float blinkF = 1.0f;              // 1 = abierto, ~0 = cerrado (parpadeo automatico)
int   blinkPhase = 0;             // 0 nada, 1 cerrando, 2 abriendo
float lookAX = 0, lookAY = 0, lookTX = 0, lookTY = 0;   // mirada automatica
uint32_t nextBlink = 2000, nextLook = 1500;
const int EYE_DX = 28;            // distancia del centro de la pantalla a cada ojo

// Tapa una esquina superior del ojo con un triangulo negro (ceja)
void cutCorner(int x, int y, int w, int h, bool leftSide, float pct) {
  int depth = (int)(h * pct / 100.0f);
  if (depth < 1) return;
  if (leftSide) display.fillTriangle(x - 1, y - 1, x + w * 9 / 10, y - 1, x - 1, y + depth, SSD1306_BLACK);
  else          display.fillTriangle(x + w + 1, y - 1, x + w / 10, y - 1, x + w + 1, y + depth, SSD1306_BLACK);
}

void drawEye(int cx, int cy, const EyeP &p, bool isLeft, float lx, float ly) {
  int w = (int)p.w;
  int h = (int)(p.h * p.open / 100.0f * blinkF);
  if (h < 2) h = 2;
  int r = min((int)p.r, min(h / 2, w / 2));
  int x = cx - w / 2 + (int)lx;
  int y = cy - h / 2 + (int)ly;
  display.fillRoundRect(x, y, w, h, r, SSD1306_WHITE);
  if (h < 8) return;              // muy cerrado: sin cejas ni parpado
  if (p.lb > 0) {
    // Parpado inferior en arco: un circulo negro grande debajo deja el ojo con forma "^"
    int ycut = y + (int)(h * (100 - p.lb) / 100.0f);
    int R = (int)(w * 0.75f);
    display.fillCircle(x + w / 2, ycut + R, R, SSD1306_BLACK);
  }
  // Ojo izquierdo: su lado interior es el derecho. Ojo derecho: al reves.
  if (p.bi > 0) cutCorner(x, y, w, h, !isLeft, p.bi);
  if (p.bo > 0) cutCorner(x, y, w, h, isLeft, p.bo);
}

float smooth01(float p) { return p * p * (3.0f - 2.0f * p); }

// Avanza la animacion. Devuelve true si hay que redibujar.
bool animateEyes(float dt) {
  uint32_t now = millis();
  bool changed = faceDirty;
  faceDirty = false;

  if (faceRevertAt && now >= faceRevertAt) {        // cara temporal terminada
    autoBlink = true; autoLook = true;
    applyFace(presetFace(MOOD_NORMAL), 300, 0);
    changed = true;
  }
  if (textUntil && now >= textUntil) { textUntil = 0; screenText[0] = '\0'; changed = true; }

  // Transicion suave entre la cara anterior y la nueva
  if (faceAnimating) {
    float p = faceDur ? (float)(now - faceT0) / faceDur : 1.0f;
    if (p >= 1.0f) { p = 1.0f; faceAnimating = false; }
    float s = smooth01(p);
    const float* a = (const float*)&faceFrom;
    const float* b = (const float*)&faceTo;
    float* c = (float*)&faceCur;
    for (size_t i = 0; i < sizeof(FaceP) / sizeof(float); i++) c[i] = a[i] + (b[i] - a[i]) * s;
    changed = true;
  }

  // Parpadeo automatico
  if (autoBlink) {
    if (blinkPhase == 0 && now >= nextBlink) blinkPhase = 1;
    if (blinkPhase == 1) {
      blinkF -= dt * 9.0f;
      if (blinkF <= 0.05f) { blinkF = 0.05f; blinkPhase = 2; }
      changed = true;
    } else if (blinkPhase == 2) {
      blinkF += dt * 9.0f;
      if (blinkF >= 1.0f) {
        blinkF = 1.0f; blinkPhase = 0;
        nextBlink = now + random(2000, 6000);
        if (random(0, 5) == 0) nextBlink = now + 180;   // a veces parpadea doble
      }
      changed = true;
    }
  } else if (blinkF != 1.0f) { blinkF = 1.0f; blinkPhase = 0; changed = true; }

  // Mirada automatica: un punto nuevo cada pocos segundos, movimiento suave
  if (autoLook) {
    if (now >= nextLook) {
      if (random(0, 3) == 0) { lookTX = 0; lookTY = 0; }
      else { lookTX = random(-14, 15); lookTY = random(-6, 7); }
      nextLook = now + random(1500, 4500);
    }
  } else { lookTX = 0; lookTY = 0; }
  float k = min(1.0f, dt * 10.0f);
  float nx = lookAX + (lookTX - lookAX) * k;
  float ny = lookAY + (lookTY - lookAY) * k;
  if ((int)nx != (int)lookAX || (int)ny != (int)lookAY) changed = true;
  lookAX = nx; lookAY = ny;

  return changed;
}

void drawStatusScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.printf("B:%s P:%s v%s",
                 bleConnected ? "OK" : "--", pcaOk ? "OK" : "--", FW_VERSION);
  display.setCursor(0, 8);
  display.print("Spider-BLE");
  display.setCursor(0, 16);
  display.print(bleConnected ? "App conectada" : "Esperando app");
  display.setCursor(0, 24);
  display.printf(">%s", lastCmd);
  for (uint8_t p = 0; p < 4; p++) {
    const ServoConfig &r = servos[p];
    const ServoConfig &l = servos[p + 4];
    display.setCursor(0, 36 + p * 7);
    display.printf("%s %3d%c  %s %3d%c",
                   r.name, (int)r.currentAngle, r.signalActive ? (r.moving ? '*' : '=') : '.',
                   l.name, (int)l.currentAngle, l.signalActive ? (l.moving ? '*' : '=') : '.');
  }
  display.display();
}

void updateOled() {
  if (!oledOk) return;
  static uint32_t lastFrame = 0, lastFull = 0;
  uint32_t now = millis();

  bool anyMoving = false;
  for (uint8_t i = 0; i < NUM_SERVOS; i++) anyMoving |= servos[i].moving;

  if (showStatusScreen) {
    if (now - lastFull >= (anyMoving ? 1000u : 500u)) { lastFull = now; drawStatusScreen(); }
    return;
  }

  // ~25 fps en reposo, ~12 fps mientras se mueven servos (para no frenarlos)
  uint32_t minFrame = anyMoving ? 80 : 40;
  if (now - lastFrame < minFrame) return;
  float dt = (now - lastFrame) / 1000.0f;
  if (dt > 0.2f) dt = 0.2f;
  lastFrame = now;

  bool changed = animateEyes(dt);

  // Barra de estado arriba solo si algo falla (o los primeros 5 s)
  bool problem = !pcaOk || now < 5000;
  if (!changed && now - lastFull < 1000) return;   // nada nuevo: no gastar I2C
  lastFull = now;

  display.clearDisplay();
  int cy = 32;
  if (problem) {
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.printf("B:%s P:%s", bleConnected ? "OK" : "--", pcaOk ? "OK" : "--");
    cy = 36;
  }
  bool hasText = screenText[0] != '\0';
  if (hasText) cy -= 5;

  float lx = faceCur.x + lookAX;
  float ly = faceCur.y + lookAY;
  drawEye(64 - EYE_DX, cy, faceCur.e[0], true,  lx, ly);
  drawEye(64 + EYE_DX, cy, faceCur.e[1], false, lx, ly);

  if (hasText) {
    display.fillRect(0, 55, 128, 9, SSD1306_BLACK);
    int len = strlen(screenText);
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(max(0, (128 - len * 6) / 2), 56);
    display.print(screenText);
  } else if (!autoBlink && !autoLook && faceCur.e[0].open < 20 && faceCur.e[1].open < 20) {
    // dormido: una "z" que palpita
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(110, problem ? 12 : 4);
    display.print((now / 600) % 2 ? "z" : "Z");
  }
  display.display();
}

// ==========================================
// SETUP
// ==========================================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n[boot] FW %s | motivo del reinicio anterior: %d\n",
                FW_VERSION, (int)esp_reset_reason());

  faceCur = faceFrom = faceTo = presetFace(MOOD_NORMAL);

  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    hardMin[i] = servos[i].minAngle;
    hardMax[i] = servos[i].maxAngle;
  }

  // Primero I2C y PCA9685: el PCA9685 conserva el PWM aunque el ESP32 se reinicie, asi
  // que los servos seguirian con carga. Se liberan ANTES de encender la radio, que en su
  // arranque/calibracion pide picos de corriente.
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(I2C_CLOCK);
  pcaOk = detectPca();
  if (pcaOk) {
    initPca();
    Serial.println("PCA9685 OK");
  } else {
    Serial.println("AVISO: PCA9685 no detectado. Reviso cada 3 s; BLE sigue funcionando.");
  }


#if ENABLE_OLED
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  Wire.setClock(I2C_CLOCK);        // la libreria del OLED cambia el reloj
  if (!oledOk) Serial.println("AVISO: OLED no detectado");
#endif
  oledMessage("ARANA BLE", "Esperando app");

  setupBle();


  Serial.println("\nARANA BLE - 8 SERVOMOTORES (ESP32-C6 + PCA9685)");
  printHelp();
  printStatus();
}

// ==========================================
// LOOP
// ==========================================
void loop() {
  readSerial();
  updateBle();

  // Reintentar el PCA9685 si no estaba conectado
  static uint32_t lastPcaTry = 0;
  if (!pcaOk && millis() - lastPcaTry > 3000) {
    lastPcaTry = millis();
    if (detectPca()) {
      pcaOk = true;
      initPca();
      Serial.println("PCA9685 detectado");
    }
  }

  updateServos();
  updateOled();
  delay(1);
}
