export const MEDIA_UPLOAD = Object.freeze({
  contentType: 'application/octet-stream',
  filenameMaxLength: 200,
  minimumFreeBytes: 1024 * 1024,
  extensions: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'] as readonly string[],
});
