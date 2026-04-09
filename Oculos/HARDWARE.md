# Documentação de Hardware - VisionAssist Smart Glasses

Este documento descreve a montagem física e as conexões elétricas do protótipo, essencial para a defesa da disciplina de Microcontroladores e Microprocessadores.

## 1. Componentes Utilizados
- **Microcontrolador:** ESP32-CAM (AI-Thinker)
- **Câmera:** OV2640 (2 Megapixels)
- **Sensor de Distância:** HC-SR04 (Ultrassônico)
- **Alimentação:** Bateria LiPo 3.7V + Módulo Step-Up MT3608 (para 5V)
- **Interface de Programação:** Adaptador FTDI USB-to-TTL

## 2. Diagrama de Pinagem (Pinout)

| Componente | Pino Componente | Pino ESP32-CAM | Função |
| :--- | :--- | :--- | :--- |
| **HC-SR04** | VCC | 5V | Alimentação Positiva |
| **HC-SR04** | GND | GND | Terra |
| **HC-SR04** | TRIG | GPIO 15 | Gatilho (Trigger) |
| **HC-SR04** | ECHO | GPIO 14 | Eco (Echo) |
| **Câmera** | --- | Interno | Barramento de dados paralelo |
| **Sync Stereo** | SYNC | GPIO 12 | Sincronismo entre Master e Slave |

## 3. Esquema Elétrico e Conexões

### 3.1. Sensor Ultrassônico (HC-SR04)
O HC-SR04 opera em 5V. Como o ESP32-CAM opera em 3.3V nos seus pinos de I/O, é recomendado o uso de um **divisor de tensão** no pino ECHO para proteger o microcontrolador.

**Conexão do ECHO (GPIO 14):**
- Pino ECHO do Sensor -> Resistor 1kΩ -> GPIO 14
- GPIO 14 -> Resistor 2kΩ -> GND
*(Isso reduz os 5V do sinal de retorno para aproximadamente 3.3V)*

### 3.2. Sincronismo Hardware (Stereo)
Para garantir que ambas as câmeras capturem o frame no mesmo instante (essencial para objetos em movimento), conecte o **GPIO 12** da ESP32 Master ao **GPIO 12** da ESP32 Slave.
- **Master (Esquerda):** Envia pulso de trigger via hardware.
- **Slave (Direita):** Recebe pulso e dispara captura imediata via interrupção (ISR).

### 3.3. Programação (Modo Flash)
Para carregar o firmware (`.ino`), utilize o adaptador FTDI:
- **FTDI TX** -> **ESP32 RX (GPIO 3)**
- **FTDI RX** -> **ESP32 TX (GPIO 1)**
- **FTDI 5V** -> **ESP32 5V**
- **FTDI GND** -> **ESP32 GND**
- **IMPORTANTE:** Jumper **GPIO 0** ao **GND** para entrar em modo de gravação.

## 5. Lógica do Firmware (Explicação para a Banca)

O firmware utiliza a biblioteca `esp_camera.h` para gerenciar o acesso direto à memória **PSRAM**, permitindo o armazenamento de frames de alta resolução sem estourar a **SRAM** interna.

A leitura do sensor HC-SR04 é feita de forma síncrona durante a requisição HTTP, garantindo que o dado de distância enviado no header `X-Distance` seja exatamente o medido no momento da captura da imagem.

### Cálculo da Distância:
A distância é calculada baseada no tempo de vôo do som:
`Distância (cm) = (Tempo em microsegundos / 2) / 29.1`

## 5. Zonas de Perigo (Lógica de Software)
O sistema foi programado com três zonas concêntricas de segurança:
1. **Zona Crítica (< 1.0m):** Alerta tátil de alta frequência (metralhadora) e indicador visual vermelho pulsante.
2. **Zona de Alerta (1.0m - 2.0m):** Alerta tátil de frequência média e indicador visual laranja.
3. **Zona de Monitoramento (2.0m - 3.0m):** Alerta tátil de pulso único e indicador visual amarelo.
