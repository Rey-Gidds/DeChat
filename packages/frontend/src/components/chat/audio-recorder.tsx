"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2, Send, Check } from "lucide-react";
import { toast } from "sonner";

interface AudioRecorderProps {
  onRecordingComplete: (blob: Blob, duration: number) => void;
  onCancel: () => void;
}

export function AudioRecorder({
  onRecordingComplete,
  onCancel,
}: AudioRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioLevel, setAudioLevel] = useState(1);
  const isDiscardedref = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    // `cancelled` guards against React StrictMode's mount→cleanup→mount cycle
    // (and any early unmount). getUserMedia is async, so the first mount's
    // cleanup runs before its permission promise resolves; without this flag
    // BOTH invocations would create a MediaRecorder and push fragments into the
    // shared chunksRef, producing doubled/echoey audio.
    let cancelled = false;
    startRecording(() => cancelled);
    return () => {
      cancelled = true;
      cleanupRecording();
    };
  }, []);

  const startRecording = async (isCancelled: () => boolean = () => false) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // If this effect invocation was superseded (StrictMode remount) or the
      // component unmounted while awaiting mic permission, discard this stream
      // so we never run two concurrent recorders against one chunk buffer.
      if (isCancelled()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      startTimeRef.current = Date.now();

      // Determine codec support
      let options = {};
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        options = { mimeType: "audio/webm;codecs=opus" };
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        options = { mimeType: "audio/mp4" };
      }

      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        if(isDiscardedref.current) return;
        const audioBlob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const finalDuration = (Date.now() - startTimeRef.current) / 1000;
        if (finalDuration > 0.5) {
          onRecordingComplete(audioBlob, finalDuration);
        } else {
          toast.error("Audio recording is too short.");
          onCancel();
        }
      };

      // Set up simple audio analyzer for dynamic visualizer
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateVisualizer = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        setAudioLevel(Math.max(1, (average / 128) * 100)); // Normalize
        animationFrameRef.current = requestAnimationFrame(updateVisualizer);
      };
      updateVisualizer();

      recorder.start(250); // Slice every 250ms
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);

    } catch (err) {
      console.error("Microphone access denied or error: ", err);
      toast.error("Could not access microphone.");
      onCancel();
    }
  };

  const cleanupRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
    }

    analyserRef.current = null;
    audioContextRef.current = null;
    mediaRecorderRef.current = null;
    streamRef.current = null;
  };

  const stopAndSend = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      cleanupRecording();
    }
  };

  const cancelRecording = () => {
    isDiscardedref.current = true;
    if(mediaRecorderRef.current){
      mediaRecorderRef.current.onstop = null;
    }
    cleanupRecording();
    onCancel();
  };

  const formatTimer = (secs: number) => {
    const min = Math.floor(secs / 60);
    const sec = secs % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex items-center space-x-3 bg-neutral-900 border border-neutral-800 rounded-lg py-2 px-4 w-full justify-between backdrop-blur-md shadow-md animate-in fade-in slide-in-from-bottom-2 duration-150">
      <div className="flex items-center space-x-3 flex-1 min-w-0">
        <div className="relative flex items-center justify-center shrink-0">
          {/* Animated pulses representing microphone input level */}
          <div
            className="absolute rounded-full bg-emerald-500/20 transition-all duration-75"
            style={{
              width: `${32 + audioLevel * 0.4}px`,
              height: `${32 + audioLevel * 0.4}px`,
            }}
          />
          <div className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center text-white z-10 animate-pulse">
            <Mic size={16} />
          </div>
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-semibold text-neutral-200">Recording audio...</span>
          <span className="text-[10px] text-neutral-400 font-medium">{formatTimer(duration)}</span>
        </div>
      </div>

      <div className="flex items-center space-x-2 shrink-0">
        <button
          onClick={cancelRecording}
          className="p-2 rounded-full hover:bg-neutral-800 text-neutral-400 hover:text-red-500 transition-colors"
          title="Delete Recording"
        >
          <Trash2 size={16} />
        </button>
        <button
          onClick={stopAndSend}
          className="p-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          title="Send Recording"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
