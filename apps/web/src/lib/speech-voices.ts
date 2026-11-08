// Chinese listening/use-case hints are editorial labels, not official voice metadata.
const descriptions: Record<string, string> = {
  coral: '温柔女声 · 亲切讲述',
  alloy: '中性音色 · 通用旁白',
  ash: '沉稳男声 · 纪录解说',
  ballad: '柔和男声 · 故事讲述',
  echo: '清晰男声 · 知识解说',
  fable: '生动音色 · 角色叙事',
  nova: '明亮女声 · 活力口播',
  onyx: '低沉男声 · 新闻播报',
  sage: '舒缓音色 · 轻声讲述',
  shimmer: '轻柔女声 · 情感旁白',
  verse: '灵动音色 · 对话演绎',
  marin: '清澈音色 · 自然讲述',
  cedar: '浑厚音色 · 沉稳旁白',
};

/** Preserve the connection's exact voice IDs and order, including custom voices. */
export function speechVoiceOptions(voices: readonly string[]): { label: string; value: string }[] {
  return voices.map(value => ({ value, label: Object.hasOwn(descriptions, value) ? `${descriptions[value]} · ${value}` : value }));
}
