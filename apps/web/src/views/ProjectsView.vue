<script setup lang="ts">
import { NButton, NTag } from 'naive-ui';
import type { Project } from '../types.ts';
import { formatDate } from '../lib/timeline.ts';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
defineProps<{ projects: Project[]; activeId?: string; disabled: boolean }>();
const emit = defineEmits<{ create: []; select: [id: string] }>();
</script>

<template>
  <div class="projects-view">
    <section class="project-hero"><div class="hero-copy"><p class="eyebrow">YOUR IDEAS. YOUR CUT.</p><h1>自己的故事，<br /><span>自己的片场。</span></h1><p>把素材、时间线和每一次成片，<br class="desktop-break" />留在你自己的电脑里。</p><NButton type="primary" size="large" :disabled="disabled" @click="emit('create')"><template #icon><AppIcon name="plus" /></template>新建作品</NButton></div><div class="hero-art" aria-hidden="true"><div class="hero-frame frame-back"></div><div class="hero-frame frame-front"><div class="frame-cross"></div><span class="frame-label">OWNTAKE / LOCAL STUDIO</span><div class="frame-mountains"></div><span class="frame-counter">01 : 24 : 08</span></div><span class="hero-art-caption">THE NEXT TAKE IS YOURS.</span></div></section>
    <section aria-labelledby="projects-title"><div class="section-heading"><div><p class="eyebrow">PROJECT LIBRARY</p><h2 id="projects-title">我的作品 <span class="count">{{ projects.length }}</span></h2></div><span class="muted small">保存在本机 · 随时继续</span></div><EmptyState v-if="!projects.length" title="第一部作品，从这里开始" description="新建一个项目，导入本地图片或视频，然后把画面排成故事。" icon="projects"><NButton :disabled="disabled" @click="emit('create')">创建第一个项目</NButton></EmptyState><div v-else class="project-grid"><button v-for="(project, index) in projects" :key="project.id" class="project-card" :disabled="disabled" @click="emit('select', project.id)"><div class="project-cover" :class="`cover-${index % 4}`"><span class="project-cover-number">{{ String(index + 1).padStart(2, '0') }}</span><div class="project-cover-shape" :class="{ portrait: project.ratio === '9:16', square: project.ratio === '1:1' }"><AppIcon name="film" :size="30" /></div><span class="project-cover-ratio">{{ project.ratio }}</span><NTag v-if="project.id === activeId" size="small" :bordered="false" type="warning" class="project-active">当前项目</NTag></div><div class="project-card-body"><h3>{{ project.name }}</h3><p>{{ project.brief || '留一点空白，等灵感到来。' }}</p><div class="project-card-footer"><span>{{ formatDate(project.updatedAt) }}</span><span class="project-open">继续创作 <AppIcon name="arrow" :size="15" /></span></div></div></button></div></section>
  </div>
</template>
