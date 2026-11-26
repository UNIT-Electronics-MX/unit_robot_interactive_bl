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

Sustituye `/dev/ttyACM0` por el puerto de tu placa. El dispositivo se anuncia como **Spider-BLE**. Al iniciar, el firmware **libera los pulsos** de los servos; el valor lógico de 90° no mide su posición física. Calibra los límites y las posturas antes de mover todo el robot. El botón **Detener** detiene la trayectoria y mantiene el PWM activo; **Liberar servos** apaga los pulsos y deshabilita los motores hasta pulsar **Habilitar servos**. Si se pierde la conexión BLE, el firmware detiene las trayectorias en curso.

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
4. Espera a que la web indique **PCA9685 listo** y mueve un servo con un ángulo seguro.
5. Para instalarla, usa el botón **Instalar aplicación** si aparece o el menú del navegador **Añadir a pantalla de inicio**.

## Funciones de la página (equivalentes al proyecto general)

La PWA reproduce, sin servidor, las funciones del panel general (`app/` + `server/main.py`). Todo lo que describe al robot vive en la página y se guarda en el navegador: el perfil y las posturas por robot BLE, y las caras, rutinas y programas compartidos entre robots. El firmware solo ejecuta órdenes. `robot-core.js` traduce la lógica de `server/main.py`; `robot-profile.js` contiene los valores por defecto de `firmware/arana_api`, `server/faces.json` y `server/routines.json`.

| Pestaña | Qué hace | Equivale a |
| --- | --- | --- |
| Demostración | Caras de un toque, programas y rutinas guardados con su botón de ejecutar | Demostración |
| Servomotores | Mover cada servo, sujetar, liberar o activar; mover los 8, centrar, par en espejo; velocidad general por segundos para 90°; **Perfil del robot** (rango, inversión y velocidad) | Servomotores |
| Mover patas | Adelante/Atrás/Arriba/Abajo por pata; postura de apoyo (guardar, recuperar, automática); recorrido y sentido de avance de R1, R2, L1, L2; elevación por pata con prueba y confirmación visual; paso de caminata (1 o 3 ciclos); postura acostada al iniciar con `POSE_HOLD` | Mover patas |
| Bloques y rutinas | Programas de bloques (servo, mover pata, paso de pata, caminata, cara, esperar, volver al inicio, rutina o programa guardado) con 1–3 ciclos, comprobación de rango y conversión de cuatro pasos en caminata; probador rápido de secuencias; rutinas en JSON | Editar bloques |
| Caritas | Editor de caras con vista previa OLED 128×64, ajustes por ojo, transición y duración; texto en pantalla; pantalla de estado | Editar caritas |
| Sesame | 15 poses y 4 marchas del robot Sesame sobre la postura de apoyo | — |
| Bitácora | Últimas 300 órdenes enviadas con su origen | Bitácora |

Diferencias con el proyecto general:

- **Sin asistente IA.** Necesita un servidor con Ollama; la PWA funciona sin red.
- **Sin varios robots a la vez ni API key.** Bluetooth conecta un robot. Cada robot conserva su propio perfil y sus posturas, identificados por el navegador.
- **Fin de movimiento estimado.** El estado BLE llega cada 100–250 ms por motor, demasiado lento para esperar a que termine un movimiento. La página calcula ese fin con distancia y velocidad, como hace el firmware, y corrige su modelo con cada estado recibido.

### Perfil del robot y arranque

- Valores de fábrica: caderas 0–160°, pies 0–180°, R3 y L4 invertidos, 60 °/s. El rango nunca puede superar esos límites físicos.
- Sentido de avance por defecto, como `WALK_SWING` del servidor: R1 avanza al subir grados; R2, L1 y L2 al bajar. Los pies levantan al subir grados. El sentido se cambia en **Recorrido de avance por motor** y lo usan la marcha, los bloques, el probador y Sesame.
- Al conectar, si los ocho motores están libres (como tras un reinicio), la página envía `LIMIT`, `INVERT` y `SPEED`. Después recupera la postura elegida: acostada con `POSE_HOLD` o de apoyo con `POSE`. Son opciones excluyentes.
- Si algún motor ya está sujeto, solo envía `SPEED`, porque `LIMIT` e `INVERT` liberan el PWM y la araña caería. Aplica el resto con **Enviar perfil al robot**, que pide confirmación.

### Caras

Las caras usan los parámetros de `faces.json` (ancho, alto, redondez, apertura, cejas, párpado inferior, mirada, parpadeo y mirada automáticos, y ajustes por ojo). Se envían completas con `FACE T= D= …`. Si los ajustes por ojo no caben en una escritura BLE (95 bytes), van en un segundo `FACE`.

### Movimientos Sesame

Las 15 poses (de pie, descansar, saludar, bailar, nadar, señalar, flexiones, reverencia, tierno, raro, gusano, sacudir, encogerse, hacerse el muerto y cangrejo) y las 4 marchas (adelante, atrás y giros) vienen del robot abierto [Sesame](https://github.com/dorianborian/sesame-robot) de Dorian Todd (Apache-2.0), en concreto de su `firmware/movement-sequences.h`.

Sesame usa los mismos nombres de motor (R1/R2/L1/L2 cadera, R3/R4/L3/L4 pie), pero sus ángulos son absolutos para su mecánica. `sesame-moves.js` guarda los originales. La página convierte cada cuadro en cuánto avanza la cadera y cuánto se levanta el pie respecto a la postura de pie de Sesame. Lo multiplica por la **Amplitud**, lo orienta con el sentido de avance y lo suma a la postura de apoyo, sin salir del rango del perfil. Cada movimiento muestra una cara aproximada a la de Sesame.

Durante la coreografía la velocidad de los servos es la de **Velocidad de servos**. Al terminar o detenerse se restaura la del perfil.

## Protocolo BLE

| Elemento | UUID | Uso |
| --- | --- | --- |
| Servicio | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0040` | Spider BLE |
| Comandos | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0041` | Escritura UTF-8 |
| Estado | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0042` | Lectura y notificaciones UTF-8 |

Comandos que usa la web: `MOVE R1 100`, `MIRROR 1 80`, `ALL 90`, `POSE …`, `STOP`, `RELEASE`, `ARM`, `STATUS`, y para el perfil y las caras `LIMIT`, `INVERT`, `SPEED` y `FACE`. El parser conserva además `EYES`, `POSE_HOLD` y `TEXT` del firmware original para uso por Serial. Una notificación `P,1,1,2.6-BLE` informa PCA9685 y OLED; `S,R1,90,100,1,1` informa ángulo actual, objetivo, habilitación y PWM. Cada mensaje de estado cabe en 20 bytes.

## Alcance de la verificación

El sketch se compiló para ESP32-C6. La lógica de `robot-core.js` y la interfaz completa se probaron en Chrome sin interfaz con un robot BLE simulado: perfil al conectar, postura de apoyo, marcha, bloques, probador rápido, rutinas, caras, texto, postura acostada, Sesame y Detener. La conexión y el movimiento reales requieren la placa y el robot físico.
