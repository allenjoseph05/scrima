import { useCallback, useEffect, useRef, useState } from 'react';

interface VideoPlayerProps {
  src: string;
  maxHeight?: string;
  maxWidth?: string;
  autoPlay?: boolean;
  loop?: boolean;
  onError?: () => void;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export function VideoPlayer({
  src,
  maxHeight = '400px',
  maxWidth = '100%',
  autoPlay = false,
  loop = false,
  onError,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(autoPlay);
  const [speedIdx, setSpeedIdx] = useState(2); // 1x
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrent] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = SPEEDS[speedIdx];
  }, [speedIdx]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }, []);

  const cycleSpeed = useCallback(() => {
    setSpeedIdx((i) => (i + 1) % SPEEDS.length);
  }, []);

  const stepTime = useCallback((dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + dir * 5));
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.duration || isDragging) return;
    setProgress((v.currentTime / v.duration) * 100);
    setCurrent(v.currentTime);
  }, [isDragging]);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v) setDuration(v.duration);
  }, []);

  // Seek to a position based on mouse event relative to progress bar
  const seekToPosition = useCallback((clientX: number) => {
    const v = videoRef.current;
    const bar = progressBarRef.current;
    if (!v || !v.duration || !bar) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * v.duration;
    setProgress(ratio * 100);
    setCurrent(v.currentTime);
  }, []);

  // Drag handlers for progress bar
  const handleProgressMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(true);
      seekToPosition(e.clientX);
    },
    [seekToPosition],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      seekToPosition(e.clientX);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, seekToPosition]);

  const fmt = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div style={{ maxWidth }}>
      {/* Video container */}
      <div className="relative">
        <video
          ref={videoRef}
          src={src}
          autoPlay={autoPlay}
          loop={loop}
          muted={false}
          onClick={togglePlay}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => setBuffering(false)}
          onPlaying={() => setBuffering(false)}
          onError={onError}
          style={{
            maxHeight,
            maxWidth: '100%',
            width: '100%',
            objectFit: 'contain',
            display: 'block',
            background: '#000',
            cursor: 'pointer',
          }}
        />

        {/* Buffering spinner overlay */}
        {buffering && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ background: 'rgba(0, 0, 0, 0.4)' }}
          >
            <div
              className="w-10 h-10 border-3 border-t-transparent rounded-full animate-spin"
              style={{
                borderWidth: 3,
                borderColor: '#7C3AED',
                borderTopColor: 'transparent',
              }}
            />
          </div>
        )}
      </div>

      {/* Controls bar */}
      <div
        className="flex items-center gap-2 px-2 py-1.5"
        style={{ background: '#0A0E1A', borderTop: '1px solid #1A2440' }}
      >
        {/* Play/Pause */}
        <button
          type="button"
          onClick={togglePlay}
          className="p-1 transition-colors hover:brightness-125"
          style={{ color: '#A78BFA' }}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="2" y="1" width="3.5" height="12" rx="0.5" />
              <rect x="8.5" y="1" width="3.5" height="12" rx="0.5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <polygon points="2,1 12,7 2,13" />
            </svg>
          )}
        </button>

        {/* Step back 1 second */}
        <button
          type="button"
          onClick={() => stepTime(-1)}
          className="p-1 text-[10px] font-mono font-bold transition-colors hover:text-white"
          style={{ color: '#3D4F6E' }}
          title="Back 5 seconds"
        >
          {'<'}
        </button>

        {/* Step forward 1 second */}
        <button
          type="button"
          onClick={() => stepTime(1)}
          className="p-1 text-[10px] font-mono font-bold transition-colors hover:text-white"
          style={{ color: '#3D4F6E' }}
          title="Forward 5 seconds"
        >
          {'>'}
        </button>

        {/* Draggable progress bar */}
        <div
          ref={progressBarRef}
          className="flex-1 h-2 rounded-full cursor-pointer relative group"
          style={{ background: '#1A2440' }}
          onMouseDown={handleProgressMouseDown}
        >
          {/* Filled track */}
          <div
            className="h-full rounded-full pointer-events-none"
            style={{
              width: `${progress}%`,
              background: 'linear-gradient(90deg, #7C3AED, #00D4FF)',
              transition: isDragging ? 'none' : 'width 0.1s linear',
            }}
          />
          {/* Drag handle */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity"
            style={{
              left: `calc(${progress}% - 6px)`,
              background: '#E8EFFF',
              boxShadow: '0 0 6px #7C3AED',
            }}
          />
        </div>

        {/* Time */}
        <span
          className="text-[10px] font-mono"
          style={{ color: '#7A8BAD', minWidth: '65px', textAlign: 'center' }}
        >
          {fmt(currentTime)} / {fmt(duration)}
        </span>

        {/* Speed */}
        <button
          type="button"
          onClick={cycleSpeed}
          className="px-1.5 py-0.5 text-[10px] font-mono font-bold rounded transition-colors hover:border-[#2D4A6B]"
          style={{
            color: SPEEDS[speedIdx] === 1 ? '#3D4F6E' : '#00D4FF',
            border: '1px solid #1A2440',
          }}
          title="Playback speed"
        >
          {SPEEDS[speedIdx]}x
        </button>
      </div>
    </div>
  );
}
