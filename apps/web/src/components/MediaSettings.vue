<script setup lang="ts">
import { reactive, watch } from 'vue';
import { NAlert, NButton, NForm, NFormItem, NInput, NTag } from 'naive-ui';
import type { AppSettings, Health } from '../types.ts';
import AppIcon from './AppIcon.vue';
import NativePathButton from './NativePathButton.vue';

const props = defineProps<{ settings: AppSettings; health: Health | null; disabled: boolean; saving: boolean; checking: boolean }>();
const emit = defineEmits<{ save: [input: AppSettings]; check: [] }>();
const form = reactive({ ...props.settings, subtitleFontPath: props.settings.subtitleFontPath || '' });
watch(() => props.settings, settings => { Object.assign(form, { ...settings, subtitleFontPath: settings.subtitleFontPath || '' }); });
function submit() {
  if (form.ffmpegPath.trim() && form.ffprobePath.trim()) emit('save', {
    ffmpegPath: form.ffmpegPath.trim(), ffprobePath: form.ffprobePath.trim(), subtitleFontPath: form.subtitleFontPath.trim(),
  });
}
</script>

<template>
  <section class="panel settings-card media-settings">
    <div class="panel-heading">
      <div class="heading-line"><h2>媒体工具</h2><NTag :bordered="false" :type="health?.status === 'ok' ? 'success' : 'warning'">{{ health?.status === 'ok' ? '工具就绪' : '需要检查' }}</NTag></div>
      <NButton :loading="checking" :disabled="disabled" @click="emit('check')"><template #icon><AppIcon name="refresh" :size="16" /></template>重新检测</NButton>
    </div>
    <p class="settings-description">使用已安装的 FFmpeg 和 ffprobe。可以填写命令名称，或可执行文件的完整路径。</p>
    <NForm @submit.prevent="submit">
      <NFormItem label="FFmpeg 可执行文件" label-for="ffmpeg-path">
        <div class="native-path-field"><NInput :input-props="{ id: 'ffmpeg-path', 'aria-label': 'FFmpeg 可执行文件' }" v-model:value="form.ffmpegPath" placeholder="ffmpeg" :disabled="disabled" /><NativePathButton kind="ffmpeg" label="选择FFmpeg 可执行文件" :disabled="disabled" @select="form.ffmpegPath = $event" /></div>
      </NFormItem>
      <NFormItem label="ffprobe 可执行文件" label-for="ffprobe-path">
        <div class="native-path-field"><NInput :input-props="{ id: 'ffprobe-path', 'aria-label': 'ffprobe 可执行文件' }" v-model:value="form.ffprobePath" placeholder="ffprobe" :disabled="disabled" /><NativePathButton kind="ffprobe" label="选择ffprobe 可执行文件" :disabled="disabled" @select="form.ffprobePath = $event" /></div>
      </NFormItem>
      <NFormItem label="字幕字体文件（可选，绝对路径）" label-for="subtitle-font-path">
        <div class="native-path-field"><NInput :input-props="{ id: 'subtitle-font-path', 'aria-label': '字幕字体文件' }" v-model:value="form.subtitleFontPath" placeholder="例如 /path/to/NotoSansCJK-Regular.ttc" :disabled="disabled" /><NativePathButton kind="font" label="选择字幕字体文件" :disabled="disabled" @select="form.subtitleFontPath = $event" /></div>
      </NFormItem>
      <p class="form-note">留空使用系统字体。中文与其他字符覆盖取决于选定字体，请在导出后检查；修改此设置不会发起模型请求。</p>
      <NButton type="primary" attr-type="submit" :loading="saving" :disabled="disabled || !form.ffmpegPath.trim() || !form.ffprobePath.trim()">保存并检测</NButton>
    </NForm>
    <div v-if="health" class="tool-results">
      <article v-for="tool in [{ name: 'FFmpeg', value: health.ffmpeg }, { name: 'ffprobe', value: health.ffprobe }]" :key="tool.name" class="tool-result">
        <div class="heading-line"><span class="status-dot" :class="{ unavailable: !tool.value.available }"></span><strong>{{ tool.name }}</strong><span class="muted small">{{ tool.value.available ? '可用' : '不可用' }}</span></div>
        <code>{{ tool.value.path }}</code>
        <p v-if="tool.value.version" class="small muted">{{ tool.value.version }}</p>
        <p v-if="tool.value.capabilities" class="small muted">字幕渲染：{{ tool.value.capabilities.subtitles ? '支持' : '不支持，请选择带 libass 的完整 FFmpeg' }}</p>
        <NAlert v-if="tool.value.error" type="error" :show-icon="false">{{ tool.value.error }}</NAlert>
      </article>
    </div>
  </section>
</template>
