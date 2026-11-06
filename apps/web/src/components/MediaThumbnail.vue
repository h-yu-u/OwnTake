<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Artifact } from '../types.ts';
import { artifactUrl, thumbnailUrl } from '../lib/api.ts';
import AppIcon from './AppIcon.vue';
const props = defineProps<{ artifact?: Artifact }>();
const failed = ref(false);
const url = computed(() => props.artifact?.kind === 'video' ? thumbnailUrl(props.artifact.id) : props.artifact?.kind === 'image' ? artifactUrl(props.artifact.id) : null);
watch(() => props.artifact?.id, () => { failed.value = false; });
</script>
<template>
  <img v-if="url && !failed" :src="url" alt="" loading="lazy" @error="failed = true" />
  <AppIcon v-else :name="artifact?.kind === 'audio' ? 'audio' : artifact?.kind === 'image' ? 'image' : 'film'" :size="24" />
</template>
