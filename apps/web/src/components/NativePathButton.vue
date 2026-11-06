<script setup lang="ts">
import { ref } from 'vue';
import { NButton, useMessage } from 'naive-ui';
import type { DesktopPathKind } from '../types.ts';
import { desktopApi, desktopBridge } from '../lib/desktop.ts';
import { errorMessage } from '../lib/api.ts';
import AppIcon from './AppIcon.vue';
const props = defineProps<{ kind: DesktopPathKind; label: string; disabled: boolean }>();
const emit = defineEmits<{ select: [path: string] }>();
const available = Boolean(desktopBridge());
const selecting = ref(false);
const message = useMessage();
async function choose() {
  if (props.disabled || selecting.value) return;
  selecting.value = true;
  try { const path = await desktopApi.choosePath(props.kind); if (path !== null) emit('select', path); }
  catch (error) { message.error(errorMessage(error), { duration: 8000 }); }
  finally { selecting.value = false; }
}
</script>
<template><NButton v-if="available" class="native-path-button" :aria-label="label" :disabled="disabled || selecting" :loading="selecting" @click="choose"><template #icon><AppIcon name="folder" :size="16" /></template>选择文件</NButton></template>
