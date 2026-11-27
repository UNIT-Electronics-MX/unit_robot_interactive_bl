# UNIT Spider · Control BLE

Aplicación web instalable para controlar la araña robótica por Bluetooth Low Energy. Incluye una variante autónoma del firmware original: ocho servos con PCA9685, ojos OLED, límites e inversión de motores. No necesita servidor, Wi-Fi, cuenta ni conexión a internet después de la primera carga de la PWA.

## Estructura

```text
unit_robot_interactive_bl/
├── docs/
│   ├── index.html              # entrada del sitio estático
│   ├── app.js                  # Web Bluetooth e interfaz por pestañas
│   ├── robot-core.js           # lógica del robot (equivalente BLE de server/main.py)
│   ├── robot-profile.js        # datos por defecto: perfil de motores, patas, caras y rutinas
│   ├── sesame-moves.js         # secuencias del robot Sesame (poses y marchas)
│   ├── styles.css              # diseño adaptable
│   ├── manifest.webmanifest    # instalación PWA
│   ├── sw.js                   # caché para uso sin internet
│   └── icons/
└── firmware/
    └── unit_robot_interactive_bl/
        └── unit_robot_interactive_bl.ino
```

## Hardware y firmware

- Placa: **ESP32-C6** (el mismo del proyecto `arana_api`).
- PCA9685: dirección `0x40`, SDA en GPIO **6**, SCL en GPIO **7**; ocho servos en canales **0–7**.
- OLED SSD1306 opcional: 128×64, dirección `0x3C`, en el mismo bus I²C.
- Alimenta los servos con una fuente adecuada independiente y une su GND con el GND del ESP32. No uses el pin de 3,3 V del ESP32 para alimentar servos.
- Librerías de Arduino: **Adafruit PWM Servo Driver**, **Adafruit GFX** y **Adafruit SSD1306**. El paquete de placa usado para compilar es `esp32:esp32` 3.3.1.

```bash
arduino-cli compile --fqbn esp32:esp32:esp32c6 unit_robot_interactive_bl/firmware/unit_robot_interactive_bl
arduino-cli board list
arduino-cli upload --fqbn esp32:esp32:esp32c6 -p /dev/ttyACM0 unit_robot_interactive_bl/firmware/unit_robot_interactive_bl
```

Sustituye `/dev/ttyACM0` por el puerto de tu placa. El dispositivo se anuncia como **Spider-BLE**. Al iniciar, el firmware **libera los pulsos** de los servos; el valor lógico de 90° no mide su posición física. Al conectar la web, se aplican los límites calibrados y la postura de pie 90°/70°, y se confirma la sujeción de los ocho motores antes de habilitar rutinas. En la barra superior, **Conectar/Desconectar** y **Habilitar/Liberar servos** son botones de dos estados. **Detener** detiene la trayectoria y mantiene el PWM activo; **Liberar servos** apaga los pulsos y deshabilita los motores, y el mismo botón pasa a **Habilitar servos**. Si se pierde la conexión BLE, el firmware detiene las trayectorias en curso.

## Publicar o probar la web

Sirve **`unit_robot_interactive_bl/docs`** como raíz de un alojamiento estático. No requiere proceso de construcción ni dependencias de red. Para probar localmente:

```bash
cd unit_robot_interactive_bl/docs
python3 -m http.server 8000
```

Abre `http://localhost:8000` en Chrome o Edge. Para usarla desde otro dispositivo, publícala con **HTTPS**. Si este directorio se convierte en un repositorio independiente, GitHub Pages puede servir su carpeta `/docs`. Si permanece anidado en este repositorio, configura el alojamiento estático con `unit_robot_interactive_bl/docs` como raíz o usa su URL anidada. La PWA guarda HTML, CSS, JavaScript, manifest e iconos al abrirse una vez; después puede abrirse sin internet. Bluetooth sigue necesitando que el navegador tenga Web Bluetooth y que el robot esté encendido y cerca. Chrome en Android y Chrome/Edge de escritorio lo admiten; Safari en iOS no ofrece Web Bluetooth para esta interfaz.

1. Carga el firmware en el ESP32-C6.
2. Abre la web por HTTPS o `localhost` y pulsa **Conectar robot**.
3. Elige **Spider-BLE** en el selector del navegador.
4. Espera al aviso **Postura de pie calibrada aplicada; ocho servos sujetos**. Ya puedes mover servos o ejecutar rutinas.
5. Para instalarla, usa el botón **Instalar aplicación** si aparece o el menú del navegador **Añadir a pantalla de inicio**.

## Funciones de la página (equivalentes al proyecto general)

La PWA reproduce, sin servidor, las funciones del panel general (`app/` + `server/main.py`). Todo lo que describe al robot vive en la página y se guarda en el navegador: el perfil y las posturas por robot BLE, y las caras, rutinas y programas compartidos entre robots. El firmware solo ejecuta órdenes. `robot-core.js` traduce la lógica de `server/main.py`; `robot-profile.js` contiene los valores por defecto de `firmware/arana_api`, `server/faces.json` y `server/routines.json`.

