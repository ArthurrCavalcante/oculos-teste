import React, { useState, useEffect, useRef } from 'react';
import { Camera, User, AlertTriangle, Settings, History, MapPin, Scan, RefreshCw, X, LogIn, LogOut, Plus, Check, Upload, Image as ImageIcon, Trash2, Wifi, Globe, ShieldCheck, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { recognizeFace, RecognitionResult, PersonResult } from './services/visionService';
import { detectFaceLocal, initFaceDetector, initPersonDetector, measureFaceGeometry, FaceGeometry, cropFace } from './services/faceDetectionService';
import { calculateDepth } from './lib/stereoEngine';

export default function App() {
  const [isScanning, setIsScanning] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraSource, setCameraSource] = useState<'local' | 'remote' | 'stereo'>('stereo');
  const [remoteUrl, setRemoteUrl] = useState('http://192.168.1.100/capture');
  const [remoteUrlRight, setRemoteUrlRight] = useState('http://192.168.1.101/capture');
  const [baseline, setBaseline] = useState<number>(() => {
    const saved = localStorage.getItem('baseline');
    return saved ? parseFloat(saved) : 65; // Default 65mm (average human IPD)
  });
  const [syncCompensation, setSyncCompensation] = useState<number>(() => {
    const saved = localStorage.getItem('syncCompensation');
    return saved ? parseFloat(saved) : 0.0; // Default 0 pixels compensation
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [proximityThreshold, setProximityThreshold] = useState(2.0); // Default 2 meters
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [speechRate, setSpeechRate] = useState(1.5); // Default faster rate as requested
  const [focalLength, setFocalLength] = useState<number>(() => {
    const saved = localStorage.getItem('focalLength');
    return saved ? parseFloat(saved) : 0.9;
  });
  const [eyeFocalLength, setEyeFocalLength] = useState<number>(() => {
    const saved = localStorage.getItem('eyeFocalLength');
    return saved ? parseFloat(saved) : 0.9;
  });

  // Persistência da calibração
  useEffect(() => {
    localStorage.setItem('focalLength', focalLength.toString());
  }, [focalLength]);

  useEffect(() => {
    localStorage.setItem('eyeFocalLength', eyeFocalLength.toString());
  }, [eyeFocalLength]);

  useEffect(() => {
    localStorage.setItem('baseline', baseline.toString());
  }, [baseline]);

  useEffect(() => {
    localStorage.setItem('syncCompensation', syncCompensation.toString());
  }, [syncCompensation]);

  const [lastResult, setLastResult] = useState<RecognitionResult | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [distanceSource, setDistanceSource] = useState<'hardware' | 'geometric' | 'ai' | 'stereo' | null>(null);
  const [movementTrend, setMovementTrend] = useState<'approaching' | 'receding' | 'stationary' | null>(null);
  const prevDistanceRef = useRef<number | null>(null);
  const smoothedDistRef = useRef<number | null>(null);
  const SMOOTHING_ALPHA = 0.35; // Fator de suavização exponencial
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState(false);
  const [latency, setLatency] = useState<{ capture: number, api: number, total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [knownPeople] = useState<any[]>([]); // Mantido vazio por enquanto
  const lastSpokenRef = useRef<string>('');
  const lastSpokenTimeRef = useRef<number>(0);
  const lastVibrationTimeRef = useRef<number>(0);
  const isSpeakingRef = useRef<boolean>(false);
  const speechQueueRef = useRef<{text: string, priority: 'high' | 'normal'}[]>([]);
  const isProcessingQueueRef = useRef<boolean>(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Inicialização
  useEffect(() => {
    initFaceDetector();
    initPersonDetector();
  }, []);

  // Ligar/Desligar Câmera
  useEffect(() => {
    if (isScanning && cameraSource === 'local') {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        })
        .catch(err => {
          console.error("Erro na Câmera:", err);
          setError("Não foi possível acessar a câmera local. Verifique as permissões.");
          setIsScanning(false);
        });
    } else {
      const stream = videoRef.current?.srcObject as MediaStream;
      stream?.getTracks().forEach(track => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      setIsLiveMode(false);
      lastSpokenRef.current = '';
    }
  }, [isScanning, cameraSource]);

  // Monitoramento Contínuo (Modo Live)
  const liveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    if (isLiveMode && isScanning) {
      const loop = async () => {
        if (!isLiveMode || !isScanning) return;
        await handleCaptureAndRecognize();
        if (isLiveMode && isScanning) {
          liveTimeoutRef.current = setTimeout(loop, 2000); // Intervalo de 2s
        }
      };
      loop();
    } else {
      if (liveTimeoutRef.current) clearTimeout(liveTimeoutRef.current);
      lastSpokenRef.current = '';
    }
    return () => {
      if (liveTimeoutRef.current) clearTimeout(liveTimeoutRef.current);
    };
  }, [isLiveMode, isScanning]);

  const captureImage = async (): Promise<{ base64: string, base64Right?: string }> => {
    let base64Image = '';
    let base64Right = '';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s para câmeras remotas

    if (cameraSource === 'local') {
      if (!videoRef.current || !canvasRef.current) throw new Error("Câmera não inicializada.");
      const canvas = canvasRef.current;
      const video = videoRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(video, 0, 0);
      base64Image = canvas.toDataURL('image/jpeg', 0.7);
      clearTimeout(timeoutId);
    } else if (cameraSource === 'remote') {
      // Captura Remota ESP32-CAM
      try {
        const response = await fetch(remoteUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        const blob = await response.blob();
        base64Image = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error("Erro ao conectar com a ESP32-CAM. Verifique o IP.");
      }
    } else if (cameraSource === 'stereo') {
      // Captura Stereo Sincronizada por Hardware
      try {
        const response = await fetch(`${remoteUrl}?stereo=true&slave=${encodeURIComponent(remoteUrlRight)}`, { 
          signal: controller.signal 
        });
        clearTimeout(timeoutId);

        const data = await response.json();
        if (data.left && data.right) {
          base64Image = `data:image/jpeg;base64,${data.left}`;
          base64Right = `data:image/jpeg;base64,${data.right}`;
        } else {
          throw new Error("Resposta stereo inválida.");
        }
      } catch (e: any) {
        clearTimeout(timeoutId);
        console.warn("Sincronização de hardware falhou, usando software:", e);
        
        // Fallback para sincronização por software
        try {
          const controllerFallback = new AbortController();
          const timeoutFallback = setTimeout(() => controllerFallback.abort(), 15000);
          
          const [resL, resR] = await Promise.all([
            fetch(remoteUrl, { signal: controllerFallback.signal }),
            fetch(remoteUrlRight, { signal: controllerFallback.signal })
          ]);
          clearTimeout(timeoutFallback);

          const [blobL, blobR] = await Promise.all([resL.blob(), resR.blob()]);
          const toBase64 = (blob: Blob): Promise<string> => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          [base64Image, base64Right] = await Promise.all([toBase64(blobL), toBase64(blobR)]);
        } catch (fallbackErr) {
          throw new Error("Erro ao conectar com o par de câmeras Stereo.");
        }
      }
    }
    return { base64: base64Image, base64Right };
  };

  const handleCaptureAndRecognize = async () => {
    const startTime = performance.now();
    setIsProcessing(true);
    setError(null);
    setIsOfflineMode(false);
    setDistanceSource(null);

    try {
      const captureStart = performance.now();
      const { base64: rawBase64, base64Right } = await captureImage();
      const captureEnd = performance.now();
      
      // Processar Imagem Esquerda (Principal)
      let base64Image = rawBase64;
      let faceGeometry: FaceGeometry | null = null;
      
      if (canvasRef.current) {
        const img = new Image();
        img.src = rawBase64;
        await new Promise(r => img.onload = r);
        
        const canvas = canvasRef.current;
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
        
        const cropped = await cropFace(canvas);
        if (cropped) base64Image = cropped;
        faceGeometry = await measureFaceGeometry(canvas);
      }

      // Cálculo Stereo
      let stereoDistance: number | null = null;
      if (cameraSource === 'stereo' && base64Right && canvasRef.current) {
        try {
          const imgR = new Image();
          imgR.src = base64Right;
          await new Promise(r => imgR.onload = r);
          
          const canvasR = document.createElement('canvas');
          canvasR.width = imgR.width;
          canvasR.height = imgR.height;
          const ctxR = canvasR.getContext('2d');
          ctxR?.drawImage(imgR, 0, 0);
          
          const resultsL = await initFaceDetector().then(fd => fd?.detect(canvasRef.current!));
          const resultsR = await initFaceDetector().then(fd => fd?.detect(canvasR));
          
          if (resultsL?.detections.length && resultsR?.detections.length) {
            const boxL = resultsL.detections[0].boundingBox!;
            const boxR = resultsR.detections[0].boundingBox!;
            
            const xL = boxL.originX + boxL.width / 2;
            const xR = boxR.originX + boxR.width / 2;
            
            // Fórmula: d = (B * f) / (P + compensação)
            const rawParallax = Math.abs(xL - xR);
            
            let correctedParallax = rawParallax;
            if (movementTrend === 'approaching') {
              correctedParallax -= syncCompensation;
            } else if (movementTrend === 'receding') {
              correctedParallax += syncCompensation;
            }

            if (correctedParallax > 0) {
              const f_pixels = focalLength * canvasRef.current.width;
              // Usando o motor de triangulação (Portado do C++)
              stereoDistance = calculateDepth(correctedParallax, {
                focalLength: f_pixels,
                baseline: baseline / 1000 // Converter mm para metros
              });
              console.log("Distância Stereo (C++ Engine):", stereoDistance);
            }
          }
        } catch (e) {
          console.error("Cálculo stereo falhou:", e);
        }
      }

      let result: RecognitionResult;
      let isFallback = false;
      let apiTime = 0;

      try {
        // Se a cota já foi excedida, pula a API para evitar erros repetitivos
        if (isQuotaExceeded) {
          throw new Error("QUOTA_EXHAUSTED");
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s para redes lentas

        const apiStart = performance.now();
        result = await recognizeFace(base64Image, knownPeople, controller.signal);
        apiTime = Math.round(performance.now() - apiStart);
        clearTimeout(timeoutId);
      } catch (apiError: any) {
        const errorStr = apiError.message || String(apiError);
        const isQuotaError = errorStr.includes("429") || errorStr.includes("RESOURCE_EXHAUSTED") || errorStr.includes("QUOTA_EXHAUSTED");

        if (isQuotaError) {
          setIsQuotaExceeded(true);
          setIsOfflineMode(true);
          console.warn("Cota da API Gemini excedida. Usando processamento local.");
          
          // Avisar o usuário apenas uma vez sobre a cota
          if (!isQuotaExceeded) {
            speak("Cota de nuvem excedida. Mudando para modo de economia local.", 'normal');
          }
        } else if (apiError.name === 'AbortError') {
          console.error("Timeout da API Gemini");
        } else {
          console.warn("API Gemini falhou, usando detecção local:", apiError);
        }

        isFallback = true;
        setIsOfflineMode(true);
        
        // Fallback para detecção local MediaPipe
        if (!canvasRef.current) throw apiError;
        const localResult = await detectFaceLocal(canvasRef.current);
        
        if (!localResult) throw apiError; 
        result = localResult;
      }

      const totalTime = Math.round(performance.now() - startTime);
      setLatency({
        capture: Math.round(captureEnd - captureStart),
        api: apiTime,
        total: totalTime
      });

      if (result.personDetected && result.people.length > 0) {
        // Calcular distâncias para todas as pessoas detectadas
        const processedPeople = result.people.map((person, index) => {
          let personDistance = person.distance;
          let personSource: 'geometric' | 'ai' | 'stereo' = 'ai';

          // 1. Prioridade: Distância Stereo (Triangulação)
          if (index === 0 && stereoDistance !== null && stereoDistance > 0) {
            personDistance = stereoDistance;
            personSource = 'stereo';
          }
          // 2. Secundário: Cálculo Geométrico (Apenas se Stereo falhar)
          else {
            const width = (index === 0 ? faceGeometry?.faceWidthNormalized : null) || person.faceWidthNormalized;
            const eyeWidth = index === 0 ? faceGeometry?.interocularDistanceNormalized : null;

            if (width || eyeWidth) {
              const distFromFace = width ? (0.16 * focalLength) / width : Infinity;
              const distFromEyes = eyeWidth ? (0.063 * eyeFocalLength) / eyeWidth : Infinity;
              
              if (distFromFace !== Infinity && distFromEyes !== Infinity) {
                personDistance = parseFloat(((distFromFace * 0.6) + (distFromEyes * 0.4)).toFixed(1));
              } else {
                personDistance = parseFloat((Math.min(distFromFace, distFromEyes)).toFixed(1));
              }
              personSource = 'geometric';
            }
          }

          return { ...person, calculatedDistance: personDistance, distanceSource: personSource };
        });

        // Pessoa principal
        const mainPerson = processedPeople[0];

        setLastResult({ 
          ...result, 
          people: processedPeople, 
          timestamp: Date.now() 
        });

        let finalDistance = mainPerson.calculatedDistance;
        let source = mainPerson.distanceSource;
        let filteredDistance: number | null = null;
        let currentTrend: 'approaching' | 'receding' | 'stationary' | null = null;

        if (finalDistance) {
          // Filtro de Suavização Exponencial
          if (smoothedDistRef.current === null) {
            smoothedDistRef.current = finalDistance;
          } else {
            smoothedDistRef.current = (SMOOTHING_ALPHA * finalDistance) + ((1 - SMOOTHING_ALPHA) * smoothedDistRef.current);
          }
          
          filteredDistance = parseFloat(smoothedDistRef.current.toFixed(1));

          // Memória Espacial: Detectar tendência de movimento
          if (prevDistanceRef.current !== null) {
            const diff = filteredDistance - prevDistanceRef.current;
            if (diff < -0.2) {
              currentTrend = 'approaching';
            } else if (diff > 0.2) {
              currentTrend = 'receding';
            } else {
              currentTrend = 'stationary';
            }
            setMovementTrend(currentTrend);
          }
          prevDistanceRef.current = filteredDistance;

          setDistance(filteredDistance);
          setDistanceSource(source);
        } else {
          setDistance(null);
          setDistanceSource(null);
          setMovementTrend(null);
          prevDistanceRef.current = null;
          smoothedDistRef.current = null;
        }

        // Feedback de Voz
        const now = Date.now();
        const timeSinceLastSpeech = now - lastSpokenTimeRef.current;
        
        let aggregatedText = "";
        if (processedPeople.length > 1) {
          aggregatedText = `Detectadas ${processedPeople.length} pessoas. `;
        }

        const effectiveTrend = currentTrend || movementTrend;

        processedPeople.forEach((p, idx) => {
          const movementText = (idx === 0 && effectiveTrend === 'approaching') ? 'se aproximando' : 
                              (idx === 0 && effectiveTrend === 'receding') ? 'se afastando' : '';
          
          const sourceText = p.detectionSource === 'face' ? 'rosto' : 'corpo';
          
          const personText = p.isKnown 
            ? `${p.name}. ${p.calculatedDistance || '---'} metros. ${movementText}`
            : (isFallback 
                ? `Pessoa ${idx + 1} (${sourceText}). ${p.calculatedDistance || '---'} metros. ${movementText}`
                : `Desconhecido. ${p.description}. ${p.calculatedDistance || '---'} metros. ${movementText}`);
          
          aggregatedText += personText + " ";
        });

        // Lógica de Vibração
        if (mainPerson.isKnown) {
          if (lastSpokenRef.current !== mainPerson.name || timeSinceLastSpeech > 30000) {
            triggerVibration('known');
          }
        } else if (finalDistance && finalDistance <= proximityThreshold) {
          if (now - lastVibrationTimeRef.current > 3000) {
            triggerVibration('unknown', finalDistance);
            lastVibrationTimeRef.current = now;
          }
        }

        const priority = (finalDistance && finalDistance < 1.0) ? 'high' : 'normal';

        const mainPersonId = mainPerson.isKnown ? mainPerson.name : (isFallback ? 'local_person' : 'unknown');
        if (!isLiveMode || lastSpokenRef.current !== mainPersonId || timeSinceLastSpeech > 30000) {
          speak(aggregatedText.trim(), priority);
          lastSpokenRef.current = mainPersonId || '';
          lastSpokenTimeRef.current = now;
        }
      } else {
        setLastResult({ ...result, timestamp: Date.now() });
        setDistance(null);
        setDistanceSource(null);
        setMovementTrend(null);
        prevDistanceRef.current = null;
        lastSpokenRef.current = ''; 
        if (isLiveMode) triggerVibration('clear');
      }

    } catch (err: any) {
      const errorStr = err.message || String(err);
      if (errorStr.includes("429") || errorStr.includes("RESOURCE_EXHAUSTED") || errorStr.includes("QUOTA_EXHAUSTED")) {
        setError("Cota da API Gemini excedida. O sistema está operando em modo local.");
      } else {
        setError(err.message || "Erro ao processar imagem.");
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const calibrateStereo = async () => {
    if (cameraSource !== 'stereo') {
      setError("Mude para o modo Stereo antes de calibrar.");
      return;
    }
    
    setIsProcessing(true);
    try {
      const { base64: base64L, base64Right: base64R } = await captureImage();
      if (!base64L || !base64R || !canvasRef.current) throw new Error("Falha na captura stereo.");

      const imgL = new Image();
      imgL.src = base64L;
      await new Promise(r => imgL.onload = r);
      
      const imgR = new Image();
      imgR.src = base64R;
      await new Promise(r => imgR.onload = r);

      const canvasR = document.createElement('canvas');
      canvasR.width = imgR.width;
      canvasR.height = imgR.height;
      const ctxR = canvasR.getContext('2d');
      ctxR?.drawImage(imgR, 0, 0);

      const resultsL = await initFaceDetector().then(fd => fd?.detect(canvasRef.current!));
      const resultsR = await initFaceDetector().then(fd => fd?.detect(canvasR));

      if (resultsL?.detections.length && resultsR?.detections.length) {
        const boxL = resultsL.detections[0].boundingBox!;
        const boxR = resultsR.detections[0].boundingBox!;
        
        const xL = boxL.originX + boxL.width / 2;
        const xR = boxR.originX + boxR.width / 2;
        
        const parallax = Math.abs(xL - xR);
        const baselineMeters = baseline / 1000;
        const calculatedFocalPixels = parallax / baselineMeters;
        const normalizedFocal = calculatedFocalPixels / canvasRef.current.width;
        
        setFocalLength(parseFloat(normalizedFocal.toFixed(4)));
        speak("Calibração stereo a um metro concluída.");
      } else {
        throw new Error("Rosto não detectado em ambas as câmeras.");
      }
    } catch (e: any) {
      setError(e.message);
      speak("Falha na calibração stereo.");
    } finally {
      setIsProcessing(false);
    }
  };

  const triggerVibration = (type: 'known' | 'unknown' | 'clear', dist?: number) => {
    if (!vibrationEnabled || !('vibrate' in navigator)) return;

    if (type === 'known') {
      navigator.vibrate([500, 200, 500]);
    } else if (type === 'unknown') {
      if (dist && dist < 1.0) {
        // ZONA CRÍTICA
        navigator.vibrate([100, 50, 100, 50, 100, 50, 100]);
      } else if (dist && dist < 2.0) {
        // ZONA DE ALERTA
        navigator.vibrate([200, 200, 200, 200]);
      } else {
        // ZONA DE MONITORAMENTO
        navigator.vibrate(300);
      }
    } else if (type === 'clear') {
      navigator.vibrate(0);
    }
  };

  const calibrateAtOneMeter = async () => {
    if (!isScanning) {
      setError("Ative a câmera antes de calibrar.");
      return;
    }
    
    setIsProcessing(true);
    try {
      const { base64: base64Image } = await captureImage();

      if (!canvasRef.current) throw new Error("Canvas não disponível.");
      const faceGeometry = await measureFaceGeometry(canvasRef.current);

      if (faceGeometry && faceGeometry.faceWidthNormalized > 0) {
        // Calibrar Distância Focal (Largura do Rosto)
        const newFocal = faceGeometry.faceWidthNormalized / 0.16;
        setFocalLength(newFocal);

        // Calibrar Distância Focal dos Olhos
        if (faceGeometry.interocularDistanceNormalized) {
          const newEyeFocal = faceGeometry.interocularDistanceNormalized / 0.063;
          setEyeFocalLength(newEyeFocal);
        }

        smoothedDistRef.current = null;
        prevDistanceRef.current = null;

        speak("Calibração concluída com sucesso.");
      } else {
        speak("Falha na calibração. Nenhum rosto detectado.");
      }
    } catch (err: any) {
      setError("Erro na calibração: " + err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const speak = (text: string, priority: 'high' | 'normal' = 'normal') => {
    if (!('speechSynthesis' in window)) return;

    // Se for prioridade alta (perigo), cancela tudo e fala na hora
    if (priority === 'high') {
      window.speechSynthesis.cancel();
      speechQueueRef.current = [];
      isProcessingQueueRef.current = false;
      const utterance = createUtterance(text);
      window.speechSynthesis.speak(utterance);
      return;
    }

    // Evita duplicatas na fila
    if (speechQueueRef.current.some(item => item.text === text)) return;

    // Adiciona na fila (limite de 3 itens para não ficar muito atrasado)
    if (speechQueueRef.current.length < 3) {
      speechQueueRef.current.push({ text, priority });
    }

    // Inicia o processamento se não estiver rodando
    if (!isProcessingQueueRef.current && !window.speechSynthesis.speaking) {
      processQueue();
    }
  };

  const processQueue = () => {
    if (speechQueueRef.current.length === 0) {
      isProcessingQueueRef.current = false;
      return;
    }

    isProcessingQueueRef.current = true;
    const next = speechQueueRef.current.shift();
    if (next) {
      const utterance = createUtterance(next.text);
      window.speechSynthesis.speak(utterance);
    }
  };

  const createUtterance = (text: string) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const ptVoice = voices.find(voice => voice.lang === 'pt-BR' || voice.lang.startsWith('pt-BR'));
    
    if (ptVoice) utterance.voice = ptVoice;
    utterance.lang = 'pt-BR';
    utterance.rate = speechRate;

    utterance.onstart = () => { 
      isSpeakingRef.current = true; 
    };
    
    utterance.onend = () => {
      isSpeakingRef.current = false;
      // Pequeno delay entre falas para clareza
      setTimeout(() => processQueue(), 100);
    };

    utterance.onerror = () => {
      isSpeakingRef.current = false;
      setTimeout(() => processQueue(), 100);
    };

    return utterance;
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="p-6 border-b border-white/5 flex justify-between items-center bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Scan className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">VisionAssist</h1>
            <p className="text-xs text-indigo-400 uppercase tracking-widest font-bold">Módulo Estereoscópico</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isQuotaExceeded && (
            <button 
              onClick={() => {
                setIsQuotaExceeded(false);
                setIsOfflineMode(false);
                speak("Tentando reconectar à nuvem.", 'normal');
              }}
              className="flex items-center gap-2 bg-amber-500/10 text-amber-500 px-3 py-1.5 rounded-lg border border-amber-500/20 hover:bg-amber-500/20 transition-all"
              title="Cota de nuvem excedida. Clique para tentar reconectar."
            >
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs font-medium hidden sm:inline">Modo Local</span>
            </button>
          )}
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 hover:bg-white/5 rounded-full transition-colors"
          >
            <Settings className="w-5 h-5 text-zinc-400" />
          </button>
        </div>
      </header>

      <main className="p-6 max-w-lg mx-auto space-y-8">
        {/* Error Alert */}
        <AnimatePresence>
          {error && (
            <motion.div 
              key="error-alert"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl flex items-center justify-between"
            >
              <p className="text-xs text-red-500 font-medium">{error}</p>
              <button onClick={() => setError(null)}><X className="w-4 h-4 text-red-500" /></button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Camera Preview / Status */}
        <section className="bg-zinc-900 rounded-3xl overflow-hidden border border-white/5 shadow-2xl relative">
          <div className="aspect-video bg-zinc-800 relative">
            {isScanning ? (
              cameraSource === 'local' ? (
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-900">
                  <div className="relative">
                    <Wifi className="w-12 h-12 text-emerald-500 animate-pulse" />
                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border-2 border-zinc-900" />
                  </div>
                  <p className="text-sm font-medium mt-4 text-zinc-400">Conectado à ESP32-CAM</p>
                  <p className="text-[10px] text-zinc-600 mt-1 font-mono">{remoteUrl}</p>
                </div>
              )
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-zinc-600">
                <Camera className="w-12 h-12 mb-2 opacity-20" />
                <p className="text-sm font-medium">Câmera Desligada</p>
              </div>
            )}
            
            {/* Distance Overlay */}
            {distance !== null && isScanning && (
              <div className={`absolute top-4 right-4 backdrop-blur-md px-3 py-1.5 rounded-xl border flex items-center gap-2 z-10 transition-colors ${
                distance < 1.0 ? 'bg-red-600 border-white/40 shadow-[0_0_15px_rgba(220,38,38,0.5)]' : 
                distance < 2.0 ? 'bg-orange-500/80 border-white/20' : 
                'bg-zinc-950/80 border-white/10'
              }`}>
                <div className={`w-2 h-2 rounded-full animate-pulse ${
                  distance < 1.0 ? 'bg-white' : 
                  distance < 2.0 ? 'bg-white' : 'bg-emerald-500'
                }`} />
                <div className="flex flex-col items-end leading-none">
                  <span className="text-[10px] font-bold tracking-widest uppercase">{distance}m</span>
                  <span className={`text-[7px] font-black uppercase tracking-[0.2em] mt-0.5 ${
                    distanceSource === 'stereo' ? 'text-indigo-400' :
                    distanceSource === 'hardware' ? 'text-emerald-400' : 
                    distanceSource === 'geometric' ? 'text-blue-400' : 'text-amber-400'
                  }`}>
                    {distance < 1.0 ? 'CRÍTICO' : 
                     distance < 2.0 ? 'ALERTA' : 
                     (distanceSource === 'stereo' ? 'Stereo' :
                      distanceSource === 'hardware' ? 'Sensor' : 
                      distanceSource === 'geometric' ? 'Visual' : 'IA')}
                    {movementTrend === 'approaching' && ' • APROXIMANDO'}
                    {movementTrend === 'receding' && ' • AFASTANDO'}
                  </span>
                </div>
              </div>
            )}

            {/* Live Mode Indicator */}
            {isLiveMode && (
              <div className="absolute top-4 left-4 bg-red-500/80 backdrop-blur-md px-3 py-1.5 rounded-xl flex items-center gap-2 z-10">
                <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                <span className="text-[10px] font-bold tracking-widest uppercase">LIVE</span>
              </div>
            )}

            {isLiveMode && lastResult && !lastResult.personDetected && !isProcessing && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-emerald-500/90 backdrop-blur-md px-4 py-2 rounded-full border border-white/20 shadow-xl z-20 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                <span className="text-[10px] font-bold text-white uppercase tracking-widest">Área Livre</span>
              </div>
            )}
            
            {/* Overlay indicators */}
            {isScanning && (
              <div className="absolute inset-0 pointer-events-none border-2 border-emerald-500/30 m-8 rounded-2xl">
                <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-emerald-500" />
                <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-emerald-500" />
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-emerald-500" />
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-emerald-500" />
              </div>
            )}
          </div>

          <div className="p-6 bg-zinc-900 flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Fonte de Entrada</p>
                <div className="flex bg-zinc-950 p-0.5 rounded-lg border border-white/5">
                  <button 
                    onClick={() => setCameraSource('local')}
                    className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-tighter rounded-md transition-all ${
                      cameraSource === 'local' ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    PC
                  </button>
                  <button 
                    onClick={() => setCameraSource('stereo')}
                    className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-tighter rounded-md transition-all ${
                      cameraSource === 'stereo' ? 'bg-indigo-600 text-white' : 'text-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    Stereo
                  </button>
                </div>
              </div>
              <p className="text-xl font-light tracking-tight">
                {isScanning 
                  ? (cameraSource === 'local' ? 'Câmera do PC' : 'Óculos Stereo') 
                  : 'Em Espera'}
              </p>
            </div>
            <div className="flex gap-2">
              {isScanning && (
                <>
                  <button 
                    onClick={() => setIsLiveMode(!isLiveMode)}
                    className={`p-4 rounded-2xl transition-all ${
                      isLiveMode 
                      ? 'bg-red-500 text-white shadow-lg shadow-red-500/20' 
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                    }`}
                    title={isLiveMode ? "Desativar Modo Live" : "Ativar Modo Live"}
                  >
                    <Scan className={`w-6 h-6 ${isLiveMode ? 'animate-pulse' : ''}`} />
                  </button>
                  <button 
                    onClick={handleCaptureAndRecognize}
                    disabled={isProcessing || isLiveMode}
                    className="p-4 bg-emerald-500 text-zinc-950 rounded-2xl hover:bg-emerald-400 transition-all disabled:opacity-50 disabled:animate-pulse"
                    title="Capturar e Reconhecer"
                  >
                    {isProcessing ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Scan className="w-6 h-6" />}
                  </button>
                </>
              )}
              <button 
                onClick={() => setIsScanning(!isScanning)}
                className={`px-6 py-3 rounded-2xl font-semibold transition-all ${
                  isScanning 
                  ? 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700' 
                  : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20'
                }`}
              >
                {isScanning ? 'Parar' : 'Iniciar'}
              </button>
            </div>
          </div>
        </section>

          {/* Detection Result Card */}
          <section className="space-y-4">
            <div className="flex items-center justify-between px-2">
              <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                <MapPin className="w-4 h-4" /> Resultado da Análise
              </h3>
              {distanceSource === 'stereo' && (
                <div className="flex items-center gap-1.5 px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded-full text-[10px] font-bold border border-blue-500/30">
                  <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                  C++ ENGINE OPTIMIZED
                </div>
              )}
              {isOfflineMode && (
                <div className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded-lg">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  <span className="text-[9px] font-black text-amber-500 uppercase tracking-widest">⚡ Offline</span>
                </div>
              )}
            </div>

            <AnimatePresence mode="popLayout">
            {latency && isScanning && (
              <motion.div 
                key="latency-info"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                className="px-2 py-3 bg-zinc-900/40 border border-white/5 rounded-2xl flex items-center justify-around gap-4"
              >
                <div className="flex flex-col items-center">
                  <span className="text-[8px] text-zinc-500 uppercase font-black tracking-widest">Captura</span>
                  <span className="text-xs font-mono text-zinc-400">{latency.capture}ms</span>
                </div>
                <div className="w-px h-6 bg-white/5" />
                <div className="flex flex-col items-center">
                  <span className="text-[8px] text-zinc-500 uppercase font-black tracking-widest">IA / API</span>
                  <span className={`text-xs font-mono ${latency.api > 5000 ? 'text-amber-500' : 'text-zinc-400'}`}>
                    {latency.api > 0 ? `${latency.api}ms` : '---'}
                  </span>
                </div>
                <div className="w-px h-6 bg-white/5" />
                <div className="flex flex-col items-center">
                  <span className="text-[8px] text-zinc-500 uppercase font-black tracking-widest">Total</span>
                  <span className="text-xs font-mono text-emerald-500/80">{latency.total}ms</span>
                </div>
              </motion.div>
            )}

            {lastResult && lastResult.people.length > 0 ? (
              <motion.div 
                key={`results-container-${lastResult.timestamp || 'initial'}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-3"
              >
                {lastResult.people.map((person, idx) => (
                  <motion.div
                    key={`result-person-${lastResult.timestamp || '0'}-${idx}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`rounded-3xl p-5 border flex items-center gap-4 ${
                      person.isKnown 
                      ? 'bg-emerald-500/10 border-emerald-500/20' 
                      : 'bg-zinc-900 border-white/5'
                    }`}
                  >
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                      person.isKnown ? 'bg-emerald-500' : 'bg-zinc-800'
                    }`}>
                      <User className={`${person.isKnown ? 'text-zinc-950' : 'text-zinc-400'} w-6 h-6`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <p className={`text-[10px] font-bold uppercase tracking-widest ${
                            person.isKnown ? 'text-emerald-500' : 'text-zinc-500'
                          }`}>
                            {person.isKnown ? 'Conhecido' : 'Desconhecido'}
                          </p>
                          {person.detectionSource && (
                            <span className={`text-[8px] px-1.5 py-0.5 rounded-md font-black uppercase tracking-tighter ${
                              person.detectionSource === 'face' ? 'bg-blue-500/20 text-blue-400' : 'bg-amber-500/20 text-amber-400'
                            }`}>
                              {person.detectionSource === 'face' ? 'Face' : 'Corpo'}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          {idx === 0 && distance && (
                            <div className="flex items-center gap-1.5">
                              <span className={`text-[9px] font-black uppercase tracking-tighter px-2 py-0.5 rounded-md ${
                                person.distanceSource === 'stereo' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 
                                'bg-zinc-800 text-zinc-500 border border-white/5'
                              }`}>
                                {person.distanceSource === 'stereo' ? 'Triangulação Stereo' : 'Estimativa Visual'}
                              </span>
                              <span className="text-[9px] font-black text-zinc-400 uppercase tracking-tighter bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
                                Foco Principal
                              </span>
                            </div>
                          )}
                          {idx === 0 && movementTrend && (
                            <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md ${
                              movementTrend === 'approaching' ? 'bg-red-500/20 text-red-400' : 
                              movementTrend === 'receding' ? 'bg-blue-500/20 text-blue-400' : 
                              'bg-zinc-800 text-zinc-500'
                            }`}>
                              {movementTrend === 'approaching' ? 'Aproximando-se' : 
                               movementTrend === 'receding' ? 'Afastando-se' : 'Estacionário'}
                            </span>
                          )}
                        </div>
                      </div>
                      <h4 className="text-lg font-medium tracking-tight truncate">
                        {person.isKnown ? person.name : 'Pessoa ' + (idx + 1)}
                      </h4>
                      <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed line-clamp-2">{person.description}</p>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            ) : isScanning ? (
              <motion.div 
                key="scanning-placeholder"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="bg-zinc-900/30 border border-zinc-800/50 rounded-3xl p-12 flex flex-col items-center justify-center text-center"
              >
                <p className="text-zinc-600 text-sm">Toque no botão de scan para identificar</p>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div key="settings-modal-container" className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div 
              key="settings-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSettingsOpen(false)}
              className="absolute inset-0 bg-zinc-950/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-zinc-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-white/5 flex justify-between items-center">
                <h2 className="text-xl font-semibold tracking-tight">Configurações</h2>
                <button onClick={() => setIsSettingsOpen(false)} className="p-2 hover:bg-white/5 rounded-full">
                  <X className="w-5 h-5 text-zinc-500" />
                </button>
              </div>
              
              <div className="p-6 space-y-6">
                <div className="space-y-4">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block">Alerta de Proximidade</label>
                  <div className="bg-zinc-950 border border-white/5 rounded-2xl p-4 space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-zinc-400">Distância Limite: <span className="text-emerald-500 font-bold">{proximityThreshold}m</span></span>
                      <input 
                        type="range" 
                        min="0.5" 
                        max="5.0" 
                        step="0.5" 
                        value={proximityThreshold}
                        onChange={(e) => setProximityThreshold(parseFloat(e.target.value))}
                        className="w-24 accent-emerald-500"
                      />
                    </div>
                    <div className="flex flex-col gap-3 border-t border-white/5 pt-4">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">Calibração de Distância</span>
                        <div className="flex gap-2">
                          <button 
                            onClick={calibrateAtOneMeter}
                            className="bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-colors"
                          >
                            VISUAL (1M)
                          </button>
                          <button 
                            onClick={calibrateStereo}
                            className="bg-indigo-500 hover:bg-indigo-600 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-colors"
                          >
                            STEREO (1M)
                          </button>
                        </div>
                      </div>
                      <p className="text-[10px] text-zinc-500 italic">
                        Fique a exatamente 1 metro da câmera e pressione o botão para calibrar o sensor visual ou stereo.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-zinc-400">Compensação Sync: <span className="text-emerald-500 font-bold">{syncCompensation}px</span></span>
                        <input 
                          type="range" 
                          min="0" 
                          max="20" 
                          step="0.5" 
                          value={syncCompensation}
                          onChange={(e) => setSyncCompensation(parseFloat(e.target.value))}
                          className="w-24 accent-emerald-500"
                        />
                      </div>
                      <p className="text-[10px] text-zinc-500 italic">
                        Ajuste para compensar atrasos de captura em objetos em movimento.
                      </p>
                    </div>
                    <div className="flex justify-between items-center border-t border-white/5 pt-4">
                      <span className="text-sm text-zinc-400">Vibração no Alerta</span>
                      <button 
                        onClick={() => setVibrationEnabled(!vibrationEnabled)}
                        className={`w-12 h-6 rounded-full transition-colors relative ${vibrationEnabled ? 'bg-emerald-500' : 'bg-zinc-800'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${vibrationEnabled ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>
                    <div className="flex justify-between items-center border-t border-white/5 pt-4">
                      <div className="flex flex-col">
                        <span className="text-sm text-zinc-400">Modo Offline</span>
                        <span className="text-[8px] text-zinc-600 uppercase font-bold tracking-widest">Processamento Local</span>
                      </div>
                      <button 
                        onClick={() => setIsOfflineMode(!isOfflineMode)}
                        className={`w-12 h-6 rounded-full transition-colors relative ${isOfflineMode ? 'bg-blue-500' : 'bg-zinc-800'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${isOfflineMode ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block">Voz e Acessibilidade</label>
                  <div className="bg-zinc-950 border border-white/5 rounded-2xl p-4 space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-zinc-400">Velocidade da Fala: <span className="text-emerald-500 font-bold">{speechRate}x</span></span>
                      <input 
                        type="range" 
                        min="0.5" 
                        max="2.0" 
                        step="0.1" 
                        value={speechRate}
                        onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
                        className="w-24 accent-emerald-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block">Fonte da Câmera</label>
                  <div className="grid grid-cols-3 gap-3">
                    <button 
                      onClick={() => setCameraSource('local')}
                      className={`py-4 rounded-2xl font-bold flex flex-col items-center gap-2 transition-all border ${
                        cameraSource === 'local' 
                        ? 'bg-emerald-500/10 border-emerald-500 text-emerald-500' 
                        : 'bg-zinc-950 border-white/5 text-zinc-500 hover:border-white/10'
                      }`}
                    >
                      <Camera className="w-6 h-6" />
                      <span className="text-xs">Local</span>
                    </button>
                    <button 
                      onClick={() => setCameraSource('remote')}
                      className={`py-4 rounded-2xl font-bold flex flex-col items-center gap-2 transition-all border ${
                        cameraSource === 'remote' 
                        ? 'bg-emerald-500/10 border-emerald-500 text-emerald-500' 
                        : 'bg-zinc-950 border-white/5 text-zinc-500 hover:border-white/10'
                      }`}
                    >
                      <Wifi className="w-6 h-6" />
                      <span className="text-xs">ESP32</span>
                    </button>
                    <button 
                      onClick={() => setCameraSource('stereo')}
                      className={`py-4 rounded-2xl font-bold flex flex-col items-center gap-2 transition-all border ${
                        cameraSource === 'stereo' 
                        ? 'bg-emerald-500/10 border-emerald-500 text-emerald-500' 
                        : 'bg-zinc-950 border-white/5 text-zinc-500 hover:border-white/10'
                      }`}
                    >
                      <RefreshCw className="w-6 h-6" />
                      <span className="text-xs">Stereo</span>
                    </button>
                  </div>
                </div>

                {cameraSource !== 'local' && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="space-y-4"
                  >
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block">
                        {cameraSource === 'stereo' ? 'URL Câmera Esquerda (IP)' : 'URL de Captura (IP)'}
                      </label>
                      <div className="relative">
                        <input 
                          type="text" 
                          value={remoteUrl}
                          onChange={(e) => setRemoteUrl(e.target.value)}
                          placeholder="http://192.168.1.100/capture"
                          className="w-full bg-zinc-950 border border-white/5 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-emerald-500/50 transition-colors"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2">
                          <Globe className="w-4 h-4 text-zinc-700" />
                        </div>
                      </div>
                    </div>

                    {cameraSource === 'stereo' && (
                      <>
                        <div className="space-y-3">
                          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block">URL Câmera Direita (IP)</label>
                          <div className="relative">
                            <input 
                              type="text" 
                              value={remoteUrlRight}
                              onChange={(e) => setRemoteUrlRight(e.target.value)}
                              placeholder="http://192.168.1.101/capture"
                              className="w-full bg-zinc-950 border border-white/5 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-emerald-500/50 transition-colors"
                            />
                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                              <Globe className="w-4 h-4 text-zinc-700" />
                            </div>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block">Baseline (mm): <span className="text-emerald-500">{baseline}mm</span></label>
                          <input 
                            type="range" 
                            min="30" 
                            max="200" 
                            step="1" 
                            value={baseline}
                            onChange={(e) => setBaseline(parseFloat(e.target.value))}
                            className="w-full accent-emerald-500"
                          />
                        </div>
                      </>
                    )}
                    
                    <p className="text-[10px] text-zinc-500 leading-relaxed italic">
                      {cameraSource === 'stereo' 
                        ? "O sistema stereo requer duas ESP32-CAMs sincronizadas por software. A distância é calculada por triangulação."
                        : "Certifique-se de que a ESP32-CAM está na mesma rede Wi-Fi e que o endpoint de captura está correto."}
                    </p>
                  </motion.div>
                )}

                <button 
                  onClick={() => setIsSettingsOpen(false)}
                  className="w-full bg-white/5 hover:bg-white/10 text-white py-4 rounded-2xl font-bold transition-all"
                >
                  Fechar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Hidden Canvas for capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Footer Info */}
      <footer className="p-8 text-center">
        <p className="text-[10px] text-zinc-700 uppercase tracking-[0.2em] font-bold">
          VisionAssist POC v1.0 • Análise Estereoscópica • Projeto TCC
        </p>
      </footer>
    </div>
  );
}
