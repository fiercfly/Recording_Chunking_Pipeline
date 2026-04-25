"use client";

import { useCallback, useState } from "react";
import { CheckCircle2, Clock, Loader2, Mic, Play, Pause, Square, UploadCloud, Download } from "lucide-react";

import { Button } from "@my-better-t-app/ui/components/button";
import { Card, CardContent } from "@my-better-t-app/ui/components/card";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { useRecorder, type WavChunk } from "@/hooks/use-recorder";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: string }) {
  const config = {
    pending: { icon: <Clock className="size-3" />, label: "Buffering", color: "text-amber-500" },
    uploading: { icon: <Loader2 className="size-3 animate-spin" />, label: "Syncing", color: "text-blue-500" },
    acked: { icon: <CheckCircle2 className="size-3" />, label: "Secured", color: "text-emerald-500" },
    failed: { icon: <Clock className="size-3" />, label: "Retrying", color: "text-red-500" },
  } as const;

  const current = config[status as keyof typeof config] || config.pending;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${current.color}`}>
      {current.icon}
      {current.label}
    </span>
  );
}

function ChunkItem({ chunk, index }: { chunk: WavChunk; index: number }) {
  return (
    <div className="flex items-center justify-between rounded-xl border bg-card/40 backdrop-blur-sm px-4 py-3 shadow-sm">
      <div className="flex items-center gap-4">
        <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs">
          {index + 1}
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold">{chunk.duration.toFixed(1)}s segment</span>
          <span className="text-xs text-muted-foreground">{formatBytes(chunk.blob.size)}</span>
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        <StatusBadge status={chunk.uploadStatus} />
        
        <Button variant="ghost" size="icon" className="size-8 rounded-full" onClick={() => {
          const a = document.createElement("a");
          a.href = chunk.url;
          a.download = `chunk-${index + 1}.wav`;
          a.click();
        }}>
          <Download className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export default function RecorderPage() {
  const [playing, setPlaying] = useState(false);

  const {
    status,
    start,
    stop,
    pause,
    resume,
    chunks,
    elapsed,
    stream,
    uploadStats,
  } = useRecorder({ chunkDuration: 5 });

  const playRecordingLocally = async () => {
    if (playing) return;
    setPlaying(true);
    try {
      const sortedChunks = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
      for (const chunk of sortedChunks) {
        const audio = new Audio(chunk.url);
        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = reject;
          audio.play().catch(reject);
        });
      }
    } catch (err) {
      console.error("Local playback failed", err);
    } finally {
      setPlaying(false);
    }
  };

  const isActive = status === "recording" || status === "paused";

  const toggleRecording = useCallback(() => {
    if (isActive) stop();
    else start();
  }, [isActive, start, stop]);

  return (
    <div className="container mx-auto max-w-2xl px-4 py-12 flex flex-col items-center gap-8">
      
      {/* Main Recording Module */}
      <Card className="w-full border-2 border-primary/10 shadow-xl overflow-hidden rounded-3xl">
        <CardContent className="p-0">
          
          <div className="bg-primary/5 p-8 flex flex-col items-center border-b">
             <div className="w-full h-32 mb-6 rounded-2xl overflow-hidden bg-background/50 border backdrop-blur-sm">
                <LiveWaveform
                  active={status === "recording"}
                  processing={status === "paused"}
                  stream={stream}
                  height={128}
                  barWidth={4}
                  barGap={2}
                  mode="static"
                  fadeEdges
                />
             </div>
             
             <div className="font-mono text-5xl font-extrabold tabular-nums tracking-tight mb-2">
                {formatTime(elapsed)}
             </div>
             <p className="text-sm text-muted-foreground font-medium uppercase tracking-widest text-center">
                {status === "idle" ? "Ready to record" : status}
             </p>
          </div>

          <div className="p-6 flex items-center justify-center gap-4 bg-card">
            <Button
              onClick={toggleRecording}
              disabled={status === "requesting"}
              size="lg"
              className={`h-16 rounded-full px-8 text-lg font-bold shadow-md transition-all ${
                isActive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 w-40" : "w-48"
              }`}
            >
              {isActive ? (
                <><Square className="size-5 mr-2" fill="currentColor" /> Stop</>
              ) : (
                <><Mic className="size-5 mr-2" /> Start Recording</>
              )}
            </Button>

            {isActive && (
              <Button
                variant="secondary"
                size="icon"
                onClick={status === "paused" ? resume : pause}
                className="size-16 rounded-full shadow-sm"
              >
                {status === "paused" ? <Play className="size-6" fill="currentColor" /> : <Pause className="size-6" fill="currentColor" />}
              </Button>
            )}

            {!isActive && chunks.length > 0 && (
              <Button
                variant="outline"
                size="lg"
                onClick={playRecordingLocally}
                disabled={playing}
                className="h-16 rounded-full px-8 text-lg font-bold border-2 hover:bg-emerald-500/10 hover:text-emerald-600 transition-all"
              >
                {playing ? (
                  <><Loader2 className="size-5 mr-2 animate-spin" /> Playing...</>
                ) : (
                  <><Play className="size-5 mr-2 fill-current" /> Review Session</>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sync Status & Stream */}
      {chunks.length > 0 && (
        <div className="w-full space-y-4">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-lg font-bold flex items-center gap-2">
              <UploadCloud className="size-5 text-blue-500" />
              Live Pipeline Stream
            </h3>
            <span className="text-sm font-medium text-muted-foreground bg-muted px-3 py-1 rounded-full">
              {uploadStats.acked} / {uploadStats.total} Synced
            </span>
          </div>
          
          <div className="flex flex-col gap-3">
            {chunks.slice(-10).reverse().map((chunk) => (
              <ChunkItem key={chunk.id} chunk={chunk} index={chunk.chunkIndex} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
