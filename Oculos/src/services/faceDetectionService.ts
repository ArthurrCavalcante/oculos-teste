import * as vision from "@mediapipe/tasks-vision";
import { RecognitionResult, PersonResult } from "./visionService";

// @ts-ignore - ObjectDetector is exported but TS has trouble resolving it from the bundle
const ObjectDetector = (vision as any).ObjectDetector;
// @ts-ignore
const FaceDetector = (vision as any).FaceDetector;
// @ts-ignore
const FilesetResolver = (vision as any).FilesetResolver;

let faceDetector: any | null = null;
let personDetector: any | null = null;

// Função para melhorar a imagem em condições de baixa iluminação
const enhanceImageForDetection = (imageElement: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return imageElement as any;

  const width = imageElement instanceof HTMLImageElement ? imageElement.naturalWidth : imageElement.width;
  const height = imageElement instanceof HTMLImageElement ? imageElement.naturalHeight : imageElement.height;
  
  canvas.width = width;
  canvas.height = height;

  // Aplica filtros de brilho e contraste para ajudar o detector em sombras/ângulos difíceis
  // Otimizado para não estourar brancos em luz solar forte
  // Aumentamos um pouco mais o contraste para destacar traços faciais
  ctx.filter = 'brightness(1.15) contrast(1.2) saturate(1.1)';
  ctx.drawImage(imageElement, 0, 0);
  
  return canvas;
};

