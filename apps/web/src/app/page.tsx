"use client";

import { useEffect, useState } from "react";
import { Mic, CirclePlay, Play, Loader2 } from "lucide-react";
import Link from "next/link";

import { Button } from "@my-better-t-app/ui/components/button";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

interface Recording {
  id: string;
  status: string;
  totalChunks: number | null;
  totalDuration: number | null;
  createdAt: string;
}

export default function Home() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const playRecording = async (recordingId: string) => {
    if (playingId) return;
    setPlayingId(recordingId);
    
    try {
      const res = await fetch(`${SERVER_URL}/api/chunks/by-recording/${recordingId}`);
      const chunks = await res.json();
      
      for (const chunk of chunks) {
        const audio = new Audio(`${SERVER_URL}/api/chunks/download/${chunk.id}`);
        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = reject;
          audio.play().catch(reject);
        });
      }
    } catch (err) {
      console.error("Playback failed", err);
    } finally {
      setPlayingId(null);
    }
  };

  useEffect(() => {
    fetch(`${SERVER_URL}/api/recordings`)
      .then((res) => res.json())
      .then((data: Recording[]) => setRecordings(data))
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] px-4">
      {/* Hero Section */}
      <div className="max-w-xl text-center space-y-6">
        <div className="inline-flex items-center justify-center p-3 sm:p-4 rounded-3xl bg-blue-500/10 text-blue-600 mb-2">
          <Mic className="size-8 sm:size-12" />
        </div>
        
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-foreground">
          Reliable Audio Pipeline
        </h1>
        
        <p className="text-lg text-muted-foreground leading-relaxed">
          A production-grade chunking recorder displaying fault-tolerant OPFS buffers and zero-loss upload syncing.
        </p>

        <Link href="/recorder" className="inline-block mt-4">
          <Button size="lg" className="h-14 px-8 text-lg rounded-full font-semibold shadow-lg hover:shadow-xl transition-all">
            <CirclePlay className="size-5 mr-2" />
            Start Recording
          </Button>
        </Link>
      </div>

      {/* Simplified Recent Recordings */}
      {recordings.length > 0 && (
        <div className="mt-20 w-full max-w-md">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 text-center">
            Recent Sessions
          </h3>
          <div className="space-y-2">
            {recordings.slice(0, 5).map((rec) => (
              <div
                key={rec.id}
                className="flex items-center justify-between p-4 rounded-xl border bg-card/50 backdrop-blur-sm"
              >
                <div className="flex items-center gap-3">
                  <div className={`size-2.5 rounded-full ${rec.status === "completed" ? "bg-emerald-500" : "bg-blue-500 animate-pulse"}`} />
                  <span className="font-mono text-sm font-medium">{rec.id.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-2">
                  {rec.totalDuration && (
                    <span className="text-xs text-muted-foreground mr-2">
                      {rec.totalDuration.toFixed(1)}s
                    </span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 rounded-full hover:bg-emerald-500/10 hover:text-emerald-600"
                    onClick={() => playRecording(rec.id)}
                    disabled={playingId !== null || rec.status !== "completed"}
                  >
                    {playingId === rec.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4 fill-current" />
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
