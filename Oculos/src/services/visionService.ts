import { GoogleGenAI } from "@google/genai";

export interface PersonResult {
  personDetected: boolean;
  isKnown: boolean;
  name?: string;
  description: string;
  confidence: number;
  distance?: number;
  faceWidthNormalized?: number;
  detectionSource?: 'face' | 'object';
  distanceSource?: 'hardware' | 'geometric' | 'ai' | 'stereo';
}

export interface RecognitionResult {
  people: PersonResult[];
  timestamp?: number;
  // Top-level properties for backward compatibility (referring to the first person)
  personDetected: boolean;
  isKnown: boolean;
  name?: string;
  description: string;
  confidence: number;
  distance?: number;
  faceWidthNormalized?: number;
}

export async function recognizeFace(
  base64Image: string, 
  knownPeople: { name: string, description: string, photos?: string[] }[],
  signal?: AbortSignal
): Promise<RecognitionResult> {
  try {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY não configurada. Verifique as configurações do projeto.");
    }

    const ai = new GoogleGenAI({ apiKey });
    
    // Construindo o prompt com as fotos de referência
    const contents: any[] = [];
    
    // 1. Instrução do Sistema
    let promptText = `Analise esta imagem de uma câmera assistiva para cegos e identifique as pessoas presentes.
    
    RECONHECIMENTO BIOMÉTRICO: Foque em características faciais permanentes:
    - Formato do rosto e mandíbula.
    - Distância entre os olhos e formato das sobrancelhas.
    - Formato do nariz e orelhas.
    
    IGNORE:
    - Roupas, acessórios, cor de cabelo e barba.
    - Iluminação e ângulo.
    
    Fotos de referência:
    `;

    knownPeople.forEach((person: any) => {
      if (person.photos && Array.isArray(person.photos)) {
        promptText += `\n- Pessoa: ${person.name} (${person.description})`;
        // Limita a 2 fotos para reduzir latência
        const photosToProcess = person.photos.slice(0, 2);
        photosToProcess.forEach((photo: string, pIdx: number) => {
          promptText += ` [Referência ${pIdx + 1}]`;
          contents.push({
            inlineData: {
              mimeType: "image/jpeg",
              data: photo.split(',')[1]
            }
          });
        });
      }
    });

    promptText += `\n\nAnalise a IMAGEM ATUAL e identifique se as pessoas correspondem biometricamente às referências.
    
    Responda em JSON:
    {
      "people": [
        {
          "personDetected": boolean,
          "isKnown": boolean,
          "name": string,
          "description": string (descrição curta em português),
          "confidence": number (0-1),
          "distance": number (metros),
          "faceWidthNormalized": number (largura do rosto / largura da imagem)
        }
      ]
    }`;

    // 2. Adicionar o texto do prompt
    contents.unshift({ text: promptText });

    // 3. Adicionar a imagem atual
    contents.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image.split(',')[1]
      }
    });

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: contents,
      config: {
        responseMimeType: "application/json"
      }
    });

    const data = JSON.parse(response.text || "{}");
    
    // Suporte para formato antigo e novo
    const people: PersonResult[] = data.people || (data.personDetected ? [data] : []);
    
    const firstPerson = people[0] || {
      personDetected: false,
      isKnown: false,
      description: "Nenhuma pessoa detectada.",
      confidence: 0
    };

    return {
      people,
      personDetected: firstPerson.personDetected,
      isKnown: firstPerson.isKnown,
      name: firstPerson.name,
      description: firstPerson.description,
      confidence: firstPerson.confidence,
      distance: firstPerson.distance,
      faceWidthNormalized: firstPerson.faceWidthNormalized
    };
  } catch (error: any) {
    console.error("Erro no Reconhecimento:", error);
    throw error;
  }
}
