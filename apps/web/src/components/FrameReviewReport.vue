<script setup lang="ts">
import { ref } from 'vue';
import { NAlert, NTag } from 'naive-ui';
import type { FrameReviewResult, SampledReview } from '../types.ts';
import { reviewFrameUrl } from '../lib/studioApi.ts';
const props = defineProps<{ operationId: string; review: SampledReview }>();
const failedFrames = ref<string[]>([]);
const categoryLabels: Record<FrameReviewResult['issues'][number]['category'], string> = { subject: '主体', composition: '构图', visible_text: '可见文字', consistency: '画面一致性' };
function frameLabel(id: string) { const index = props.review.frames.findIndex(frame => frame.id === id); return index < 0 ? id : `样本 ${index + 1}`; }
</script>
<template>
  <section class="frame-review-report" aria-label="抽样帧审核报告">
    <div class="heading-line"><h3>抽样画面报告</h3><NTag :bordered="false" size="small" :type="review.report.sampledVerdict === 'pass' ? 'success' : review.report.sampledVerdict === 'reject' ? 'error' : 'warning'">{{ { pass: '抽样画面通过', needs_review: '需要复核', reject: '抽样画面未通过' }[review.report.sampledVerdict] }}</NTag></div>
    <p class="review-summary preserve-text">{{ review.report.summary }}</p>
    <div class="coverage-chips"><span>画面：仅已发送样本</span><span>完整动作：未检查</span><span>声音：未检查</span></div>
    <div class="review-frame-grid"><figure v-for="(frame, index) in review.frames" :key="frame.id" class="review-frame"><a v-if="!failedFrames.includes(frame.id)" :href="reviewFrameUrl(operationId, frame.id)" target="_blank" rel="noopener noreferrer"><img :src="reviewFrameUrl(operationId, frame.id)" :alt="`审核样本 ${index + 1}，请求位置 ${(frame.requestedTimeMs / 1000).toFixed(3)} 秒`" loading="lazy" @error="failedFrames.push(frame.id)" /></a><div v-else class="frame-unavailable">样本文件暂不可用</div><figcaption><strong>样本 {{ index + 1 }} · 请求位置 {{ (frame.requestedTimeMs / 1000).toFixed(3) }} 秒</strong><span>{{ frame.width }} × {{ frame.height }} · PNG</span><code>SHA-256 · {{ frame.sha256 }}</code></figcaption></figure></div>
    <p class="form-note">时间为请求采样位置，未声明为精确帧时间戳。样本与 SHA-256 保留供你核对；抽样结论不能代替完整播放与人工检查。</p>
    <div v-if="review.report.issues.length" class="frame-issue-list"><article v-for="(issue, index) in review.report.issues" :key="index" class="frame-issue"><div class="heading-line"><strong>{{ categoryLabels[issue.category] }}</strong><NTag size="small" :bordered="false" :type="issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info'">{{ { info: '提示', warning: '注意', error: '问题' }[issue.severity] }}</NTag><span>{{ issue.frameIds.map(frameLabel).join('、') || '整体样本' }}</span></div><p class="preserve-text">{{ issue.observation }}</p></article></div>
    <p v-else class="form-note">模型未列出具体问题，这不等于未采样部分也符合要求。</p>
    <NAlert v-if="review.report.uncertainties.length" type="info" :show-icon="false" class="draft-alert"><strong>仍不确定的事项</strong><ul class="validation-issues"><li v-for="(uncertainty, index) in review.report.uncertainties" :key="index">{{ uncertainty }}</li></ul></NAlert>
    <p class="panel-footnote">规则 {{ review.ruleVersion }} · 采样 {{ review.samplingVersion }}。这是独立模型报告，人工复核记录与选用状态由你决定。</p>
  </section>
</template>
