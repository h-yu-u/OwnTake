/** Defaults for turning explicitly selected storyboard candidates into a timeline. */
export const TIMELINE_DEFAULTS = Object.freeze({
  fps: 24,
  sizes: Object.freeze({
    '16:9': [1280, 720] as const,
    '9:16': [720, 1280] as const,
    '1:1': [720, 720] as const,
  }),
});

/** Keep transport limits aligned with packages/domain timeline validation. */
export const TIMELINE_POLICY = Object.freeze({
  captionMaxCharacters: 2000,
  sourceDurationToleranceMs: 100,
  frameBoundaryEpsilonMs: 0.001,
});
