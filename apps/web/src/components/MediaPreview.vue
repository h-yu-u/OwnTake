<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NImage } from 'naive-ui';
import type { ImageInst } from 'naive-ui';
import type { Artifact } from '../types.ts';
import { artifactUrl, thumbnailUrl } from '../lib/api.ts';
import { formatBytes, formatDuration } from '../lib/timeline.ts';
import AppIcon from './AppIcon.vue';
const props = defineProps<{ artifact: Artifact | null; compact?: boolean }>();
const failed = ref(false);
const imagePreview = ref<ImageInst | null>(null);
watch(() => props.artifact?.id, () => { failed.value = false; });
</script>
<template>
  <div class="media-preview" :class="{ compact }">
    <template v-if="artifact && !failed">
      <template v-if="artifact.kind === 'image'">
        <NImage :key="artifact.id" ref="imagePreview" class="media-preview-image" :src="artifactUrl(artifact.id)" :alt="artifact.name" object-fit="contain" show-toolbar-tooltip @error="failed = true" />
        <NButton class="media-preview-expand" size="small" :aria-label="`放大查看 ${artifact.name}`" @click="imagePreview?.showPreview()">放大查看</NButton>
      </template>
      <video v-else-if="artifact.kind === 'video'" :key="artifact.id" :src="artifactUrl(artifact.id)" :poster="thumbnailUrl(artifact.id)" controls preload="metadata" playsinline @error="failed = true" />
      <div v-else class="audio-preview"><AppIcon name="audio" :size="64" /><span>{{ artifact.name }}</span><audio :key="artifact.id" :src="artifactUrl(artifact.id)" controls preload="metadata" @error="failed = true" /></div>
    </template>
    <div v-else class="preview-placeholder"><AppIcon :name="failed ? 'refresh' : 'film'" :size="40" /><strong>{{ failed ? '浏览器暂时无法预览此素材' : '为你的故事放入第一帧' }}</strong><p>{{ failed ? '检查文件是否仍可访问，或下载后用本地播放器检查。' : '导入图片或视频，选择素材开始预览。' }}</p><a v-if="artifact" :href="artifactUrl(artifact.id)" :download="artifact.name">下载素材检查</a></div>
  </div>
  <div v-if="artifact && !compact" class="media-info"><strong :title="artifact.name">{{ artifact.name }}</strong><span>{{ artifact.media.width ? `${artifact.media.width} × ${artifact.media.height}` : '音频' }} · {{ artifact.kind === 'image' ? formatBytes(artifact.sizeBytes) : formatDuration(artifact.media.durationMs) }}</span></div>
</template>
