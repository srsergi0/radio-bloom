import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { EdgeTTS } from "edge-tts-universal";

export class TtsService {
  constructor(private readonly musicDir: string) {}

  async synthesize(scriptText: string, voice?: string): Promise<string | null> {
    const activeVoice = voice || process.env.AI_DJ_VOICE || "es-ES-AlvaroNeural";
    try {
      const filename = `ai_dj_pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`;
      const interludiosDir = join(this.musicDir, "interludios");
      const filePath = join(interludiosDir, filename);

      const tts = new EdgeTTS(scriptText, activeVoice);
      const result = await tts.synthesize();
      const arrayBuffer = await result.audio.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fsPromises.writeFile(filePath, buffer);

      console.log(`[TtsService] Synthesized: ${filePath}`);
      return filePath;
    } catch (err: any) {
      console.error("[TtsService] Synthesis failed:", err.message);
      return null;
    }
  }
}
