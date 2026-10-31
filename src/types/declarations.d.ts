declare module 'ffprobe-static' {
  const path: string;
  export default path;
}

declare module 'ffmpeg-static' {
  const path: string;
  export default path;
}

declare module 'puppeteer-screen-recorder' {
  export class PuppeteerScreenRecorder {
    constructor(page: any, options?: any);
    start(savePath: string): Promise<boolean>;
    stop(): Promise<boolean>;
  }
}

declare module 'pptxgenjs';

declare module 'node-edge-tts' {
  export class EdgeTTS {
    constructor(options?: any);
    ttsPromise(text: string, outputPath: string): Promise<void>;
  }
}