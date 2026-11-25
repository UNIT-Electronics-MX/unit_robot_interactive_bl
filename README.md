# UNIT Spider · Control BLE

Aplicación web instalable para controlar la araña robótica por Bluetooth Low Energy. Incluye una variante autónoma del firmware original: ocho servos con PCA9685, ojos OLED, límites e inversión de motores. No necesita servidor, Wi-Fi, cuenta ni conexión a internet después de la primera carga de la PWA.

## Estructura

```text
unit_robot_interactive_bl/
├── docs/
│   ├── index.html              # entrada del sitio estático
│   ├── app.js                  # Web Bluetooth y controles
│   ├── robot-profile.js        # perfil del robot: rangos, inversión, velocidad, sentido y caras
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

## Perfil del robot (definido en la página)

Todo lo que describe al robot vive en la página, no en el firmware: rango mínimo y máximo, inversión, velocidad normal y sentido de cada motor, además de las caras de la OLED. Los valores por defecto están en `docs/robot-profile.js` y reproducen la tabla de fábrica del firmware (caderas 0–160°, pies 0–180°, R3 y L4 invertidos, 60 °/s). Se editan en el panel **Perfil del robot** y se guardan en el navegador.

- Al conectar, la página lee el estado. Si los ocho motores están libres, envía `LIMIT`, `INVERT` y `SPEED`. Si alguno está sujeto, solo envía `SPEED`, porque `LIMIT` e `INVERT` liberan el PWM en el firmware y la araña caería; aplica el resto con **Enviar perfil al robot** cuando esté apoyada (se pide confirmación).
- Los controles manuales, el movimiento de todos, los pares en espejo, la postura de apoyo y las coreografías se limitan al rango del perfil.
- La columna **Sentido** indica si subir grados avanza la cadera o levanta el pie (por defecto R1 y R2 avanzan al subir, L1 y L2 al bajar, y los pies levantan al subir).
- Las caras se definen como parámetros del comando `FACE` (tamaño, redondez, apertura, cejas, párpado y mirada) y se envían completas para no heredar valores anteriores. Si una cara no cabe en una escritura BLE (95 bytes), los ajustes de un solo ojo van en un segundo `FACE`.

## Movimientos Sesame

El panel **Movimientos Sesame** reproduce las 15 poses (de pie, descansar, saludar, bailar, nadar, señalar, flexiones, reverencia, tierno, raro, gusano, sacudir, encogerse, hacerse el muerto y cangrejo) y las 4 marchas (adelante, atrás y giros) del robot abierto [Sesame](https://github.com/dorianborian/sesame-robot) de Dorian Todd (Apache-2.0), tomadas de su `firmware/movement-sequences.h`.

Sesame usa los mismos nombres de motor que esta araña (R1/R2/L1/L2 giran la cadera, R3/R4/L3/L4 levantan el pie, con los pares R1-R3, R2-R4, L1-L3 y L2-L4), pero sus ángulos son absolutos para su propia mecánica. Por eso `sesame-moves.js` guarda los ángulos originales y la web los convierte en desplazamientos: cuánto avanza cada cadera y cuánto se levanta cada pie respecto a la postura de pie de Sesame. Ese desplazamiento, multiplicado por la **Amplitud** y orientado con el **Sentido** del perfil, se suma a la **postura de apoyo** y se limita al rango de cada motor. Cada cuadro se envía como un comando `POSE`; no hace falta reprogramar el ESP32. Cada movimiento muestra su propia cara, aproximada a la de Sesame con parámetros de `FACE`.

1. Revisa el perfil del robot y envíalo con la araña apoyada o los motores libres.
2. Coloca la araña de pie con los ocho motores sujetos (PWM activo) y pulsa **Guardar postura actual como apoyo**. Debe estar dentro del rango del perfil.
3. Empieza con una amplitud del 30–40 % y sujeta al robot la primera vez.

Durante la secuencia la web fija la velocidad de los ocho servos al valor de **Velocidad de servos** y, al terminar o interrumpirse, restaura la del perfil. **Detener** o una desconexión interrumpen la secuencia.

## Protocolo BLE

| Elemento | UUID | Uso |
| --- | --- | --- |
| Servicio | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0040` | Spider BLE |
| Comandos | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0041` | Escritura UTF-8 |
| Estado | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0042` | Lectura y notificaciones UTF-8 |

Comandos que usa la web: `MOVE R1 100`, `MIRROR 1 80`, `ALL 90`, `POSE …`, `STOP`, `RELEASE`, `ARM`, `STATUS`, y para el perfil y las caras `LIMIT`, `INVERT`, `SPEED` y `FACE`. El parser conserva además `EYES`, `POSE_HOLD` y `TEXT` del firmware original para uso por Serial. Una notificación `P,1,1,2.6-BLE` informa PCA9685 y OLED; `S,R1,90,100,1,1` informa ángulo actual, objetivo, habilitación y PWM. Cada mensaje de estado cabe en 20 bytes.

## Alcance de la verificación

El sketch se compiló para ESP32-C6 y los archivos web pasaron comprobaciones de sintaxis y referencias. La conexión y el movimiento reales requieren una placa y el robot físico.
