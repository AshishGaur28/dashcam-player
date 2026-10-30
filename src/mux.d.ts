/* eslint-disable @typescript-eslint/no-unused-vars */
declare module 'mux.js' {
  interface TransmuxSegment {
    type: 'combined' | 'video' | 'audio';
    initSegment: Uint8Array;
    data: Uint8Array;
    info: { profileIdc?: number; levelIdc?: number; profileCompatibility?: number; width?: number; height?: number; sampleRate?: number };
  }
  class Transmuxer {
    constructor(options?: { remux?: boolean; keepOriginalTimestamps?: boolean });
    on(event: 'data', cb: (s: TransmuxSegment) => void): void;
    on(event: 'done', cb: () => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
    setBaseMediaDecodeTime(t: number): void;
    dispose(): void;
  }
  const mux: { mp4: { Transmuxer: typeof Transmuxer } };
  export default mux;
  export type { TransmuxSegment };
}