Las cuatro rutinas pregrabadas de patas usan `stance_offset`: sus grados se suman a la **postura de apoyo de ese robot**. Esta instalación ya tiene calibrada la postura de pie: caderas a 90° y pies a 70°. La web la aplica al conectar y comprueba los ocho servos. Si cambiaste de posición, pulsa **Recuperar postura guardada** antes de ejecutar una rutina de patas. Puedes guardar otros ángulos con **Guardar postura de pie y activar auto**. `saludo_ojos` solo cambia la OLED y no mueve motores.

Para el Spider BLE medido, los rangos de R1/L1 son 20°–128°, los de R2/L2 son 30°–128° y los de R3/R4/L3/L4 son 0°–180°. **Mover patas → Usar postura medida (sin mover)** restablece la referencia de pie R1/R2/L1/L2 90° y R3/R4/L3/L4 70°, y activa su recuperación automática. **Descansar (pies a 150°)** acuesta el robot conservando las caderas a 90°. La postura de inicio acostada también viene cargada con esos valores, pero su aplicación automática está desactivada para que las rutinas arranquen desde la postura de pie. Los perfiles antiguos sin postura guardada reciben automáticamente esta calibración; las posturas personalizadas se conservan.

El paso de caminata de la web BLE inicia con **12° de avance** por pata, en vez de los 4° anteriores. Si no se guardaron elevaciones por pata, usa **10° de subida de prueba** en vez de 5°. La espera adicional entre sus trece fases es de 40 ms; las demás rutinas conservan su espera de 120 ms. Si los pies se despegan pero el cuerpo apenas avanza, prueba un avance mayor dentro del rango y comprueba el sentido de R1, R2, L1 y L2 en **Recorrido de avance por motor**. La **Velocidad general** está en **Servomotores**; 1,0 s por 90° equivale a 90 °/s.

Las cuatro pruebas de patas permiten elegir 1× (5° de giro y 10° de elevación), 2× (10°/20°) o 3× (15°/30°) antes de pulsar ▶. La página verifica toda la secuencia contra el perfil del servo antes de enviar el primer comando. Esto cambia el recorrido de la prueba, no amplía los límites físicos del motor.

| Pestaña | Qué hace | Equivale a |
| --- | --- | --- |
| Demostración | Sujeción de los ocho servos (todo o nada), coreografías Sesame y caras de un toque | Demostración |
| Servomotores | Mover cada servo, sujetar, liberar o activar; mover los 8, centrar, par en espejo; velocidad general por segundos para 90°; **Perfil del robot** (rango, inversión y velocidad); prueba de respuesta BLE/ESP32 sin movimiento | Servomotores |
| Mover patas | Adelante/Atrás/Arriba/Abajo por pata; postura de pie automática; botón Descansar a 90°/150°; recorrido y sentido de avance; elevación por pata; caminata; postura acostada al iniciar con `POSE_HOLD` | Mover patas |
| Bloques y rutinas | Programas de bloques (servo, mover pata, paso de pata, caminata, cara, esperar, volver al inicio, rutina o programa guardado) con 1–3 ciclos, comprobación de rango y conversión de cuatro pasos en caminata; probador rápido de secuencias; rutinas en JSON | Editar bloques |
| Caritas | Editor de caras con vista previa OLED 128×64, ajustes por ojo, transición y duración; texto en pantalla; pantalla de estado | Editar caritas |
| Sesame | 15 poses y 2 giros adaptados de Sesame; adelante y atrás usan el paso calibrado | — |
| Bitácora | Últimas 300 órdenes enviadas con su origen | Bitácora |

Para investigar una demora antes de iniciar un movimiento, espera a que termine la sincronización, deja el robot quieto y pulsa **Servomotores → Medir respuesta**. Ambos tiempos se cuentan desde el envío de `PING`: el acuse BLE confirma la escritura y la respuesta ESP32 confirma que el bucle del firmware procesó la orden. Si los dos son rápidos pero un servo empieza a moverse segundos después, revisa la velocidad configurada, la alimentación de servos y el bus I²C. Esta prueba requiere el firmware 2.7-BLE.

En **Demostración → Sujeción**, **Sujetar los 8** sirve para recuperar manualmente una sujeción interrumpida. Al conectar normalmente, la web ya aplica y confirma la postura de pie. El firmware no tiene sensores de posición física; las lecturas de ángulo son objetivos lógicos. El bloque **Caminata** usa las elevaciones guardadas; si aún no hay calibración, propone 10° por pata. El paso integrado comienza con 12° de avance y la velocidad inicial de la web es 90°/s (1,0 s por 90°).

Diferencias con el proyecto general:

