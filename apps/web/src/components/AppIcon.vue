<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  projects: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  storyboard: 'M3 4h18v12H3zM8 20h8M12 16v4M8 8h8M8 12h5',
  workbench: 'M3 5h18v15H3zM3 10h18M9 10v10M7 5l4 5m3-5 4 5',
  studio: 'M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8M5.6 18.4l2.8-2.8m7.2-7.2 2.8-2.8M9 9h6v6H9z',
  terminal: 'M3 5h18v14H3zM7 9l3 3-3 3m6 0h4',
  review: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  jobs: 'M9 5h12M9 12h12M9 19h12M3 4v2m0 5v2m0 5v2',
  export: 'M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6',
  folder: 'M3 7V5h6l2 2h10v13H3z',
  desktop: 'M3 4h18v13H3zM8 21h8m-4-4v4',
  settings: 'M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4m-6 3v4',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  film: 'M3 4h18v16H3zM7 4v16m10-16v16M3 8h4m-4 8h4m10-8h4m-4 8h4',
  image: 'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M15 8h.01',
  audio: 'M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4',
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  remove: 'm6 6 12 12M6 18 18 6',
  refresh: 'M20 7a9 9 0 1 0 1 9M20 2v6h-6',
  check: 'm5 12 4 4L19 6',
};
</script>
<template><svg :width="size || 20" :height="size || 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.film" /></svg></template>
