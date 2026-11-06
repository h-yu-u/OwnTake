import type { TimelineDraft } from '../../contracts/src/index.ts';
import { captionInput } from '../../domain/src/validation.ts';

/** libass literal brace escapes; a word joiner prevents user backslashes becoming \N/\h. */
export function escapeAssText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\\{}\n\t]/g, character => {
    if (character === '\\') return '\\\u2060';
    if (character === '{') return '\\{';
    if (character === '}') return '\\}';
    if (character === '\n') return '\\N';
    return '    ';
  });
}
function timestamp(ms: number): string {
  const centiseconds = Math.round(ms / 10);
  const hours = Math.floor(centiseconds / 360_000), minutes = Math.floor(centiseconds / 6000) % 60, seconds = Math.floor(centiseconds / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}
const assColor = (hex: string): string => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;

export function compileCaptions(timeline: TimelineDraft, defaultFamily = 'sans-serif'): string {
  const totalMs = timeline.clips.reduce((sum, clip) => sum + Math.round(clip.durationMs * timeline.fps / 1000), 0) / timeline.fps * 1000;
  const captions = timeline.captions.map(c => captionInput(c, totalMs, timeline.fps));
  const margin = Math.max(6, Math.round(timeline.height * 0.04));
  const styles = captions.map((caption, i) => {
    const style = caption.style ?? {}, fontSize = style.fontSize ?? Math.max(12, Math.min(72, Math.round(timeline.height * 0.05)));
    const alignment = style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2;
    return `Style: C${i},${style.fontFamily ?? defaultFamily},${fontSize},${assColor(style.color ?? '#FFFFFF')},&H00000000,&H00181818,&H80000000,0,0,0,0,100,100,0,0,1,${Math.max(1, fontSize / 16).toFixed(2)},0,${alignment},${margin},${margin},${margin},1`;
  });
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${timeline.width}`, `PlayResY: ${timeline.height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles, '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...captions.map((caption, i) => `Dialogue: 0,${timestamp(caption.startMs)},${timestamp(caption.endMs)},C${i},,0,0,0,,${escapeAssText(caption.text)}`), '',
  ].join('\n');
}