export const initFaceDetector = async () => {
  if (faceDetector) return faceDetector;

  try {
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
    );
    faceDetector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`,
        delegate: "GPU"
      },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.3, // Reduzido de 0.35 para capturar faces em ângulos difíceis
      minSuppressionThreshold: 0.3
    });
    return faceDetector;
  } catch (error) {
    console.error("Falha ao iniciar detector de faces:", error);
    return null;
  }
};

export const initPersonDetector = async () => {
  if (personDetector) return personDetector;

  try {
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
    );
    // Usando EfficientDet-Lite0 para detecção robusta de pessoas (corpo inteiro)
    personDetector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
        delegate: "GPU"
      },
      runningMode: "IMAGE",
      scoreThreshold: 0.35, // Reduzido de 0.4 para melhor detecção em baixa luz
      maxResults: 5,
      categoryAllowlist: ["person"]
    });
    return personDetector;
  } catch (error) {
    console.error("Falha ao iniciar detector de pessoas:", error);
    return null;
  }
};

export interface FaceGeometry {
  faceWidthNormalized: number;
  faceHeightNormalized: number;
  interocularDistanceNormalized: number | null;
}

export const measureFaceGeometry = async (imageElement: HTMLImageElement | HTMLCanvasElement): Promise<FaceGeometry | null> => {
  if (!faceDetector) {
    await initFaceDetector();
  }
  
  if (!faceDetector) return null;

  try {
    // Usa imagem original para geometria para manter precisão
    const results = faceDetector.detect(imageElement);
    if (results.detections.length > 0) {
      const detection = results.detections[0];
      const boundingBox = detection.boundingBox;
      const keypoints = detection.keypoints;
      
      const imageWidth = imageElement instanceof HTMLImageElement ? imageElement.naturalWidth : imageElement.width;
      const imageHeight = imageElement instanceof HTMLImageElement ? imageElement.naturalHeight : imageElement.height;

      const faceWidthNormalized = boundingBox ? boundingBox.width / imageWidth : 0;
      const faceHeightNormalized = boundingBox ? boundingBox.height / imageHeight : 0;

      let interocularDistanceNormalized = null;
      if (keypoints && keypoints.length >= 2) {
        // Ponto 0: Olho Direito, Ponto 1: Olho Esquerdo
        const rightEye = keypoints[0];
        const leftEye = keypoints[1];
        
        const dx = (rightEye.x - leftEye.x) * imageWidth;
        const dy = (rightEye.y - leftEye.y) * imageHeight;
        const pixelDist = Math.sqrt(dx * dx + dy * dy);
        interocularDistanceNormalized = pixelDist / imageWidth;
      }

      return {
        faceWidthNormalized,
        faceHeightNormalized,
        interocularDistanceNormalized
      };
    }
    return null;
  } catch (error) {
    console.error("Erro na geometria facial:", error);
    return null;
  }
};

export const cropFace = async (imageElement: HTMLImageElement | HTMLCanvasElement): Promise<string | null> => {
  if (!faceDetector) {
    await initFaceDetector();
  }
  
  if (!faceDetector) return null;

  try {
    // Melhora imagem antes de tentar detectar para o recorte
    const enhanced = enhanceImageForDetection(imageElement);
    const results = faceDetector.detect(enhanced);
    
    if (results.detections.length > 0) {
      const detection = results.detections[0];
      const box = detection.boundingBox;
      
      if (!box) return null;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Margem de 20% ao redor do rosto
      const margin = 0.2;
      const mWidth = box.width * margin;
      const mHeight = box.height * margin;

      const sourceX = Math.max(0, box.originX - mWidth);
      const sourceY = Math.max(0, box.originY - mHeight);
      const sourceWidth = Math.min(
        (imageElement instanceof HTMLImageElement ? imageElement.naturalWidth : imageElement.width) - sourceX,
        box.width + (mWidth * 2)
      );
      const sourceHeight = Math.min(
        (imageElement instanceof HTMLImageElement ? imageElement.naturalHeight : imageElement.height) - sourceY,
        box.height + (mHeight * 2)
      );

      canvas.width = 224; 
      canvas.height = 224;

      ctx.drawImage(
        imageElement, // Usa original para o recorte final para manter qualidade
        sourceX, sourceY, sourceWidth, sourceHeight,
        0, 0, 224, 224
      );

      return canvas.toDataURL('image/jpeg', 0.8);
    }
    return null;
  } catch (error) {
    console.error("Erro no recorte facial:", error);
    return null;
  }
};

export const detectFaceLocal = async (imageElement: HTMLImageElement | HTMLCanvasElement): Promise<RecognitionResult | null> => {
  if (!faceDetector) await initFaceDetector();
  if (!personDetector) await initPersonDetector();
  
  if (!faceDetector && !personDetector) return null;

  try {
    const enhanced = enhanceImageForDetection(imageElement);
    const imageWidth = imageElement instanceof HTMLImageElement ? imageElement.naturalWidth : imageElement.width;
    
    let people: PersonResult[] = [];

    // 1. Tenta detecção de faces (mais precisa para identificação)
    if (faceDetector) {
      const faceResults = faceDetector.detect(enhanced);
      faceResults.detections.forEach(detection => {
        const boundingBox = detection.boundingBox;
        const faceWidthNormalized = boundingBox ? boundingBox.width / imageWidth : 0.2;
        
        people.push({
          personDetected: true,
          isKnown: false,
          description: "Pessoa detectada (rosto visível).",
          confidence: detection.categories[0]?.score || 0.8,
          faceWidthNormalized: faceWidthNormalized,
          detectionSource: 'face'
        });
      });
    }

    // 2. Se poucas faces, tenta detecção de corpo inteiro (mais robusta para ângulos/luz)
    if (people.length === 0 && personDetector) {
      const personResults = personDetector.detect(enhanced);
      personResults.detections.forEach(detection => {
        const boundingBox = detection.boundingBox;
        // Para corpo inteiro, a largura é maior, então ajustamos a heurística de distância
        // Usamos 40% da largura do corpo como equivalente à largura do rosto para a fórmula de distância
        const personWidthNormalized = boundingBox ? (boundingBox.width * 0.4) / imageWidth : 0.2;

        people.push({
          personDetected: true,
          isKnown: false,
          description: "Pessoa detectada (corpo inteiro).",
          confidence: detection.categories[0]?.score || 0.6,
          faceWidthNormalized: personWidthNormalized,
          detectionSource: 'object'
        });
      });
    }

    if (people.length > 0) {
      const firstPerson = people[0];
      return {
        people,
        personDetected: true,
        isKnown: false,
        description: firstPerson.description,
        confidence: firstPerson.confidence,
        faceWidthNormalized: firstPerson.faceWidthNormalized
      };
    }
    
    return { 
      people: [],
      personDetected: false,
      isKnown: false,
      description: "Nenhuma pessoa detectada localmente.",
      confidence: 0
    };
  } catch (error) {
    console.error("Erro na detecção local:", error);
    return null;
  }
};
