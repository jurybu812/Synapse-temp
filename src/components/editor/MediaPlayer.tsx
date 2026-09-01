import { Play, Pause, Volume2, VolumeX, Maximize2 } from 'lucide-react';
import { useState, useRef, useCallback } from 'react';

interface MediaPlayerProps {
  src: string;
  fileName: string;
  type: 'video' | 'audio';
}

export function MediaPlayer({ src, fileName, type }: MediaPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  const togglePlay = useCallback(() => {
    if (!mediaRef.current) return;
    if (isPlaying) mediaRef.current.pause();
    else mediaRef.current.play();
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  const toggleMute = useCallback(() => {
    if (!mediaRef.current) return;
    mediaRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  }, [isMuted]);

  const handleTimeUpdate = useCallback(() => {
    if (!mediaRef.current) return;
    const pct = (mediaRef.current.currentTime / mediaRef.current.duration) * 100;
    setProgress(isNaN(pct) ? 0 : pct);
  }, []);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!mediaRef.current) return;
    const pct = Number(e.target.value);
    mediaRef.current.currentTime = (pct / 100) * mediaRef.current.duration;
    setProgress(pct);
  }, []);

  const changeSpeed = useCallback(() => {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(playbackRate);
    const next = speeds[(idx + 1) % speeds.length];
    setPlaybackRate(next);
    if (mediaRef.current) mediaRef.current.playbackRate = next;
  }, [playbackRate]);

  const MediaTag = type === 'video' ? 'video' : 'audio';

  return (
    <div className="media-player">
      <div className="viewer-toolbar">
        <span className="viewer-filename">{fileName}</span>
      </div>
      <div className="media-content">
        <MediaTag
          ref={mediaRef as any}
          src={src}
          onTimeUpdate={handleTimeUpdate}
          onEnded={() => setIsPlaying(false)}
          className={type === 'video' ? 'media-video' : 'media-audio'}
        />
      </div>
      <div className="media-controls">
        <button onClick={togglePlay} title={isPlaying ? '暂停' : '播放'}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <input
          type="range"
          min="0"
          max="100"
          step="0.1"
          value={progress}
          onChange={handleSeek}
          className="media-progress"
        />
        <button onClick={toggleMute} title={isMuted ? '取消静音' : '静音'}>
          {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        <button onClick={changeSpeed} className="speed-btn" title="倍速">
          {playbackRate}x
        </button>
        {type === 'video' && (
          <button title="全屏" onClick={() => mediaRef.current?.requestFullscreen()}>
            <Maximize2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
