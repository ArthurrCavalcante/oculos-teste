/*
 * VisionAssist Smart Glasses - ESP32-CAM Firmware
 * -----------------------------------------------
 * Desenvolvido para a disciplina de Microcontroladores e Microprocessadores.
 * 
 * Funcionalidades:
 * 1. Inicializa a câmera OV2640 com suporte a PSRAM.
 * 2. Gerencia conexão Wi-Fi.
 * 3. Realiza a leitura do sensor ultrassônico HC-SR04.
 * 4. Serve imagens JPEG via HTTP no endpoint /capture.
 * 5. Injeta a distância lida no header HTTP 'X-Distance'.
 */

#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include "esp_timer.h"
#include "img_converters.h"
#include "Arduino.h"
#include <esp_task_wdt.h>
#include "mbedtls/base64.h"

// --- CONFIGURAÇÃO WI-FI ---
const char* ssid = "NOME_DA_REDE";
const char* password = "SENHA_DA_REDE";

// --- CONFIGURAÇÃO DE PAPEL (MASTER/SLAVE) ---
#define IS_MASTER true // Mude para false no segundo ESP32-CAM (Slave)

// --- PINAGEM ESP32-CAM (AI-THINKER) ---
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define FLASH_GPIO_NUM     4
#define STATUS_LED_GPIO_NUM 33

// --- PINAGEM ADICIONAL ---
#define BUZZER_PIN 13
#define SYNC_PIN 12 // Sincronismo Hardware (Master OUT / Slave IN)

// --- SERVIDOR WEB ---
#include "esp_http_server.h"
httpd_handle_t camera_httpd = NULL;

// Variáveis Globais
float current_distance = 0.0;
camera_fb_t * last_fb = NULL;
volatile bool sync_triggered = false;

// Função para codificar Base64
String base64_encode(const uint8_t *src, size_t len) {
  size_t out_len;
  mbedtls_base64_encode(NULL, 0, &out_len, src, len);
  unsigned char *out = (unsigned char *)malloc(out_len + 1);
  if (!out) return "";
  mbedtls_base64_encode(out, out_len, &out_len, src, len);
  out[out_len] = '\0';
  String res = String((char *)out);
  free(out);
  return res;
}

// Handler de Interrupção para o Slave
void IRAM_ATTR onSyncTrigger() {
  sync_triggered = true;
}

// Lógica de segurança (Buzzer)
void checkSafety() {
  // Buzzer pode ser usado para outros fins no futuro
}

// Handler para o endpoint /capture
esp_err_t capture_handler(httpd_req_t *req) {
  // Verifica se é uma requisição Stereo (Master Mode)
  char buf[256];
  if (httpd_req_get_url_query_str(req, buf, sizeof(buf)) == ESP_OK) {
    char stereo_val[10];
    char slave_url[128];
    if (httpd_query_key_value(buf, "stereo", stereo_val, sizeof(stereo_val)) == ESP_OK && String(stereo_val) == "true") {
      
      if (!IS_MASTER) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Este dispositivo não é Master");

      // 1. DISPARA SINCRONISMO HARDWARE
      digitalWrite(SYNC_PIN, HIGH);
      delayMicroseconds(10);
      digitalWrite(SYNC_PIN, LOW);

      // 2. CAPTURA LOCAL (MASTER)
      camera_fb_t * fb_master = esp_camera_fb_get();
      if (!fb_master) return httpd_resp_send_500(req);

      // 3. BUSCA IMAGEM DO SLAVE
      String slave_img_base64 = "";
      if (httpd_query_key_value(buf, "slave", slave_url, sizeof(slave_url)) == ESP_OK) {
        HTTPClient http;
        http.begin(String(slave_url) + "/last_sync_capture");
        int httpCode = http.GET();
        if (httpCode == HTTP_CODE_OK) {
          int len = http.getSize();
          uint8_t * s_buf = (uint8_t *)malloc(len);
          http.getStream().readBytes(s_buf, len);
          slave_img_base64 = base64_encode(s_buf, len);
          free(s_buf);
        }
        http.end();
      }

      // 4. MONTA RESPOSTA JSON
      String master_img_base64 = base64_encode(fb_master->buf, fb_master->len);
      
      String json = "{";
      json += "\"left\":\"" + master_img_base64 + "\",";
      json += "\"right\":\"" + slave_img_base64 + "\",";
      json += "\"distance\": 0.0";
      json += "}";

      esp_camera_fb_return(fb_master);
      
      httpd_resp_set_type(req, "application/json");
      httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
      return httpd_resp_send(req, json.c_str(), json.length());
    }
  }

  // Captura Normal (Single)
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) return httpd_resp_send_500(req);
  
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "X-Distance", "0.0");
  httpd_resp_set_hdr(req, "Access-Control-Expose-Headers", "X-Distance");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  
  esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

// Handler para o Slave retornar a última captura sincronizada
esp_err_t last_sync_capture_handler(httpd_req_t *req) {
  if (last_fb == NULL) return httpd_resp_send_404(req);
  
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, (const char *)last_fb->buf, last_fb->len);
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;

  httpd_uri_t capture_uri = { .uri = "/capture", .method = HTTP_GET, .handler = capture_handler, .user_ctx = NULL };
  httpd_uri_t last_sync_uri = { .uri = "/last_sync_capture", .method = HTTP_GET, .handler = last_sync_capture_handler, .user_ctx = NULL };

  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &last_sync_uri);
  }
}

void setup() {
  Serial.begin(115200);
  
  // Configuração de Sincronismo
  if (IS_MASTER) {
    pinMode(SYNC_PIN, OUTPUT);
    digitalWrite(SYNC_PIN, LOW);
  } else {
    pinMode(SYNC_PIN, INPUT_PULLDOWN);
    attachInterrupt(SYNC_PIN, onSyncTrigger, RISING);
  }

  pinMode(STATUS_LED_GPIO_NUM, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // Conexão Wi-Fi
  WiFi.begin(ssid, password);
  Serial.print("Conectando ao Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi conectado!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  // Configuração da Câmera
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if(psramFound()){
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Erro na inicialização da câmera: 0x%x", err);
    return;
  }
  
  startCameraServer();
}

// Função para garantir a conexão Wi-Fi
void maintainWiFi() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi desconectado! Tentando reconectar...");
    WiFi.disconnect();
    WiFi.begin(ssid, password);
    
    // Tenta reconectar por 10 segundos sem travar o loop principal por muito tempo
    unsigned long startAttempt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 10000) {
      delay(500);
      Serial.print(".");
    }
    
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\nReconectado!");
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
    }
  }
}

void loop() {
  if (sync_triggered) {
    sync_triggered = false;
    if (last_fb) esp_camera_fb_return(last_fb);
    last_fb = esp_camera_fb_get();
    Serial.println("Captura Sincronizada via Hardware!");
  }
  
  // Leitura periódica para segurança e manutenção de rede
  static unsigned long last_check = 0;
  if (millis() - last_check > 5000) { // Verifica Wi-Fi a cada 5 segundos
    maintainWiFi();
    last_check = millis();
  }

  static unsigned long last_read = 0;
  if (millis() - last_read > 200) {
    // checkSafety(); // Desativado sem sensor
    last_read = millis();
  }
}
