declare module '@mediapipe/tasks-vision' {
  export class FaceDetector {
    static createFromOptions(vision: any, options: any): Promise<FaceDetector>;
    detect(image: any): any;
  }
  export const FilesetResolver: {
    forVisionTasks(wasmPath: string): Promise<any>;
  };
}
