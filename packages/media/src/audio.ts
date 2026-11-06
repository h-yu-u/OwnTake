import type { AudioTrack } from '../../contracts/src/index.ts';
import type { MediaInput } from './probe.ts';
export interface PreparedAudio { track: AudioTrack; input: MediaInput; durationMs: number }
const seconds = (ms: number): string => (ms / 1000).toFixed(6);

/** Only validated numeric values and host-generated stream labels enter the graph. */
export function compileAudioMix(tracks: PreparedAudio[], totalMs: number): string {
  const filters = [`[0:a:0]aresample=48000,asetpts=PTS-STARTPTS[base]`];
  for (let i = 0; i < tracks.length; i += 1) {
    const { track, durationMs } = tracks[i]!;
    const steps = [`aresample=48000`, `atrim=duration=${seconds(durationMs)}`, 'asetpts=PTS-STARTPTS', `volume=${track.gainDb.toFixed(6)}dB`];
    if (track.fadeInMs) steps.push(`afade=t=in:st=0:d=${seconds(track.fadeInMs)}`);
    if (track.fadeOutMs) steps.push(`afade=t=out:st=${seconds(durationMs - track.fadeOutMs)}:d=${seconds(track.fadeOutMs)}`);
    steps.push(`adelay=${track.startMs}:all=1`);
    filters.push(`[${i + 1}:a:0]${steps.join(',')}[track${i}]`);
  }
  const inputs = '[base]' + tracks.map((_, i) => `[track${i}]`).join('');
  // No auto-normalisation: user gain remains meaningful. Compensate limiter lookahead.
  filters.push(`${inputs}amix=inputs=${tracks.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad,atrim=duration=${seconds(totalMs)},asetpts=PTS-STARTPTS[mixed]`);
  return filters.join(';');
}
