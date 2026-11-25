# UNIT Spider · Control BLE

Aplicación web instalable para controlar la araña robótica por Bluetooth Low Energy. Incluye una variante autónoma del firmware original: ocho servos con PCA9685, ojos OLED, límites e inversión de motores. No necesita servidor, Wi-Fi, cuenta ni conexión a internet después de la primera carga de la PWA.

## Estructura

```text
unit_robot_interactive_bl/
├── docs/
│   ├── index.html              # entrada del sitio estático
│   ├── app.js                  # Web Bluetooth y controles
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

## Movimientos Sesame

El panel **Movimientos Sesame** reproduce las 15 poses (saludar, bailar, nadar, señalar, flexiones, reverencia, tierno, raro, gusano, sacudir, encogerse, hacerse el muerto, cangrejo, de pie y descansar) y las 4 marchas (adelante, atrás y giros) del robot abierto [Sesame](https://github.com/dorianborian/sesame-robot) de Dorian Todd (Apache-2.0), tomadas de su `firmware/movement-sequences.h`.

Sesame usa los mismos nombres de motor que esta araña (R1/R2/L1/L2 giran la cadera, R3/R4/L3/L4 levantan el pie, con los pares R1-R3, R2-R4, L1-L3 y L2-L4), pero sus ángulos son absolutos para su propia mecánica. Por eso `sesame-moves.js` guarda los ángulos originales y la web los convierte en desplazamientos: cuánto avanza cada cadera y cuánto se levanta cada pie respecto a la postura de pie de Sesame. Ese desplazamiento, multiplicado por la **Amplitud**, se suma a la **postura de apoyo** de tu araña y se limita al rango de cada servo. Cada cuadro se envía como un comando `POSE`; no hace falta reprogramar el ESP32.

1. Coloca la araña de pie con los ocho motores sujetos (PWM activo) y pulsa **Guardar postura actual como apoyo**. Queda guardada en el navegador.
2. Empieza con una amplitud del 30–40 % y sujeta al robot la primera vez.
3. Si un motor se mueve al revés, márcalo en **Invertir sentido de un motor**. Sentidos por defecto: R1 y R2 avanzan al subir grados, L1 y L2 al bajar, y R3–L4 levantan el pie al subir.

Durante la secuencia la web fija `SPEED` de los ocho servos al valor de **Velocidad de servos** y, al terminar o interrumpirse, lo devuelve a 60 °/s. Las expresiones de Sesame se aproximan con las de `EYES`. **Detener** o una desconexión interrumpen la secuencia.

## Protocolo BLE

| Elemento | UUID | Uso |
| --- | --- | --- |
| Servicio | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0040` | Spider BLE |
| Comandos | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0041` | Escritura UTF-8 |
| Estado | `e85a8d40-3d8f-4af8-9bb6-71bfc98e0042` | Lectura y notificaciones UTF-8 |

Comandos principales: `MOVE R1 100`, `MIRROR 1 80`, `ALL 90`, `STOP`, `RELEASE`, `ARM`, `STATUS`, `EYES HAPPY`. El parser conserva `SPEED`, `LIMIT`, `INVERT`, `POSE`, `POSE_HOLD`, `FACE` y `TEXT` del firmware original para futuras interfaces o uso por Serial. Una notificación `P,1,1,2.6-BLE` informa PCA9685 y OLED; `S,R1,90,100,1,1` informa ángulo actual, objetivo, habilitación y PWM. Cada mensaje de estado cabe en 20 bytes.

## Alcance de la verificación

El sketch se compiló para ESP32-C6 y los archivos web pasaron comprobaciones de sintaxis y referencias. La conexión y el movimiento reales requieren una placa y el robot físico.