- **Sin asistente IA.** Necesita un servidor con Ollama; la PWA funciona sin red.
- **Sin varios robots a la vez ni API key.** Bluetooth conecta un robot. Cada robot conserva su propio perfil y sus posturas, identificados por el navegador.
- **Fin de movimiento estimado.** El firmware informa un motor cada 100 ms durante una ronda rápida o cada 250 ms en reposo; cada motor vuelve a informarse tras unos 0,8–2 s. La página calcula el fin del movimiento con distancia y velocidad y corrige su modelo con cada estado recibido.

### Perfil del robot y arranque

- Valores calibrados: R1/L1 20–128°, R2/L2 30–128°, pies 0–180°, R3 y L4 invertidos. La velocidad inicial de la web es 90°/s; una velocidad guardada en el navegador conserva su valor. El rango de la web no puede superar esos límites.
- Sentido de avance por defecto, como `WALK_SWING` del servidor: R1 avanza al subir grados; R2, L1 y L2 al bajar. Los pies levantan al subir grados. El sentido se cambia en **Recorrido de avance por motor** y lo usan la marcha, los bloques, el probador y Sesame.
- Al conectar, si los ocho motores están libres (como tras un reinicio), la página envía `LIMIT`, `INVERT` y `SPEED`. Después aplica la postura de pie calibrada con `POSE_HOLD` y espera el estado de los ocho servos. Si se eligió inicio acostado automático, aplica esa postura en su lugar.
- Si algún motor ya está sujeto, solo envía `SPEED`, porque `LIMIT` e `INVERT` liberan el PWM. Si la sujeción es parcial y los motores sujetos ya están en la postura calibrada, completa automáticamente la sujeción. Si están en otra postura, usa **Recuperar postura guardada** cuando la araña esté apoyada.
- Al reconectar con los ocho motores sujetos, la web conserva el PWM. Si ya están en la postura de pie, muestra **Robot listo para rutinas**; si están en otra postura, indica **Recuperar postura guardada**. **Enviar perfil al robot** se usa cuando cambias rangos o inversión, no para resolver una reconexión.

### Caras

Las caras usan los parámetros de `faces.json` (ancho, alto, redondez, apertura, cejas, párpado inferior, mirada, parpadeo y mirada automáticos, y ajustes por ojo). Se envían completas con `FACE T= D= …`. Si los ajustes por ojo no caben en una escritura BLE (95 bytes), van en un segundo `FACE`.

### Movimientos Sesame

Las 15 poses (de pie, descansar, saludar, bailar, nadar, señalar, flexiones, reverencia, tierno, raro, gusano, sacudir, encogerse, hacerse el muerto y cangrejo) y los dos giros parten del robot abierto [Sesame](https://github.com/dorianborian/sesame-robot) de Dorian Todd (Apache-2.0), en concreto de su `firmware/movement-sequences.h`. **Descansar** usa la postura calibrada de este Spider (caderas a 90°, pies a 150°).

Sesame usa los mismos nombres de motor (R1/R2/L1/L2 cadera, R3/R4/L3/L4 pie), pero sus ángulos son absolutos para su mecánica. `sesame-moves.js` guarda los originales. La página convierte los cuadros de gestos y giros en desplazamientos respecto a la postura de apoyo, dentro del rango del perfil. **Adelante** y **Atrás** usan el paso de Mover patas: una pata se levanta y se coloca a la vez, las cuatro empujan al volver al centro, y Atrás invierte los cuatro giros de cadera. A 75% de amplitud usan 12° de avance; el ritmo ajusta la pausa entre fases. La velocidad inicial de Sesame es 90°/s. Cada movimiento muestra una cara aproximada a la de Sesame.

Durante la coreografía la velocidad de los servos es la de **Velocidad de servos**. Al terminar o detenerse se restaura la del perfil.

## Protocolo BLE

| Elemento | UUID | Uso |
| --- | --- | --- |
| Servicio | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0040` | Spider BLE |
| Comandos | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0041` | Escritura UTF-8 |
| Estado | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0042` | Lectura y notificaciones UTF-8 |

Comandos que usa la web: `MOVE R1 100`, `MIRROR 1 80`, `ALL 90`, `POSE …`, `STOP`, `RELEASE`, `ARM`, `STATUS`, `PING <id>`, y para el perfil y las caras `LIMIT`, `INVERT`, `SPEED` y `FACE`. El parser conserva además `EYES`, `POSE_HOLD` y `TEXT` del firmware original para uso por Serial. Una notificación `P,1,1,2.7-BLE` informa PCA9685 y OLED; `S,R1,90,100,1,1` informa ángulo actual, objetivo, habilitación y PWM. `A,<id>` responde al diagnóstico PING. Cada mensaje de estado cabe en 20 bytes.

## Alcance de la verificación

El sketch se compiló para ESP32-C6. La lógica de `robot-core.js` y la interfaz completa se probaron en Chrome sin interfaz con un robot BLE simulado: perfil al conectar, postura de apoyo, marcha, bloques, probador rápido, rutinas, caras, texto, postura acostada, Sesame y Detener. La conexión y el movimiento reales requieren la placa y el robot físico.
