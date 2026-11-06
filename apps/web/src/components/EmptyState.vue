<script setup lang="ts">
import AppIcon from './AppIcon.vue';
defineProps<{ title: string; description: string; icon?: string }>();
</script>
<template><div class="empty-state"><div class="empty-icon"><AppIcon :name="icon || 'film'" :size="30" /></div><h3>{{ title }}</h3><p>{{ description }}</p><div v-if="$slots.default" class="empty-actions"><slot /></div></div></template>
