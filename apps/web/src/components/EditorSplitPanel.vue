<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
const props = defineProps<{ items: Array<{ key: string; label: string; detail: string }>; selected: number; label: string }>();
const list = ref<HTMLElement | null>(null);
watch(() => [props.selected, props.items.length], async () => {
  await nextTick();
  const container = list.value, button = container?.querySelector<HTMLElement>('.editor-item.selected');
  if (!container || !button) return;
  if (button.offsetTop < container.scrollTop) container.scrollTop = button.offsetTop;
  else if (button.offsetTop + button.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = button.offsetTop + button.offsetHeight - container.clientHeight;
});
const emit = defineEmits<{ select: [index: number] }>();
</script>
<template>
  <div class="editor-split-panel">
    <div ref="list" class="editor-item-list" :aria-label="label" tabindex="0"><button v-for="(item, index) in items" :key="item.key" class="editor-item" :class="{ selected: selected === index }" :aria-pressed="selected === index" @click="emit('select', index)"><span class="editor-item-number">{{ String(index + 1).padStart(2, '0') }}</span><span class="editor-item-copy"><strong :title="item.label">{{ item.label }}</strong><small>{{ item.detail }}</small></span></button></div>
    <div class="editor-item-inspector" tabindex="0" aria-label="当前条目设置"><slot /></div>
  </div>
</template>
