/**
 * @file stereoEngine.ts
 * @brief Motor de Triangulação Estereoscópica (Espelhamento do C++)
 * 
 * Esta lógica é idêntica à implementada no firmware do ESP32 para garantir
 * consistência entre o protótipo web e o hardware final.
 */

export interface StereoConfig {
  focalLength: number; // Distância focal em pixels
  baseline: number;    // Distância entre as lentes em metros
}

/**
 * Calcula a profundidade (Z) com base na disparidade.
 * Esta é a implementação de alto desempenho portada do C++.
 * 
 * @param disparity Diferença de pixels entre os centros dos objetos
 * @param config Configurações da câmera
 * @returns Distância em metros
 */
export const calculateDepth = (disparity: number, config: StereoConfig): number => {
  // Se não há diferença entre as imagens, o objeto está no infinito ou erro
  if (disparity <= 0) {
    return -1.0; 
  }

  // FÓRMULA FÍSICA: Z = (f * B) / d
  // f = focalLength (em pixels)
  // B = baseline (em metros)
  // d = disparity (em pixels)
  const depth = (config.focalLength * config.baseline) / disparity;
  
  return depth;
};
