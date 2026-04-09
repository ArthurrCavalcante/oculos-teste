/**
 * @file stereo_triangulation.cpp
 * @author Seu Nome (TCC)
 * @brief Lógica de Triangulação Estereoscópica para ESP32
 * 
 * Este código implementa a matemática de profundidade de forma eficiente
 * para ser executada no processador Xtensa do ESP32.
 */

#include <Arduino.h>

// Estrutura para armazenar os parâmetros da câmera
struct StereoConfig {
    float focalLength; // Distância focal em pixels
    float baseline;    // Distância entre as lentes em cm
};

// Função de Triangulação (A parte mais eficiente em C++)
float calculateDepth(float disparity, StereoConfig config) {
    // Se não há diferença entre as imagens, o objeto está no infinito ou erro
    if (disparity <= 0) {
        return -1.0f; 
    }

    // FÓRMULA FÍSICA: Z = (f * B) / d
    // f = focalLength
    // B = baseline
    // d = disparity
    float depth = (config.focalLength * config.baseline) / disparity;
    
    return depth;
}

// Exemplo de uso no loop do ESP32
void setup() {
    Serial.begin(115200);
}

void loop() {
    StereoConfig myCam = { 640.0f, 6.5f }; // Exemplo: f=640px, B=6.5cm
    float currentDisparity = 15.4f;        // Valor vindo do processamento de imagem
    
    float distance = calculateDepth(currentDisparity, myCam);
    
    Serial.print("Distancia calculada: ");
    Serial.print(distance);
    Serial.println(" cm");
    
    delay(1000);
}
