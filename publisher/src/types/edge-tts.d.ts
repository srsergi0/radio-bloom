declare module "edge-tts-universal" {
  export class EdgeTTS {
    constructor(text: string, voice: string);
    synthesize(): Promise<{ audio: { arrayBuffer(): Promise<ArrayBuffer> } }>;
  }

  export interface Voice {
    Name: string;
    ShortName: string;
    Gender: string;
    Locale: string;
    SuggestedCodec: string;
    Status: string;
    VoiceTag: {
      ContentCategories: string[];
      VoicePersonalities: string[];
    };
  }

  export interface VoicesManagerVoice extends Voice {
    Language: string;
  }

  export interface VoicesManagerFind {
    Gender?: string;
    Language?: string;
    Status?: string;
  }

  export function listVoices(): Promise<Voice[]>;

  export class VoicesManager {
    static create(): Promise<VoicesManager>;
    find(filter: VoicesManagerFind): VoicesManagerVoice[];
  }
}
