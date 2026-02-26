import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { api } from "./api";
import { useAudioCapture } from "./useAudioCapture";
import ReactMarkdown from "react-markdown";

// ─── Icons (inline SVG to avoid dependencies) ───
const Icon = ({ d, className = "w-4 h-4", ...props }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={className} {...props}>
    <path d={d} />
  </svg>
);

const MicIcon = (p) => <Icon {...p} d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />;
const MonitorIcon = (p) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={p.className || "w-4 h-4"}>
    <rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" />
  </svg>
);
const PauseIcon = (p) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={p.className || "w-4 h-4"}>
    <rect width="4" height="16" x="6" y="4" /><rect width="4" height="16" x="14" y="4" />
  </svg>
);
const PlayIcon = (p) => <Icon {...p} d="m5 3 14 9-14 9V3z" />;
const StopIcon = (p) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={p.className || "w-4 h-4"}>
    <rect width="14" height="14" x="5" y="5" rx="1" />
  </svg>
);
const ZapIcon = (p) => <Icon {...p} d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />;
const ChevronDown = (p) => <Icon {...p} d="m6 9 6 6 6-6" />;
const ChevronUp = (p) => <Icon {...p} d="m18 15-6-6-6 6" />;
const Loader = ({ className }) => (
  <svg className={`animate-spin ${className || "w-4 h-4"}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

// ─── QA Card ───
function QACard({ qa, expanded, onToggle }) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-card transition-all hover:border-white/[0.15]">
      <button onClick={onToggle} className="w-full flex items-start gap-3 p-3 text-left">
        <div className="shrink-0 mt-0.5 w-6 h-6 rounded-md bg-[hsl(160,70%,45%)]/10 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="hsl(160,70%,45%)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed">{qa.question}</p>
          <div className="flex items-center gap-2 mt-1.5">
            {qa.processingTimeMs && (
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                {(qa.processingTimeMs / 1000).toFixed(1)}s
              </span>
            )}
            <span className="text-[10px] text-muted-foreground/40">
              {new Date(qa.timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        </div>
        <div className="shrink-0 mt-1 text-muted-foreground">
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </div>
      </button>
      {expanded && (
        <>
          <div className="border-t border-white/[0.08]" />
          <div className="p-3 pl-12">
            <div className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed">
              <ReactMarkdown>{qa.answer}</ReactMarkdown>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main App ───
export default function App() {
  const [sessionId, setSessionId] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [qaPairs, setQaPairs] = useState([]);
  const [currentTranscription, setCurrentTranscription] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedQA, setExpandedQA] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [audioSource, setAudioSource] = useState("microphone");
  const [starting, setStarting] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);

  const qaIdCounter = useRef(0);
  const scrollRef = useRef(null);
  const timerRef = useRef(null);
  const sessionStartRef = useRef(0);

  // Toast auto-dismiss
  useEffect(() => {
    if (toastMsg) {
      const t = setTimeout(() => setToastMsg(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toastMsg]);

  // Audio chunk handler
  const handleAudioChunk = useCallback(async (audioBase64, mimeType) => {
    if (!sessionActive) return;
    setIsTranscribing(true);
    try {
      const result = await api.transcribe(audioBase64, mimeType, "pt");
      if (!result.text || result.text.trim().length < 3) {
        setIsTranscribing(false);
        return;
      }
      const question = result.text.trim();
      setCurrentTranscription(question);
      setIsTranscribing(false);
      setIsGenerating(true);

      const previousQAs = qaPairs.slice(-5).map((qa) => ({ question: qa.question, answer: qa.answer }));
      const aiResult = await api.answer(question, sessionId, previousQAs);

      const newQA = {
        id: ++qaIdCounter.current,
        question,
        answer: aiResult.answer,
        processingTimeMs: aiResult.processingTimeMs,
        timestamp: Date.now(),
      };
      setQaPairs((prev) => [...prev, newQA]);
      setExpandedQA(newQA.id);
      setCurrentTranscription("");
      setIsGenerating(false);
    } catch (err) {
      console.error("Processing error:", err);
      setIsTranscribing(false);
      setIsGenerating(false);
      if (err?.message && !err.message.includes("empty")) {
        setToastMsg(err.message.slice(0, 100));
      }
    }
  }, [sessionActive, sessionId, qaPairs]);

  const { status: captureStatus, error: captureError, startRecording, pause, resume, stop } =
    useAudioCapture({ chunkIntervalMs: 10000, onChunk: handleAudioChunk });

  // Timer
  useEffect(() => {
    if (sessionActive && captureStatus === "recording") {
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - sessionStartRef.current) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [sessionActive, captureStatus]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [qaPairs, currentTranscription, isGenerating]);

  const handleStart = useCallback(async (source) => {
    try {
      setStarting(true);
      setAudioSource(source);
      const session = await api.createSession();
      setSessionId(session.id);
      setSessionActive(true);
      setQaPairs([]);
      setElapsedTime(0);
      sessionStartRef.current = Date.now();
      qaIdCounter.current = 0;
      await startRecording(source);
    } catch (err) {
      setToastMsg(err.message);
    } finally {
      setStarting(false);
    }
  }, [startRecording]);

  const handleStop = useCallback(async () => {
    stop();
    setSessionActive(false);
    if (sessionId) {
      try { await api.endSession(sessionId, qaPairs.length); } catch (e) { console.warn(e); }
    }
  }, [stop, sessionId, qaPairs.length]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  const statusConfig = useMemo(() => {
    if (!sessionActive) return { label: "Pronto", color: "bg-gray-500", pulse: false };
    if (isGenerating) return { label: "Gerando resposta...", color: "bg-amber-500", pulse: true };
    if (isTranscribing) return { label: "Transcrevendo...", color: "bg-blue-500", pulse: true };
    if (captureStatus === "recording") return { label: "Gravando", color: "bg-emerald-500", pulse: true };
    if (captureStatus === "paused") return { label: "Pausado", color: "bg-amber-500", pulse: false };
    return { label: "Pronto", color: "bg-gray-500", pulse: false };
  }, [sessionActive, isGenerating, isTranscribing, captureStatus]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b border-white/[0.06] bg-card/50 backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 py-3 max-w-5xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <ZapIcon className="w-5 h-5 text-[hsl(160,70%,45%)]" />
              <h1 className="text-sm font-semibold tracking-tight">Interview Agent</h1>
            </div>
            <div className="w-px h-4 bg-white/10" />
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${statusConfig.color} ${statusConfig.pulse ? "animate-pulse-ring" : ""}`} />
              <span className="text-xs text-muted-foreground">{statusConfig.label}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {sessionActive && (
              <span className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                {formatTime(elapsedTime)}
              </span>
            )}
            {sessionActive && (
              <span className="text-xs font-mono bg-secondary px-2 py-0.5 rounded flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                {qaPairs.length}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 overflow-hidden">
        {!sessionActive ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-8 max-w-md px-4">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-16 h-16 rounded-2xl bg-[hsl(160,70%,45%)]/10 flex items-center justify-center">
                  <ZapIcon className="w-8 h-8 text-[hsl(160,70%,45%)]" />
                </div>
                <h2 className="text-xl font-semibold">Assistente de Entrevista</h2>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Captura o áudio da entrevista, transcreve as perguntas e gera respostas técnicas de Engenharia de Dados em tempo real.
                </p>
              </div>
              <div className="flex flex-col gap-3 w-full">
                <button
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[hsl(160,70%,45%)] text-[hsl(160,70%,8%)] font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                  onClick={() => handleStart("microphone")}
                  disabled={starting}
                >
                  {starting ? <Loader /> : <MicIcon />}
                  Iniciar com Microfone
                </button>
                <button
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-white/[0.1] bg-secondary/50 text-foreground font-medium text-sm hover:bg-secondary transition-colors disabled:opacity-50"
                  onClick={() => handleStart("system")}
                  disabled={starting}
                >
                  {starting ? <Loader /> : <MonitorIcon />}
                  Iniciar com Áudio do Sistema
                </button>
              </div>
              <p className="text-xs text-muted-foreground/60 text-center">
                O áudio do sistema captura o que sai dos alto-falantes (ex: Zoom, Meet).<br />
                O microfone captura o áudio ambiente.
              </p>
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col max-w-5xl mx-auto">
            {/* Q&A Feed */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div className="flex flex-col gap-3 p-4">
                {qaPairs.length === 0 && !currentTranscription && !isTranscribing && !isGenerating && (
                  <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/50">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-10 h-10 mb-3 opacity-30"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>
                    <p className="text-sm">Aguardando perguntas...</p>
                    <p className="text-xs mt-1">
                      {audioSource === "system" ? "Capturando áudio do sistema" : "Capturando áudio do microfone"}
                    </p>
                  </div>
                )}

                {qaPairs.map((qa) => (
                  <QACard key={qa.id} qa={qa} expanded={expandedQA === qa.id}
                    onToggle={() => setExpandedQA(expandedQA === qa.id ? null : qa.id)} />
                ))}

                {(isTranscribing || currentTranscription || isGenerating) && (
                  <div className="rounded-lg border border-[hsl(160,70%,45%)]/20 bg-[hsl(160,70%,45%)]/5 p-4">
                    {isTranscribing && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader className="w-3.5 h-3.5 text-blue-400" />
                        <span>Transcrevendo áudio...</span>
                      </div>
                    )}
                    {currentTranscription && (
                      <div className="mb-3">
                        <p className="text-xs font-medium text-[hsl(160,70%,45%)]/70 mb-1">PERGUNTA DETECTADA</p>
                        <p className="text-sm">{currentTranscription}</p>
                      </div>
                    )}
                    {isGenerating && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader className="w-3.5 h-3.5 text-amber-400" />
                        <span>Gerando resposta...</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="shrink-0 border-t border-white/[0.06] bg-card/50 backdrop-blur-sm">
              <div className="flex items-center justify-center gap-2 px-4 py-3">
                {captureStatus === "recording" && (
                  <button onClick={pause}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.1] text-sm hover:bg-secondary transition-colors">
                    <PauseIcon className="w-3.5 h-3.5" /> Pausar
                  </button>
                )}
                {captureStatus === "paused" && (
                  <button onClick={resume}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/[0.1] text-sm hover:bg-secondary transition-colors">
                    <PlayIcon className="w-3.5 h-3.5" /> Retomar
                  </button>
                )}
                <button onClick={handleStop}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600/80 text-white text-sm hover:bg-red-600 transition-colors">
                  <StopIcon className="w-3.5 h-3.5" /> Encerrar
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Error/Toast */}
      {(captureError || toastMsg) && (
        <div className="fixed bottom-4 left-4 right-4 max-w-md mx-auto bg-red-900/40 border border-red-500/30 rounded-lg p-3 text-sm text-red-300 z-50">
          {captureError || toastMsg}
        </div>
      )}
    </div>
  );
}
