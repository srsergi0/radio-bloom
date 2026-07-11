import {
  existsSync,
  promises as fsPromises,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EdgeTTS } from "edge-tts-universal";
import type { Track } from "../domain/types";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import type { LibraryService } from "./library.service";
import type { BuncasterService } from "./buncaster.service";
import type { LocutorService } from "./locutor.service";

interface DialogueMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

interface DjHistory {
  dialogueHistory: DialogueMessage[];
}

export class OrchestratorService {
  private loopInterval: Timer | null = null;
  private isProcessing = false;
  private recentHistory: string[] = []; // Last 15 song IDs queued
  private tempFiles = new Set<string>(); // Keep track of absolute paths of generated MP3s
  private dialogueHistory: DialogueMessage[] = [];
  private startedAt = 0;
  private lastPlayedFile: string | null = null;
  private static readonly STARTUP_GRACE_MS = 30_000; // 30s grace period on startup

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly libraryService: LibraryService,
    private readonly buncasterService: BuncasterService,
    private readonly locutorService: LocutorService,
    private readonly playlistRepo: PlaylistRepository,
    private readonly musicDir: string,
    private readonly dataDir: string
  ) {}

  /**
   * Starts the background queue orchestrator loop.
   */
  public start(): void {
    const isEnabled = process.env.AI_DJ_ENABLED === "true";
    const apiKey = process.env.OPENROUTER_API_KEY || "";

    if (!isEnabled) {
      console.log(
        "[OrchestratorService] AI DJ is disabled via environment variables (AI_DJ_ENABLED)."
      );
      return;
    }

    if (!apiKey) {
      console.error(
        "[OrchestratorService] AI DJ is enabled but OPENROUTER_API_KEY is not configured. AI DJ will not start."
      );
      return;
    }

    // Load persistent history
    this.loadHistory();

    console.log("[OrchestratorService] Starting AI DJ Orchestrator background loop...");
    this.startedAt = Date.now();

    // Clear stale queue from previous session on startup
    this.buncasterService.queueClear(false).catch(() => {});

    // Check every 10 seconds
    this.loopInterval = setInterval(() => {
      this.tick().catch((err) => console.error("[OrchestratorService] Error in tick loop:", err));
    }, 10000);

    // Initial trigger
    this.tick().catch((err) => console.error("[OrchestratorService] Error in initial tick:", err));
  }

  /**
   * Stops the background orchestrator loop.
   */
  public stop(): void {
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    console.log("[OrchestratorService] AI DJ Orchestrator stopped.");
  }

  /**
   * Loads dialogue history from a file.
   */
  private loadHistory(): void {
    const filePath = join(this.dataDir, "dj_history.json");
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const data = JSON.parse(content) as any;
        if (data.dialogueHistory) {
          this.dialogueHistory = data.dialogueHistory;
        } else if (Array.isArray(data.recentEvents)) {
          // Migrar formato recentEvents a formato DialogueMessage
          this.dialogueHistory = data.recentEvents.map((e: any) => {
            if (e.type === "speech") {
              return { role: "assistant" as const, content: e.content };
            }
            return { role: "system" as const, content: e.content };
          });
        } else {
          this.dialogueHistory = [];
        }
        console.log(
          `[OrchestratorService] Loaded ${this.dialogueHistory.length} dialogue history items from dj_history.json`
        );
      } catch (err: any) {
        console.error(
          "[OrchestratorService] Failed to load dj_history.json, starting fresh:",
          err.message
        );
        this.dialogueHistory = [];
      }
    } else {
      this.dialogueHistory = [];
    }
  }

  /**
   * Saves dialogue history to a file.
   */
  private async saveHistory(): Promise<void> {
    const filePath = join(this.dataDir, "dj_history.json");
    try {
      const data: DjHistory = { dialogueHistory: this.dialogueHistory };
      await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err: any) {
      console.error("[OrchestratorService] Failed to save dj_history.json:", err.message);
    }
  }

  /**
   * Periodically checking queue and streams.
   */
  private async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      if (!this.buncasterService.isConnected()) {
        this.isProcessing = false;
        return;
      }

      // Grace period: wait after startup before doing anything
      const elapsed = Date.now() - this.startedAt;
      if (elapsed < OrchestratorService.STARTUP_GRACE_MS) {
        this.isProcessing = false;
        return;
      }

      const status = await this.buncasterService.getStreamStatus();
      const { items: queue } = await this.buncasterService.queueList();

      // 0. Update last_played_at when track changes
      const currentFile = status.metadata?.filename || status.metadata?.initial_uri || "";
      if (currentFile && currentFile !== this.lastPlayedFile) {
        this.lastPlayedFile = currentFile;
        this.libraryService.updateLastPlayedByFile(currentFile);
      }

      // 1. Clean up generated TTS files that already played
      await this.cleanupTempFiles(status, queue);

      // Re-fetch queue (queueInsert clears and rebuilds, making queue stale)
      const { items: refreshedQueue } = await this.buncasterService.queueList();

      // 2. Queue new tracks if queue is dropping below 5 elements
      //    but never exceed 20 items to prevent unbounded growth
      //    Also skip if user recently cleared the queue manually
      if (refreshedQueue.length < 5 && refreshedQueue.length < 20 && !this.buncasterService.isManualClearActive()) {
        console.log(
          `[OrchestratorService] Queue is low (${refreshedQueue.length} items). Enqueuing next tracks...`
        );
        await this.enqueueNext(status, refreshedQueue);
      }
    } catch (err: any) {
      console.error("[OrchestratorService] Error in loop tick:", err.message);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Cleans up physical temporary files generated by the DJ TTS synthesizer after playing.
   */
  private async cleanupTempFiles(status: any, queue: any[]): Promise<void> {
    const currentPlayingFile = status.metadata?.filename || status.metadata?.initial_uri || "";

    const queuedFilenames = new Set<string>();
    const metaResults: Record<string, string>[] = await Promise.all(
      queue.map((item) =>
        this.buncasterService
          .getRequestMetadata(item.rid)
          .catch((): Record<string, string> => ({}))
      )
    );
    for (const meta of metaResults) {
      const filename = meta.filename || meta.initial_uri || "";
      if (filename) queuedFilenames.add(filename);
    }

    for (const tempFile of Array.from(this.tempFiles)) {
      const baseFilename = tempFile.replace(/\\/g, "/").split("/").pop();
      if (!baseFilename) continue;

      const isCurrentlyPlaying = currentPlayingFile.includes(baseFilename);
      const isQueued = Array.from(queuedFilenames).some((fn) => fn.includes(baseFilename));

      if (!isCurrentlyPlaying && !isQueued) {
        try {
          if (existsSync(tempFile)) {
            unlinkSync(tempFile);
            console.log(`[OrchestratorService] Cleaned up temporary DJ speech: ${tempFile}`);
          }
          this.tempFiles.delete(tempFile);
        } catch (err: any) {
          console.error(
            `[OrchestratorService] Failed to clean up temp file ${tempFile}:`,
            err.message
          );
        }
      }
    }
  }

  /**
   * Generates a contextual script for a song based on the active locutor's personality.
   */
  private async generateContextualScript(
    songItem: { title: string; artist: string },
    activeLocutor: any
  ): Promise<string | null> {
    const personality = activeLocutor
      ? activeLocutor.personality
      : process.env.AI_DJ_PERSONALITY ||
        "Un locutor de radio fresco, enérgico y cercano al público de Radio Bloom.";

    const peruTime = new Date().toLocaleTimeString("es-PE", {
      timeZone: "America/Lima",
      hour: "numeric",
      minute: "2-digit",
    });

    // Simple script generation based on time of day and song
    const hour = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Lima" })
    ).getHours();

    let timeGreeting = "";
    if (hour >= 6 && hour < 12) {
      timeGreeting = "Buenos días";
    } else if (hour >= 12 && hour < 20) {
      timeGreeting = "Buenas tardes";
    } else {
      timeGreeting = "Buenas noches";
    }

    // Generate a natural, carismatic script (30-45 words)
    const scripts = [
      `${timeGreeting}, Radio Bloom. ${songItem.artist} llega con "${songItem.title}" para acompañarte en este momento. Disfruta la vibra.`,
      `Y seguimos con la buena música. Ahora suena "${songItem.title}" de ${songItem.artist}. Quédate con nosotros, que lo mejor está por venir.`,
      `${songItem.artist} y "${songItem.title}"... una combinación perfecta para este momento. Radio Bloom, tu station.`,
      `La música no para y tú tampoco. "${songItem.title}" de ${songItem.artist} ahora en Radio Bloom. Siente el ritmo.`,
      `Esto es Radio Bloom y seguimos moviéndote. ${songItem.artist} con "${songItem.title}". No te vayas, que tenemos más música.`,
    ];

    return scripts[Math.floor(Math.random() * scripts.length)];
  }

  /**
   * Enqueues tracks based on locutor's playlist or AI agent when no playlist exists.
   */
  private async enqueueNext(status: any, queue: any[]): Promise<void> {
    const allSongs = this.libraryRepo.getAllTracks("song");

    if (allSongs.length === 0) {
      console.warn(
        "[OrchestratorService] No tracks found in the database catalog. Queue addition skipped."
      );
      return;
    }

    const activeLocutor = this.locutorService.getActiveLocutorAtCurrentTime();
    if (activeLocutor) {
      console.log(
        `[OrchestratorService] Active AI Locutor: "${activeLocutor.name}" (Voice: ${activeLocutor.voice})`
      );
    } else {
      console.log(
        "[OrchestratorService] No active scheduled locutor. Falling back to default DJ Bloom."
      );
    }

    // 1. Try to find a playlist for this locutor
    const playlist = activeLocutor
      ? this.playlistRepo.findActivePlaylistForLocutor(activeLocutor.id)
      : null;

    if (playlist && playlist.tracks.length > 0) {
      console.log(
        `[OrchestratorService] Found playlist "${playlist.name}" for locutor "${activeLocutor!.name}" (${playlist.tracks.length} tracks)`
      );
      await this.enqueueFromPlaylist(playlist, queue, status, activeLocutor);
      return;
    }

    // 2. No playlist found → AI DJ Phase 2
    console.log(
      "[OrchestratorService] No playlist found for this locutor. Triggering AI DJ Phase 2..."
    );
    await this.runAgentPhase2(status, queue, activeLocutor);
  }

  /**
   * Calculates remaining time from the current queue (elapsed + remaining songs)
   * and enqueues the right number of songs from a playlist to fill that time.
   */
  private async enqueueFromPlaylist(
    playlist: { tracks: { file?: string; duration: number; script?: string }[] },
    queue: any[],
    status: any,
    activeLocutor: any
  ): Promise<void> {
    // Calculate remaining time from the 2 songs closest to finishing in queue
    let remainingTimeSec = 0;

    if (queue.length > 0) {
      // Use the first song in queue (closest to finishing) for time estimation
      const firstQueueItem = queue[0];
      try {
        const meta = await this.buncasterService.getRequestMetadata(firstQueueItem.rid);
        const elapsed = parseFloat(meta.elapsed || "0");
        const duration = parseFloat(meta.duration || "0");
        if (duration > 0) {
          remainingTimeSec += Math.max(0, duration - elapsed);
        }
      } catch {}

      // Add duration of remaining songs in queue (skip the first one, we already counted it)
      for (let i = 1; i < queue.length; i++) {
        try {
          const meta = await this.buncasterService.getRequestMetadata(queue[i].rid);
          const dur = parseFloat(meta.duration || "0");
          if (dur > 0) remainingTimeSec += dur;
        } catch {}
      }
    }

    // If we couldn't estimate, default to 10 minutes
    if (remainingTimeSec <= 0) {
      remainingTimeSec = 600;
    }

    console.log(
      `[OrchestratorService] Estimated remaining queue time: ${Math.round(remainingTimeSec)}s`
    );

    // Select songs from playlist that fit the remaining time
    // Never cut a song — stop before the last one that would overflow
    // Skip tracks already in queue (by filepath)
    const queueFiles = new Set(
      queue.map((item) => {
        const f = item.file || "";
        // Normalize: strip /music/ prefix for comparison
        return f.replace(/^\/music\//, "");
      }).filter(Boolean)
    );
    const selectedTracks: typeof playlist.tracks = [];
    let totalTime = 0;

    for (const track of playlist.tracks) {
      if (!track.file) continue;
      // Skip if already in queue
      if (queueFiles.has(track.file)) continue;
      if (totalTime + track.duration > remainingTimeSec + 30) break; // 30s tolerance
      selectedTracks.push(track);
      totalTime += track.duration;
    }

    if (selectedTracks.length === 0) {
      console.warn(
        "[OrchestratorService] Playlist has no valid tracks with files. Falling back to random."
      );
      const allSongs = this.libraryRepo.getAllTracks("song");
      await this.enqueueFallback(allSongs, 2);
      return;
    }

    console.log(
      `[OrchestratorService] Enqueuing ${selectedTracks.length} tracks from playlist (total: ~${Math.round(totalTime)}s)`
    );

    for (const track of selectedTracks) {
      const filepath = `/music/${track.file}`;

      // Synthesize script if present
      if (track.script && track.script.trim() !== "") {
        const speechPath = await this.synthesizeSpeech(track.script, activeLocutor?.voice);
        if (speechPath) {
          const filename = speechPath.replace(/\\/g, "/").split("/").pop();
          const rid = await this.buncasterService.queuePush(
            `/music/interludios/${filename}`,
            track.script
          );
          if (rid) {
            this.tempFiles.add(speechPath);
            this.dialogueHistory.push({ role: "assistant", content: track.script });
          }
        }
      }

      const rid = await this.buncasterService.queuePush(filepath);
      if (rid) {
        this.recentHistory.push(filepath);
        if (this.recentHistory.length > 15) this.recentHistory.shift();
      }
    }

    this.saveHistory().catch(() => {});
  }

  /**
   * Enqueues fallback random songs when nothing else is available.
   */
  private async enqueueFallback(allSongs: Track[], count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const candidates = allSongs.filter((song) => !this.recentHistory.includes(song.id));
      const pool = candidates.length > 0 ? candidates : allSongs;
      const randomSong = pool[Math.floor(Math.random() * pool.length)];
      if (randomSong) {
        console.log(`[OrchestratorService] Fallback enqueuing: "${randomSong.title}"`);
        const songRid = await this.buncasterService.queuePush(`/music/${randomSong.file}`);
        if (songRid) {
          this.recentHistory.push(randomSong.id);
          if (this.recentHistory.length > 15) this.recentHistory.shift();
        }
      }
    }
  }

  /**
   * AI DJ Phase 2: When no playlist exists for the locutor, the LLM creates one.
   * Receives: personality, voice, 10 recent songs from this locutor, 100 least-played songs.
   * Creates a permanent playlist in BD and enqueues songs.
   */
  private async runAgentPhase2(
    status: any,
    queue: any[],
    activeLocutor: any
  ): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    const model = process.env.AI_DJ_OPENROUTER_MODEL || "google/gemini-2.5-flash";

    const djName = activeLocutor ? activeLocutor.name : "DJ Bloom";
    const personality = activeLocutor
      ? activeLocutor.personality
      : process.env.AI_DJ_PERSONALITY ||
        "Un locutor de radio fresco, enérgico y cercano al público de Radio Bloom.";

    // 1. Get 10 recent songs played by this locutor (from playlist_tracks via playlists)
    const recentSongs = this.getLocutorRecentSongs(activeLocutor?.id, 10);

    // 2. Get 100 least-played songs (ordered by lastPlayedAt ASC, nulls first)
    const leastPlayed = this.libraryRepo.getLeastPlayedTracks(100);

    // 3. Get last 2 songs in queue for context
    const lastTwoSongs = await this.getLastTwoQueueSongs(queue);

    // Build context for the LLM
    const recentSongsText = recentSongs.length > 0
      ? recentSongs.map((s) => `- "${s.title}" de ${s.artist || "Desconocido"}`).join("\n")
      : "Ninguna canción previa en programas de este locutor.";

    const catalogText = leastPlayed
      .map((s) => `- ID: "${s.id}", Título: "${s.title}", Artista: ${s.artist || "Desconocido"}, Duración: ${Math.round(s.duration)}s`)
      .join("\n");

    const lastTwoText = lastTwoSongs.length > 0
      ? lastTwoSongs.map((s) => `"${s.title}" de ${s.artist || "Desconocido"}`).join(", ")
      : "Ninguna";

    const systemPrompt = `Eres "${djName}", el legendario, carismático y magnético locutor estrella de la emisora por internet 'Radio Bloom'.
Tu personalidad al aire es: ${personality}

Tu tarea es crear una playlist programada para tu bloque de transmisión. Debes seleccionar canciones del catálogo disponible y construir una playlist que encaje con tu vibra y personalidad.

CONTEXTO:
- Las últimas 2 canciones en cola son de OTRO programa (solo para referencia de continuidad, NO las repitas).
- Las canciones que tocaste en programas anteriores son: ${recentSongsText}

CATÁLOGO DISPONIBLE (100 canciones ordenadas por tiempo sin reproducirse, las que más llevan sin sonar primero):
${catalogText}

Directrices:
1. Selecciona ENTRE 10 Y 15 canciones del catálogo. DEBES seleccionar al menos 10 canciones.
2. TÚ DECIDES cuántas locuciones intermedias incluir según tu personalidad y estilo:
   - Locutores enérgicos/festivos: más locuciones (hasta 1 por cada 3 canciones)
   - Locutoras tranquilas/relajadas: menos locuciones (1 por cada 5-7 canciones)
   - Cada locución debe ser un guión de 30-45 palabras, natural y espontáneo.
3. NO incluyas canciones que ya están en la cola reciente.
4. Cada canción tiene una duración real en segundos — respétala, no la modifiques.
5. Ordena las canciones para crear un flujo musical coherente.
6. VARIEDAD: Selecciona géneros y artistas diferentes. NO repitas el mismo artista más de 2 veces.
7. IMPORTANTE: Tu playlist debe tener entre 10 y 15 canciones. Si seleccionas menos de 10, estarás incumpliendo las instrucciones.

RESULTADO:
Usa la herramienta 'create_program_playlist' para crear la playlist con las canciones seleccionadas.
Llama a esta herramienta obligatoriamente como tu último paso.`;

    const userPrompt = `INFORMACIÓN DEL ENTORNO:
- Últimas 2 canciones en cola (de otro programa): ${lastTwoText}
- Locutor: ${djName}
- Personalidad: ${personality}

Crea la playlist programada con las canciones del catálogo. Llama a create_program_playlist.`;

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      ...this.dialogueHistory.slice(-3),
      { role: "user", content: userPrompt },
    ];

    const tools = [
      {
        type: "function",
        function: {
          name: "search_library",
          description:
            "Busca canciones en la biblioteca de la radio por texto (título, artista o álbum). Devuelve coincidencias con sus IDs.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Término de búsqueda textual (ej. 'Rick Astley').",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "create_program_playlist",
          description:
            "Crea una playlist programada para un bloque de transmisión. DEBE contener entre 10 y 15 canciones del catálogo.",
          parameters: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Nombre del programa o playlist.",
              },
              description: {
                type: "string",
                description: "Descripción corta de la playlist (máx 100 caracteres).",
              },
              tracks: {
                type: "array",
                description: "Lista ordenada de 10-15 canciones seleccionadas del catálogo.",
                items: {
                  type: "object",
                  properties: {
                    library_track_id: {
                      type: "string",
                      description: "El ID real de la canción en library_tracks.",
                    },
                    script: {
                      type: "string",
                      description:
                        "Guión de locución opcional (30-45 palabras) para reproducir antes de esta canción, o string vacío. Máximo 2-3 scripts por playlist.",
                    },
                  },
                  required: ["library_track_id"],
                  additionalProperties: false,
                },
              },
            },
            required: ["name", "tracks"],
            additionalProperties: false,
          },
        },
      },
    ];

    let playlistResult: any = null;

    for (let turn = 0; turn < 6; turn++) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          signal: AbortSignal.timeout(60000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/srsergi0/radio-bloom",
            "X-Title": "Radio Bloom",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            tools,
          }),
        });

        if (!res.ok) {
          throw new Error(`OpenRouter returned status ${res.status}: ${await res.text()}`);
        }

        const data = (await res.json()) as any;
        const message = data.choices?.[0]?.message;
        if (!message) break;

        if (message.tool_calls && message.tool_calls.length > 0) {
          messages.push(message);

          for (const call of message.tool_calls) {
            const name = call.function.name;
            const args = JSON.parse(call.function.arguments || "{}");
            console.log(`[OrchestratorService] Phase 2 tool call: ${name}`);

            let toolResult = "";
            if (name === "create_program_playlist") {
              playlistResult = args;
              toolResult = JSON.stringify({
                ok: true,
                playlist_name: args.name,
                track_count: args.tracks?.length || 0,
                message: "Playlist creada exitosamente.",
              });
            } else if (name === "search_library") {
              toolResult = await this.executeTool(name, args);
            } else {
              toolResult = `Herramienta "${name}" no disponible en Phase 2.`;
            }

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name,
              content: toolResult,
            });
          }

          if (playlistResult) break;
          continue;
        }

        if (message.content) {
          console.log("[OrchestratorService] Phase 2 final response:", message.content.trim());
        }
        break;
      } catch (err: any) {
        console.error(`[OrchestratorService] Error in Phase 2 turn ${turn}:`, err.message);
        break;
      }
    }

    if (!playlistResult || !playlistResult.tracks || playlistResult.tracks.length < 10) {
      console.warn(
        `[OrchestratorService] Phase 2 playlist too small (${playlistResult?.tracks?.length || 0} tracks, need 10+). Falling back to random.`
      );
      const allSongs = this.libraryRepo.getAllTracks("song");
      await this.enqueueFallback(allSongs, 5);
      return;
    }

    // Create the playlist in the database
    const playlistName = playlistResult.name || `AI DJ - ${djName} - ${new Date().toLocaleDateString("es-PE")}`;
    const playlist = this.playlistRepo.create(playlistName, {
      description: playlistResult.description || `Playlist generada por IA para ${djName}`,
      locutorId: activeLocutor?.id,
    });

    console.log(
      `[OrchestratorService] Created playlist "${playlist.name}" (${playlist.id}) with ${playlistResult.tracks.length} tracks`
    );

    // Calculate total duration and add tracks to playlist
    let totalDuration = 0;
    for (const item of playlistResult.tracks) {
      const libTrack = this.libraryRepo.getTrackById(item.library_track_id);
      if (!libTrack) {
        console.warn(`[OrchestratorService] Track not found: ${item.library_track_id}`);
        continue;
      }
      totalDuration += libTrack.duration;
      this.playlistRepo.addTrack(playlist.id, {
        type: libTrack.type as "song" | "interludio",
        file: libTrack.file,
        title: libTrack.title,
        artist: libTrack.artist,
        duration: libTrack.duration,
        spotifyUrl: libTrack.spotifyUrl,
        script: item.script || "",
      });
    }

    console.log(
      `[OrchestratorService] Playlist "${playlist.name}" total duration: ${Math.round(totalDuration)}s`
    );

    // Enqueue songs from the newly created playlist
    await this.enqueueFromPlaylist(
      { tracks: playlistResult.tracks.map((t: any) => {
        const libTrack = this.libraryRepo.getTrackById(t.library_track_id);
        return {
          file: libTrack?.file,
          duration: libTrack?.duration || 0,
          script: t.script || "",
        };
      }) },
      queue,
      status,
      activeLocutor
    );

    this.dialogueHistory.push({
      role: "system",
      content: `Se creó la playlist "${playlist.name}" con ${playlistResult.tracks.length} canciones (${Math.round(totalDuration)}s)`,
    });
    if (this.dialogueHistory.length > 5) {
      this.dialogueHistory = this.dialogueHistory.slice(-5);
    }
    this.saveHistory().catch(() => {});
  }

  /**
   * Gets the last N songs played by a specific locutor from playlists.
   */
  private getLocutorRecentSongs(
    locutorId: string | undefined,
    limit: number
  ): { title: string; artist: string }[] {
    if (!locutorId) return [];

    try {
      const playlists = this.playlistRepo.list();
      const locutorPlaylists = playlists.filter((p) => p.locutorId === locutorId);

      const recentSongs: { title: string; artist: string }[] = [];
      for (const pl of locutorPlaylists.slice(0, 3)) {
        const full = this.playlistRepo.get(pl.id);
        if (full) {
          for (const track of full.tracks) {
            if (recentSongs.length >= limit) break;
            if (track.type === "song") {
              recentSongs.push({
                title: track.title,
                artist: track.artist || "Desconocido",
              });
            }
          }
        }
      }
      return recentSongs;
    } catch {
      return [];
    }
  }

  /**
   * Gets the last 2 songs from the queue for context.
   */
  private async getLastTwoQueueSongs(
    queue: any[]
  ): Promise<{ title: string; artist: string }[]> {
    const songs: { title: string; artist: string }[] = [];
    const startIdx = Math.max(0, queue.length - 2);

    for (let i = startIdx; i < queue.length; i++) {
      try {
        const meta = await this.buncasterService.getRequestMetadata(queue[i].rid);
        if (meta.title) {
          songs.push({
            title: meta.title,
            artist: meta.artist || "Desconocido",
          });
        }
      } catch {}
    }
    return songs;
  }

  /**
   * Run the LLM agentic single-turn completion with native tool call loop (legacy Phase 1).
   */
  private async runAgentLoop(
    status: any,
    queue: any[],
    _lastSong: Track | null,
    activeLocutor?: any
  ): Promise<{ decisions: { selected_song_id: string; dj_script: string }[] } | null> {
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    const model = process.env.AI_DJ_OPENROUTER_MODEL || "google/gemini-2.5-flash";

    const djName = activeLocutor ? activeLocutor.name : "DJ Bloom";
    const personality = activeLocutor
      ? activeLocutor.personality
      : process.env.AI_DJ_PERSONALITY ||
        "Un locutor de radio fresco, enérgico y cercano al público de Radio Bloom. Cuenta curiosidades rápidas y hace comentarios ingeniosos.";

    const allSongs = this.libraryRepo.getAllTracks("song");
    const candidates = allSongs.filter((song) => !this.recentHistory.includes(song.id));
    const pool = candidates.length > 0 ? candidates : allSongs;
    const shuffled = [...pool].sort(() => 0.5 - Math.random());
    const subset = shuffled.slice(0, 15);
    const suggestedSongsText = subset
      .map((s) => `- ID: "${s.id}", Título: "${s.title}", Artista: "${s.artist || "Desconocido"}"`)
      .join("\n");

    const angles = [
      "comentar brevemente sobre el artista de la canción seleccionada o su trayectoria",
      "hacer una reflexión íntima, divertida o ingeniosa sobre el momento del día o la hora actual",
      "enfocarte en la vibra musical, la instrumentación o la textura sonora de la canción seleccionada",
      "lanzar un pensamiento filosófico de bolsillo o comentario existencial melómano",
      "conectar el final de la canción anterior con el inicio de la nueva a través de un puente puramente rítmico o de estado de ánimo",
    ];
    const selectedAngle = angles[Math.floor(Math.random() * angles.length)];

    const peruTime = new Date().toLocaleTimeString("es-PE", {
      timeZone: "America/Lima",
      hour: "numeric",
      minute: "2-digit",
    });

    const systemPrompt = `Eres "${djName}", el legendario, carismático y magnético locutor estrella de la emisora por internet 'Radio Bloom'.
Tu personalidad al aire es: ${personality}

La hora peruana actual de la emisora es: ${peruTime}. Usa esta hora para adecuar la vibra de tus locuciones (Mañana, Tarde, Noche/Madrugada).

Tu tarea es planificar un bloque continuo de las siguientes 5 canciones que se reproducirán en el stream, decidiendo si hablarás antes de cada una de ellas para hacer locución.

Directrices de Locución Radial para un Flujo Magnético y Carismático:
1. EVITA los saludos repetitivos. No empieces siempre diciendo "Hola" o "Bienvenidos a Radio Bloom". Entra directo a la idea, al gancho o al puente.
2. HAZ PUENTES (BRIDGING): Conecta el final de la canción anterior con la vibra, temática o detalles de la que está a punto de empezar.
3. TONO CARISMÁTICO Y CONVERSACIONAL: Cero gritos, cero hipérboles de "energía de radio comercial". Queremos intimidad, inteligencia, humor sutil and elegancia. Habla como un amigo melómano y sofisticado con el que te tomarías una copa a las 2 de la mañana.
4. ADAPTA TU VIBRA A LA HORA:
   - Mañana (06:00 - 12:00): Despertar amable, inteligente, ingenioso pero sin estridencias.
   - Tarde (12:00 - 20:00): Compañero de sintonía fluido, dinámico y relajado.
   - Noche/Madrugada (20:00 - 06:00): Cómplice noctámbulo, reflexivo, con voz pausada, cálida e íntima.
5. ESCRIBE PARA EL OÍDO: Usa frases cortas, preguntas retóricas, expresiones naturales. La puntuación determina cómo lee la voz (comas para pausas breves, puntos suspensivos para expectación).
6. LIMITACIÓN ESTRICTA DE PALABRAS: Si decides escribir un guión de locución ('dj_script'), este debe tener obligatoriamente entre 30 y 45 palabras. Debe ser conciso, memorable y sugerente. No incluyes acotaciones musicales ni hashtags.
7. FRECUENCIA DE LOCUCIÓN: No es necesario locutar antes de todas las canciones. Se recomienda locutar sólo en 1 o 2 de las 5 canciones de la cola (deja 'dj_script' vacío en las demás).
9. ENTREGAR RESULTADOS: Para entregar tu planificación final de 5 canciones, DEBES llamar obligatoriamente a la herramienta 'submit_decisions' con tus 5 decisiones estructuradas. No te limites a escribir el JSON en texto, utiliza la herramienta.`;

    const currentTrackText = status.title
      ? `"${status.title}" de ${status.artist || "Desconocido"}`
      : "Ninguna (silencio o transmisión en vivo)";
    const queuedTracksText =
      queue.length > 0 ? queue.map((q: any) => `"${q.title}"`).join(", ") : "Ninguna";

    const userPrompt = `INFORMACIÓN DEL ENTORNO:
- Hora local de la emisora (Perú): ${peruTime}
- Canción sonando actualmente: ${currentTrackText}
- Canciones en cola: ${queuedTracksText}

CANCIONES SUGERIDAS (puedes elegir uno de sus IDs directamente o usar la herramienta search_library para buscar otros):
${suggestedSongsText}

ÁNGULO CREATIVO PARA ESTA LOCUCIÓN (Obligatorio enfocarse en esto para no ser repetitivo en las locuciones que decidas escribir):
*En tus intervenciones debes: ${selectedAngle}*

Instrucción: Planifica el bloque de 5 canciones. Devuelve el resultado en el formato estructurado JSON.`;

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      ...this.dialogueHistory,
      { role: "user", content: userPrompt },
    ];

    const tools = [
      {
        type: "function",
        function: {
          name: "search_library",
          description:
            "Busca canciones en la biblioteca de la radio por texto (título, artista o álbum). Devuelve coincidencias con sus IDs.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Término de búsqueda textual (ej. 'Rick Astley').",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_library_stats",
          description:
            "Obtiene estadísticas generales sobre la biblioteca local (total de canciones y de interludios cargados).",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_stream_status",
          description:
            "Consulta qué canción está sonando actualmente y qué temas están ya en la cola de Buncaster.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_library_songs",
          description:
            "Obtiene una lista paginada de las canciones disponibles en la biblioteca de la radio (título, artista e ID). Úsala para conocer el catálogo musical antes de decidir.",
          parameters: {
            type: "object",
            properties: {
              limit: {
                type: "integer",
                description: "Cantidad de canciones a retornar (por defecto 50, máx 100).",
              },
              offset: {
                type: "integer",
                description: "Desplazamiento para paginación (por defecto 0).",
              },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "submit_decisions",
          description:
            "Envía la lista final con las 5 programaciones de canciones y sus guiones de locución (exactamente 5 elementos). Llama a esta herramienta obligatoriamente como tu último paso para finalizar la planificación.",
          parameters: {
            type: "object",
            properties: {
              decisions: {
                type: "array",
                description:
                  "Lista ordenada de exactamente 5 programaciones consecutivas para el stream.",
                items: {
                  type: "object",
                  properties: {
                    selected_song_id: {
                      type: "string",
                      description: "El ID real de la canción elegida de la biblioteca de música.",
                    },
                    dj_script: {
                      type: "string",
                      description:
                        "El guión completo en español para la locución radial del DJ (30-45 palabras), o string vacío si no toca locutar antes de esta canción.",
                    },
                  },
                  required: ["selected_song_id", "dj_script"],
                  additionalProperties: false,
                },
              },
            },
            required: ["decisions"],
            additionalProperties: false,
          },
        },
      },
    ];

    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "dj_batch_decision",
        strict: true,
        schema: {
          type: "object",
          properties: {
            decisions: {
              type: "array",
              description:
                "Lista ordenada de exactamente 5 programaciones consecutivas para el stream.",
              items: {
                type: "object",
                properties: {
                  selected_song_id: {
                    type: "string",
                    description: "El ID real de la canción elegida de la biblioteca de música.",
                  },
                  dj_script: {
                    type: "string",
                    description:
                      "El guión completo en español para la locución radial del DJ (30-45 palabras), o string vacío si no toca locutar antes de esta canción.",
                  },
                },
                required: ["selected_song_id", "dj_script"],
                additionalProperties: false,
              },
            },
          },
          required: ["decisions"],
          additionalProperties: false,
        },
      },
    };

    let finalDecisions: any[] | null = null;

    // Loop for tool calls (max 6 turns to avoid early cutoffs)
    for (let turn = 0; turn < 6; turn++) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          signal: AbortSignal.timeout(60000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/srsergi0/radio-bloom",
            "X-Title": "Radio Bloom",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            tools,
            response_format: responseFormat,
          }),
        });

        if (!res.ok) {
          throw new Error(`OpenRouter returned status ${res.status}: ${await res.text()}`);
        }

        const data = (await res.json()) as any;
        const message = data.choices?.[0]?.message;
        if (!message) return null;

        // If assistant wants to call tools natively
        if (message.tool_calls && message.tool_calls.length > 0) {
          messages.push(message);

          for (const call of message.tool_calls) {
            const name = call.function.name;
            const args = JSON.parse(call.function.arguments || "{}");
            console.log(`[OrchestratorService] Native agent tool call: ${name} with args:`, args);

            let toolResult = "";
            if (name === "submit_decisions") {
              finalDecisions = args.decisions || [];
              toolResult = JSON.stringify({ ok: true });
            } else {
              toolResult = await this.executeTool(name, args);
            }

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name,
              content: toolResult,
            });
          }

          if (finalDecisions) {
            return { decisions: finalDecisions };
          }
          continue; // Execute next turn
        }

        // If assistant returns final structured JSON response
        if (message.content) {
          const content = message.content.trim();
          console.log("[OrchestratorService] Native agent final response:", content);

          let jsonText = content;
          const firstBrace = content.indexOf("{");
          const lastBrace = content.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            jsonText = content.slice(firstBrace, lastBrace + 1);
          }

          const parsed = JSON.parse(jsonText);
          return {
            decisions: parsed.decisions || [],
          };
        }

        throw new Error("El modelo retornó una respuesta vacía sin llamadas a herramientas.");
      } catch (err: any) {
        console.error(`[OrchestratorService] Error in native agent turn ${turn}:`, err.message);
        break;
      }
    }

    return null;
  }

  /**
   * Executes one of the registered project-specific or weather tools.
   */
  private async executeTool(name: string, args: any): Promise<string> {
    try {
      switch (name) {
        case "search_library": {
          const query = args.query || "";
          const results = this.libraryRepo.search(query, 15);
          return JSON.stringify(
            results.items.map((s) => ({
              id: s.id,
              title: s.title,
              artist: s.artist || "Desconocido",
              album: s.album || "",
              file: s.file,
            }))
          );
        }
        case "get_library_songs": {
          const limit = Math.min(args.limit || 50, 100);
          const offset = args.offset || 0;
          const allSongs = this.libraryRepo.getAllTracks("song");
          const paginated = allSongs.slice(offset, offset + limit);
          return JSON.stringify(
            paginated.map((s) => ({
              id: s.id,
              title: s.title,
              artist: s.artist || "Desconocido",
              album: s.album || "",
            }))
          );
        }
        case "get_library_stats": {
          const totalSongs = this.libraryRepo.countTracks("song");
          const totalInterludes = this.libraryRepo.countTracks("interludio");
          return JSON.stringify({ totalSongs, totalInterludes });
        }
        case "get_stream_status": {
          const status = await this.buncasterService.getStreamStatus();
          const { items: queue } = await this.buncasterService.queueList();
          return JSON.stringify({
            playing: status.playing,
            currentTrack: status.title
              ? `"${status.title}" de ${status.artist || "Desconocido"}`
              : null,
            elapsed: status.elapsed,
            duration: status.duration,
            queue: queue.map((q) => q.title),
          });
        }
        default:
          return `Herramienta "${name}" no encontrada.`;
      }
    } catch (err: any) {
      return `Error ejecutando herramienta: ${err.message}`;
    }
  }

  /**
   * Synthesize script using Edge-TTS.
   */
  private async synthesizeSpeech(scriptText: string, voice?: string): Promise<string | null> {
    const activeVoice = voice || process.env.AI_DJ_VOICE || "es-ES-AlvaroNeural";
    try {
      const filename = `ai_dj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`;
      const interludiosDir = join(this.musicDir, "interludios");
      const localPath = join(interludiosDir, filename);

      const tts = new EdgeTTS(scriptText, activeVoice);
      const result = await tts.synthesize();
      const arrayBuffer = await result.audio.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fsPromises.writeFile(localPath, buffer);

      console.log(`[OrchestratorService] Voice synthesis completed: ${localPath}`);
      return localPath;
    } catch (err: any) {
      console.error("[OrchestratorService] Voice synthesis failed:", err.message);
      return null;
    }
  }
}
