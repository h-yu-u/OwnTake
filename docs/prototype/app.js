/* OwnTake interaction prototype. No network requests, real model calls, or media rendering. */
"use strict";

const OwnTakeDemoDomain = (() => {
  const manifests = Object.freeze({
    "demo-a": Object.freeze({ name: "Demo A", modes: ["text", "first_frame", "first_last"], ratios: ["16:9", "9:16"], minDuration: 2, maxDuration: 12, estimate: 6 }),
    "demo-b": Object.freeze({ name: "Demo B", modes: ["text", "first_frame"], ratios: ["16:9", "9:16"], minDuration: 2, maxDuration: 12, estimate: 4 })
  });
  const terminalStages = ["ready_for_review", "cancelled", "failed"];
  const transitions = Object.freeze({ prepared: "submitting", submitting: "running", running: "provider_succeeded", provider_succeeded: "ingesting", ingesting: "ready_for_review" });
  const stageDurations = Object.freeze({ prepared: 600, submitting: 900, running: 2400, provider_succeeded: 600, ingesting: 800 });

  function compatibility(shot, ratio) {
    const provider = manifests[shot.provider];
    const issues = [];
    if (!provider) return { ok: false, issues: ["未配置演示适配器"] };
    if (!provider.modes.includes(shot.mode)) issues.push("当前适配器不支持首尾帧；尾帧不会被悄悄丢弃");
    if (!provider.ratios.includes(ratio)) issues.push("当前画幅不在示例能力清单内");
    if (shot.duration < provider.minDuration || shot.duration > provider.maxDuration) issues.push("镜头时长超出示例能力范围");
    return { ok: issues.length === 0, issues };
  }

  function budgetUsage(project) {
    const held = project.jobs.filter(job => !terminalStages.includes(job.stage) && !job.charged).reduce((sum, job) => sum + job.estimate, 0);
    return { spent: project.spent, held, available: project.budget - project.spent - held, limit: project.budget };
  }

  function generationGate(shot, project, settings, activeCount) {
    const result = compatibility(shot, project.ratio);
    const reasons = [...result.issues];
    const estimate = manifests[shot.provider]?.estimate ?? 0;
    if (shot.kind !== "generated") reasons.push("该镜头使用导入或本地合成素材");
    if (!shot.planApproved) reasons.push("请确认当前生成方案");
    if (project.jobs.some(job => job.shotId === shot.id && job.visualRevision === shot.visualRevision && job.planRevision === shot.planRevision && !terminalStages.includes(job.stage))) reasons.push("此镜头方案已有未结束任务；请先等待完成或核对提交结果");
    if (budgetUsage(project).available < estimate) reasons.push("可用演示额度不足；待核对请求仍占用额度");
    if (activeCount >= settings.maxConcurrency) reasons.push("已达到演示生成并发上限");
    return { ok: reasons.length === 0, reasons, estimate };
  }

  function exportChecks(project) {
    const missing = project.shots.filter(shot => !shot.candidates.some(candidate => candidate.id === shot.selectedId));
    const stale = project.shots.filter(shot => {
      const selected = shot.candidates.find(candidate => candidate.id === shot.selectedId);
      return selected && selected.visualRevision !== shot.visualRevision;
    });
    const unreviewed = project.shots.filter(shot => {
      const selected = shot.candidates.find(candidate => candidate.id === shot.selectedId);
      return selected && !selected.humanApproved;
    });
    return { ok: missing.length === 0 && stale.length === 0 && unreviewed.length === 0, missing, stale, unreviewed };
  }

  // submission_unknown deliberately has no automatic transition.
  function nextJobStage(job, now) {
    const next = transitions[job.stage];
    if (!next || now - job.stageSince < stageDurations[job.stage]) return null;
    return next;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  return Object.freeze({ manifests, terminalStages, transitions, compatibility, budgetUsage, generationGate, exportChecks, nextJobStage, escapeHTML });
})();

// The small pure domain helpers can be checked with Node without a browser.
if (typeof module !== "undefined" && module.exports) module.exports = OwnTakeDemoDomain;

if (typeof document !== "undefined") (() => {
  const STORAGE_KEY = "owntake-prototype-v1";
  const VERSION = 1;
  const domain = OwnTakeDemoDomain;
  const esc = domain.escapeHTML;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const validViews = ["projects", "workbench", "assets", "jobs", "export", "settings"];
  const stageLabels = {
    prepared: "待提交（模拟）", submitting: "提交中（模拟）", submission_unknown: "提交待核对",
    running: "生成中（模拟）", provider_succeeded: "上游完成（模拟）", ingesting: "素材入库中（模拟）",
    ready_for_review: "候选待查看", cancelled: "已取消（模拟）", failed: "失败（模拟）"
  };
  const modeLabels = { first_last: "首尾帧 → 视频", first_frame: "首帧 → 视频", text: "文字 → 视频" };
  let idCounter = 0;
  let artCounter = 0;
  let currentTab = "versions";
  let assetFilter = "all";
  let reconcileJobId = null;
  let toastTimer = null;
  let playback = null;
  let renderTimer = null;
  let exportIsRunning = false;
  let environmentChecked = false;
  let storageWarningShown = false;

  function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
  function numberShot(shot) { return String(shot.number).padStart(2, "0"); }
  function timecode(seconds) { return `00:${String(Math.floor(seconds)).padStart(2, "0")}`; }
  function clock(timestamp) { return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
  function icon(name) { return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`; }

  function makeCandidate(shotId, version, visualRevision, origin, humanApproved, label) {
    return { id: `${shotId}-v${version}`, version, visualRevision, origin, humanApproved, label, createdAt: Date.now(), variant: version % 3 };
  }

  function makeProject({ title = "把闪念拍成片", brief, ratio = "16:9", style = "warm", seed = false } = {}) {
    const id = seed ? "project-demo" : uid("project");
    const shots = [
      { number: 1, title: "灵感亮起", kind: "generated", duration: 6, visualRevision: 1, intent: "深色空间里，一道暖光从纸张边缘升起。镜头缓慢推进，让微小的灵感逐渐有了形状。", subtitle: "每个作品，都始于一个闪念。", mode: "first_last", provider: "demo-a" },
      { number: 2, title: "想法有了形状", kind: "imported", duration: 8, visualRevision: 1, intent: "导入自己的工作台录屏或手绘笔记，呈现想法从文字到分镜的过程。界面文字使用真实素材。", subtitle: "把模糊的想法，一点点拼完整。", mode: "first_frame", provider: "demo-a" },
      { number: 3, title: "走进那个世界", kind: "generated", duration: 6, visualRevision: 2, intent: "透过一扇光影交错的窗，进入安静的城市。人物只作剪影，镜头保持轻缓、连贯的运动。", subtitle: "然后，让它成为一个可以走进的世界。", mode: "first_last", provider: "demo-a" },
      { number: 4, title: "你的下一镜", kind: "composite", duration: 4, visualRevision: 1, intent: "以确定性排版合成片名与结尾字幕。保留两秒留白，用暖色微光回应开场。", subtitle: "OwnTake · 把想法拍成自己的作品。", mode: "text", provider: "demo-a" }
    ].map(shot => {
      const shotId = `${id}-shot-${shot.number}`;
      const candidates = shot.number === 1 ? [
        makeCandidate(shotId, 1, shot.visualRevision, "generated", true, "柔光版本"),
        makeCandidate(shotId, 2, shot.visualRevision, "generated", false, "更近一点")
      ] : [makeCandidate(shotId, 1, shot.visualRevision, shot.kind, true, shot.kind === "imported" ? "导入示例" : shot.kind === "composite" ? "排版示例" : "城市微光")];
      return { ...shot, id: shotId, candidates, previewId: candidates[candidates.length - 1].id, selectedId: shot.number === 1 ? null : candidates[0].id, subtitleRevision: 1, planRevision: 1, planApproved: true, changes: [], lastChangedAt: Date.now() };
    });
    const unknown = {
      id: `${id}-job-unknown`, shotId: shots[2].id, shotTitle: shots[2].title,
      operationId: "demo-intent-017", attemptId: "demo-attempt-017-1", provider: "demo-a",
      visualRevision: 1, planRevision: 1, stage: "submission_unknown", stageSince: Date.now(), createdAt: Date.now(), estimate: 6, charged: false,
      remoteTaskId: null, artifactId: null, snapshot: { mode: "first_last", intent: "旧方案：城市黄昏中的光影。", ratio, duration: 6 },
      history: [{ at: Date.now(), text: "演示记录：提交后未收到明确响应，保留 operationId，停止重复提交。" }]
    };
    return {
      id, title, brief: brief || "用一支安静、克制的个人短片，记录一个想法如何从闪念变成作品。深色空间、真实创作过程与城市微光交织，结尾留给下一次创作。",
      ratio, style, duration: 24, createdAt: Date.now(), timelineVersion: 1, outputResolution: "1080p", shots,
      jobs: seed ? [unknown] : [], spent: seed ? 12 : 0, budget: 30, lastExport: null
    };
  }

  function initialState() {
    const project = makeProject({ seed: true });
    return { schemaVersion: VERSION, view: "workbench", projects: [project], activeProjectId: project.id, activeShotId: project.shots[0].id, settings: { maxConcurrency: 1 } };
  }

  function isStoredStateValid(value) {
    // localStorage is untrusted input. Validate structure, bound collection sizes, escape all rendered text.
    const int = (number, minimum = 0, maximum = 1000000) => Number.isInteger(number) && number >= minimum && number <= maximum;
    const text = (string, maximum = 2000) => typeof string === "string" && string.length <= maximum;
    if (!value || value.schemaVersion !== VERSION || !Array.isArray(value.projects) || value.projects.length === 0 || value.projects.length > 40) return false;
    if (!value.settings || !Number.isInteger(value.settings.maxConcurrency) || value.settings.maxConcurrency < 1 || value.settings.maxConcurrency > 3) return false;
    return value.projects.every(project =>
      text(project.id, 200) && text(project.title, 100) && text(project.brief, 2000) &&
      ["16:9", "9:16"].includes(project.ratio) && ["1080p", "720p"].includes(project.outputResolution ?? "1080p") && Array.isArray(project.shots) && project.shots.length === 4 &&
      int(project.spent) && int(project.budget, 6, 999) && int(project.duration, 1, 3600) && int(project.timelineVersion, 1) && Array.isArray(project.jobs) && project.jobs.length < 500 &&
      project.shots.every((shot, index) => text(shot.id, 200) && text(shot.title, 100) && text(shot.intent, 5000) && text(shot.subtitle, 100) && shot.number === index + 1 &&
        int(shot.duration, 1, 3600) && int(shot.planRevision, 1) && int(shot.subtitleRevision, 1) &&
        ["generated", "imported", "composite"].includes(shot.kind) && Object.hasOwn(domain.manifests, shot.provider) && Object.hasOwn(modeLabels, shot.mode) &&
        int(shot.visualRevision, 1) && Array.isArray(shot.candidates) && shot.candidates.length > 0 && shot.candidates.length < 500 &&
        Array.isArray(shot.changes) && shot.changes.every(change => change && text(change.title) && text(change.detail)) &&
        shot.candidates.every(candidate => text(candidate.id, 200) && int(candidate.version, 1) && int(candidate.visualRevision, 1) && int(candidate.variant, 0, 2) && typeof candidate.humanApproved === "boolean")) &&
      project.jobs.every(job => text(job.id, 200) && Object.hasOwn(stageLabels, job.stage) && Number.isFinite(job.stageSince) && int(job.estimate) && int(job.visualRevision, 1) && int(job.planRevision, 1) &&
        job.snapshot && Object.hasOwn(modeLabels, job.snapshot.mode) && int(job.snapshot.duration, 1, 3600) &&
        Array.isArray(job.history) && job.history.every(event => event && Number.isFinite(event.at) && text(event.text))) &&
      (!project.lastExport || int(project.lastExport.timelineVersion, 1) && ["1080p", "720p"].includes(project.lastExport.resolution))
    );
  }

  let state;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    state = isStoredStateValid(stored) ? stored : initialState();
  } catch (_) { state = initialState(); }
  state.projects.forEach(item => { item.outputResolution ||= "1080p"; });
  if (!validViews.includes(state.view)) state.view = "workbench";
  if (!state.projects.some(project => project.id === state.activeProjectId)) state.activeProjectId = state.projects[0].id;
  if (!project().shots.some(shot => shot.id === state.activeShotId)) state.activeShotId = project().shots[0].id;

  function project() { return state.projects.find(item => item.id === state.activeProjectId); }
  function shot() { return project().shots.find(item => item.id === state.activeShotId) || project().shots[0]; }
  function previewCandidate(target = shot()) { return target.candidates.find(item => item.id === target.previewId) || target.candidates[target.candidates.length - 1]; }
  function selectedCandidate(target) { return target.candidates.find(item => item.id === target.selectedId); }
  function allActiveJobs() { return state.projects.flatMap(item => item.jobs).filter(job => !domain.terminalStages.includes(job.stage) && job.stage !== "submission_unknown"); }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (_) {
      if (!storageWarningShown) { storageWarningShown = true; toast("当前浏览器无法持久保存原型状态；本次交互仍可继续，刷新后可能恢复初始示例。"); }
    }
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 5200);
  }

  function pushChange(target, title, detail) {
    target.changes.unshift({ title, detail, at: Date.now() });
    target.changes = target.changes.slice(0, 12);
    target.lastChangedAt = Date.now();
  }

  function touchTimeline(targetProject = project()) { targetProject.timelineVersion += 1; }

  function sceneArt(scene, variant = 0, compact = false, style = project().style) {
    const id = `art-${++artCounter}`;
    const warm = style !== "cool";
    const gold = warm ? "#e5bb78" : "#a4c4c2";
    const mid = warm ? "#8e7546" : "#597f82";
    const dark = warm ? "#1c2318" : "#152429";
    const accent = variant === 1 ? "#babe91" : gold;
    const defs = `<defs><linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101711"/><stop offset=".6" stop-color="${dark}"/><stop offset="1" stop-color="#0d120e"/></linearGradient><radialGradient id="${id}-glow"><stop stop-color="${gold}" stop-opacity=".7"/><stop offset=".48" stop-color="${mid}" stop-opacity=".18"/><stop offset="1" stop-color="${dark}" stop-opacity="0"/></radialGradient><linearGradient id="${id}-paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#dfd6b6"/><stop offset=".5" stop-color="#8c9473"/><stop offset="1" stop-color="#4e5c42"/></linearGradient><linearGradient id="${id}-beam" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${gold}" stop-opacity=".55"/><stop offset="1" stop-color="${gold}" stop-opacity="0"/></linearGradient></defs>`;
    const base = `<rect width="960" height="540" fill="url(#${id}-bg)"/>`;
    let art;
    if (scene === 1) {
      art = `<ellipse cx="${variant === 1 ? 410 : 530}" cy="235" rx="400" ry="300" fill="url(#${id}-glow)"/><path d="M0 435 960 360v180H0Z" fill="#11190e"/><path d="M155 540 554 276l406 180" fill="none" stroke="#a7a778" stroke-opacity=".12"/><ellipse cx="506" cy="397" rx="204" ry="32" fill="#060b08" opacity=".6"/><g transform="translate(${variant === 1 ? 28 : 0} ${variant === 2 ? -7 : 0})"><path d="m365 364 79-194 172 106-80 179Z" fill="url(#${id}-paper)"/><path d="m444 170 23 204 69 81 80-179Z" fill="#939778"/><path d="m444 170 23 204 149-98Z" fill="#c1bea0"/><path d="m365 364 102 10 69 81Z" fill="#596347"/><path d="m444 170 23 204 149-98" fill="none" stroke="${accent}" stroke-width="2.5"/><path d="m444 170 24-95 148 201" fill="url(#${id}-beam)"/><circle cx="456" cy="133" r="3" fill="${accent}"/><circle cx="419" cy="117" r="1.3" fill="${accent}"/><circle cx="513" cy="98" r="1.8" fill="${accent}"/></g><path d="M80 116h40m-40 0v40M840 424h40v-40" fill="none" stroke="#cbd0b4" stroke-opacity=".2"/>`;
    } else if (scene === 2) {
      art = `<ellipse cx="535" cy="240" rx="400" ry="350" fill="url(#${id}-glow)"/><path d="M0 420 960 360v180H0Z" fill="#131a11"/><g transform="translate(180 90) rotate(-4 300 180)"><rect x="0" y="0" width="600" height="345" rx="12" fill="#121910" stroke="#788364" stroke-width="2"/><rect x="0" y="0" width="600" height="32" rx="12" fill="#293323"/><circle cx="19" cy="16" r="3" fill="#a6ad8f"/><circle cx="31" cy="16" r="3" fill="#747f61"/><circle cx="43" cy="16" r="3" fill="#566446"/><path d="M134 32v313" stroke="#313d28"/><rect x="16" y="53" width="99" height="61" rx="4" fill="#384b30"/><rect x="16" y="128" width="99" height="61" rx="4" fill="#7c7550"/><rect x="16" y="203" width="99" height="61" rx="4" fill="#354a37"/><rect x="154" y="52" width="421" height="211" rx="5" fill="#2e3e28"/><circle cx="369" cy="159" r="64" fill="#46593a"/><path d="m353 126 49 33-49 33Z" fill="#d5c389"/><path d="M155 282h420M155 304h224" stroke="#576849" stroke-width="8" stroke-linecap="round"/><path d="M155 326h102m17 0h109m17 0h172" stroke="${accent}" stroke-opacity=".5" stroke-width="7" stroke-linecap="round"/></g><path d="m165 464 132-20 142 37-117 24Z" fill="#787e5e"/><path d="m683 427 72-21 85 19-77 25Z" fill="#414e36"/>`;
    } else if (scene === 3) {
      art = `<ellipse cx="520" cy="220" rx="440" ry="320" fill="url(#${id}-glow)"/><rect x="240" y="55" width="480" height="397" rx="165" fill="#7d8662" opacity=".25"/><path d="M270 395V205a210 210 0 0 1 420 0v190Z" fill="#6c7b56" opacity=".45"/><path d="M288 394V220a192 192 0 0 1 384 0v174Z" fill="#84916a" opacity=".35"/><circle cx="545" cy="184" r="68" fill="${gold}" opacity=".23"/><path d="M279 338h34v-83h55v109h42v-59h56v59h39v-140h56v105h47v-64h62v131H279Z" fill="#344c37"/><path d="M288 373h31v-58h48v75h32v-40h64v40h49v-70h61v54h43v-29h56v82H288Z" fill="#263e2e"/><path d="M480 55v397M246 272h468" stroke="#182719" stroke-width="15"/><path d="M240 452h480L916 540H45Z" fill="#1b2919"/><path d="M287 452 130 540M481 452v88M671 452l158 88" stroke="${gold}" stroke-opacity=".17"/><ellipse cx="430" cy="468" rx="53" ry="11" fill="#09130d"/><path d="M417 360c0-18 26-18 26 0l5 63-4 47h-11l-4-43-4 43h-11l2-47Z" fill="#18271b"/><circle cx="430" cy="340" r="12" fill="#19271b"/>`;
    } else {
      art = `<ellipse cx="480" cy="275" rx="440" ry="350" fill="url(#${id}-glow)"/><path d="M161 396h638" stroke="#93956a" stroke-opacity=".3"/><path d="M280 155h55m-55 0v55M626 377h55v-55" fill="none" stroke="${gold}" stroke-width="2" stroke-opacity=".55"/><g transform="translate(455 154) rotate(-7)"><rect width="43" height="51" rx="8" fill="none" stroke="${gold}" stroke-width="2.5"/><path d="m17 15 16 10-16 10Z" fill="${gold}"/></g><text x="480" y="285" text-anchor="middle" fill="#e5dfc4" font-family="system-ui, sans-serif" font-weight="400" font-size="${compact ? 74 : 67}" letter-spacing="-2">OwnTake</text><text x="480" y="329" text-anchor="middle" fill="#b6bd9e" font-family="system-ui, sans-serif" font-size="15" letter-spacing="7">YOUR STORY. YOUR TAKE.</text>`;
    }
    return `<svg class="scene-art" viewBox="0 0 960 540" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="镜头 ${scene} 的本地矢量概念示意">${defs}${base}${art}</svg>`;
  }

  function render() {
    const focus = document.activeElement;
    const focusKey = focus?.dataset?.focus;
    renderGlobal();
    if (state.view === "workbench") renderWorkbench();
    else if (state.view === "projects") renderProjects();
    else if (state.view === "assets") renderAssets();
    else if (state.view === "jobs") renderJobs();
    else if (state.view === "export") renderExport();
    else if (state.view === "settings") renderSettings();
    if (focusKey && !document.contains(focus)) $$('[data-focus]').find(item => item.dataset.focus === focusKey)?.focus({ preventScroll: true });
  }

  function renderGlobal() {
    $("#top-project-name").textContent = project().title;
    $$(".view").forEach(view => { view.hidden = view.id !== `view-${state.view}`; });
    $$(".nav-item").forEach(button => {
      const active = button.dataset.nav === state.view;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    const count = state.projects.flatMap(item => item.jobs).filter(job => !domain.terminalStages.includes(job.stage)).length;
    $("#job-count").textContent = String(count);
    $("#job-count").hidden = count === 0;
  }

  function shotStatus(target) {
    const selected = selectedCandidate(target);
    if (!selected) return { text: "待选择素材", pending: true };
    if (selected.visualRevision !== target.visualRevision) return { text: "方案已变 · 待复核", pending: true };
    if (!selected.humanApproved) return { text: "已选用 · 待人工确认", pending: true };
    return { text: "已选用 · 演示已确认", pending: false };
  }

  function setValueUnlessEditing(selector, value) { if (document.activeElement !== $(selector)) $(selector).value = value; }

  function renderWorkbench() {
    const currentProject = project();
    const current = shot();
    const candidate = previewCandidate();
    $("#workbench-heading").textContent = currentProject.title;
    $("#project-summary").textContent = `${currentProject.duration} 秒 · ${currentProject.ratio} · ${currentProject.shots.length} 个镜头`;
    $("#project-ready-count").textContent = `${currentProject.shots.filter(item => selectedCandidate(item)).length} / ${currentProject.shots.length} 已选素材`;
    $("#style-note").textContent = currentProject.style === "warm" ? "深色空间，暖色微光。让一个模糊的想法，逐渐变成清晰的作品。" : "安静城市，冷色晨光。让创作的节奏像一次缓慢、清晰的呼吸。";
    $("#shot-list").innerHTML = currentProject.shots.map(item => {
      const status = shotStatus(item);
      const art = selectedCandidate(item) || previewCandidate(item);
      return `<button class="shot-button" type="button" data-shot="${esc(item.id)}" data-focus="shot-${esc(item.id)}" aria-pressed="${item.id === current.id}"><div class="shot-thumb">${sceneArt(item.number, art.variant, true)}<span class="thumb-counter">${numberShot(item)}</span><span class="thumb-duration">${item.duration}s</span></div><div class="shot-info"><strong>${esc(item.title)}</strong><span class="small muted">${item.duration}s</span></div><span class="shot-state ${status.pending ? "pending" : ""}">${status.text}</span></button>`;
    }).join("");
    $("#shot-type").textContent = { generated: "生成镜头", imported: "导入素材", composite: "本地排版合成" }[current.kind];
    $("#shot-heading").textContent = `${numberShot(current)} · ${current.title}`;
    $("#visual-version").textContent = `画面方案 v${current.visualRevision}`;
    $("#shot-preview").classList.toggle("portrait", currentProject.ratio === "9:16");
    $("#shot-preview").innerHTML = `${sceneArt(current.number, candidate.variant)}<div class="preview-topline"><span>SHOT ${numberShot(current)} / ${currentProject.ratio}</span><span>候选 v${candidate.version}${candidate.id === current.selectedId ? " · 已选用" : ""}</span></div><div class="preview-subtitle">${esc(current.subtitle)}</div>`;
    $("#candidate-count").textContent = String(current.candidates.length);
    $("#candidate-list").innerHTML = [...current.candidates].reverse().map(item => `<button type="button" class="candidate" data-candidate="${esc(item.id)}" data-focus="candidate-${esc(item.id)}" aria-pressed="${candidate.id === item.id}" aria-label="查看候选版本 ${item.version}，${esc(item.label)}"><div class="candidate-art">${sceneArt(current.number, item.variant, true)}</div><div class="candidate-caption"><span>v${item.version} · ${esc(item.label)}</span>${item.id === current.selectedId ? '<span class="tag good">已选</span>' : item.visualRevision !== current.visualRevision ? '<span class="tag warning">旧方案</span>' : ""}</div></button>`).join("");
    const stale = candidate.visualRevision !== current.visualRevision;
    $("#candidate-hint").textContent = stale ? "此候选来自旧画面方案，仅供参考。" : candidate.humanApproved ? "该候选已标记人工确认（演示）。" : "候选尚待人工确认，可先选用再到审核页确认。";
    $("#adopt-candidate").disabled = stale || current.selectedId === candidate.id;
    $("#adopt-candidate").textContent = stale ? "旧方案候选" : current.selectedId === candidate.id ? "已选用" : "选用这版";
    setValueUnlessEditing("#shot-subtitle", current.subtitle);
    setValueUnlessEditing("#shot-intent", current.intent);
    $("#plan-version").textContent = `方案 v${current.planRevision}`;
    $("#shot-mode").value = current.mode;
    $("#shot-provider").value = current.provider;
    $("#approve-plan").checked = current.planApproved;
    const generated = current.kind === "generated";
    $("#generation-settings").hidden = !generated;
    $("#local-source-settings").hidden = generated;
    if (generated) renderGenerationSettings();
    else $("#local-source-settings").innerHTML = current.kind === "imported"
      ? `<div class="local-source-card"><span class="tag">导入镜头</span><h3 class="spaced">保留真实内容</h3><p>正式版可读取本机截图、录屏或拍摄素材。这里使用静态示例，不打开你的文件。</p><button type="button" class="button button-quiet full-width" data-action="import-demo">导入新的示例版本</button></div>`
      : `<div class="local-source-card"><span class="tag">确定性合成</span><h3 class="spaced">文字与版式精确可控</h3><p>正式版由本地媒体工具排版与合成，不要求视频模型生成文字。</p><button type="button" class="button button-quiet full-width" data-action="rebuild-composite">模拟更新合成候选</button></div>`;
    renderReview();
    renderChanges();
    renderTabs();
    renderTimeline();
  }

  function renderGenerationSettings() {
    const current = shot();
    const result = domain.compatibility(current, project().ratio);
    const provider = domain.manifests[current.provider];
    const hasTail = provider.modes.includes("first_last");
    $("#capability-list").innerHTML = `<div class="capability-row"><span>时长 / 画幅</span><strong>${current.duration}s · ${project().ratio}</strong></div><div class="capability-row"><span>首帧参考</span><strong class="pass">支持</strong></div><div class="capability-row"><span>尾帧约束</span><strong class="${hasTail ? "pass" : "fail"}">${hasTail ? "支持" : "不支持"}</strong></div><div class="capability-row"><span>当前方式</span><strong>${esc(modeLabels[current.mode])}</strong></div>`;
    $("#compatibility-message").className = `callout ${result.ok ? "" : "error"}`;
    $("#compatibility-message").textContent = result.ok ? "能力匹配。生成会创建新的候选，不会替换已选素材。" : `${result.issues.join("；")}。请更换模型，或明确改用另一种生成方式。`;
    const gate = domain.generationGate(current, project(), state.settings, allActiveJobs().length);
    const budget = domain.budgetUsage(project());
    const hasDraft = $("#shot-intent").value.trim() !== current.intent;
    $("#submit-generation").disabled = !gate.ok || hasDraft;
    $("#submit-generation").title = hasDraft ? "请先保存画面意图的修改" : gate.reasons.join("；");
    $("#generation-cost").textContent = `预计 ${gate.estimate} 演示点 · 可用 ${Math.max(0, budget.available)} / ${budget.limit} 点 · 无真实费用`;
  }

  function renderReview() {
    const current = shot();
    const candidate = previewCandidate();
    const stale = candidate.visualRevision !== current.visualRevision;
    $("#review-content").innerHTML = `<div class="review-row"><div><strong>素材与参数检查</strong><p>原型无真实媒体文件，以下仅演示正式版检查位置。</p></div><span class="tag">not_checked</span></div><div class="review-row"><div><strong>动作、故事与声音</strong><p>当前只有静态概念图；没有分析动态视频、音轨或连续性。</p></div><span class="tag">未检查</span></div><div class="review-row"><div><strong>人工确认记录</strong><p>绑定候选 v${candidate.version} / 画面方案 v${candidate.visualRevision}。${stale ? "当前画面方案已经变化。" : "原型按钮只改变演示记录。"}</p></div><span class="tag ${stale ? "warning" : candidate.humanApproved ? "good" : "warning"}">${stale ? "需重新检查" : candidate.humanApproved ? "演示已确认" : "待人工确认"}</span></div><div class="review-actions"><button type="button" class="button button-quiet button-small" data-action="approve-candidate" ${candidate.humanApproved || stale ? "disabled" : ""}>${candidate.humanApproved ? "已标记确认（演示）" : "标记人工确认（演示）"}</button><span class="small muted">未检查的项目不会伪装成模型审核通过。</span></div>`;
  }

  function renderChanges() {
    const changes = shot().changes;
    $("#change-content").innerHTML = changes.length ? changes.map(change => `<div class="change-item"><span>↳</span><div><strong>${esc(change.title)}</strong><p>${esc(change.detail)}</p></div></div>`).join("") : `<div class="change-item"><span>01</span><div><strong>改字幕</strong><p>只更新字幕与最终合成，镜头素材继续复用。</p></div></div><div class="change-item"><span>02</span><div><strong>改画面意图</strong><p>只标记当前镜头的候选需复核，不触发自动重生成。</p></div></div><div class="change-item"><span>03</span><div><strong>换适配器</strong><p>重新确认生成方案，保留所有已有版本和当前选用素材。</p></div></div>`;
  }

  function renderTabs() {
    $$("[data-tab]").forEach(button => {
      const active = button.dataset.tab === currentTab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      $(`#panel-${button.dataset.tab}`).hidden = !active;
    });
  }

  function renderTimeline() {
    $("#timeline-version").textContent = `v${project().timelineVersion} · 镜头顺序示意`;
    $("#timeline-shots").innerHTML = project().shots.map(item => `<button class="timeline-clip" type="button" data-shot="${esc(item.id)}" data-focus="timeline-${esc(item.id)}" aria-pressed="${item.id === shot().id}"><span class="clip-number">${numberShot(item)}</span><span class="clip-title">${esc(item.title)}</span><span class="clip-duration">${item.duration}s</span></button>`).join("");
    $("#subtitle-track").innerHTML = project().shots.map(item => `<span class="subtitle-block" title="${esc(item.subtitle)}">${esc(item.subtitle || "无字幕")}</span>`).join("");
    if (!playback) {
      const start = project().shots.slice(0, shot().number - 1).reduce((sum, item) => sum + item.duration, 0);
      $("#preview-time").textContent = `${timecode(start)} / ${timecode(project().duration)}`;
      $("#preview-progress-fill").style.width = `${start / project().duration * 100}%`;
    }
  }

  function renderProjects() {
    $("#project-list").innerHTML = state.projects.map(item => `<button type="button" class="project-card" data-project="${esc(item.id)}" data-focus="project-${esc(item.id)}"><div class="project-art">${sceneArt(1, 1, false, item.style)}</div><div class="project-title-row"><h3>${esc(item.title)}</h3><span class="tag ${item.id === state.activeProjectId ? "accent" : ""}">${item.id === state.activeProjectId ? "当前项目" : "演示项目"}</span></div><p>${item.duration} 秒 · ${item.ratio} · ${item.shots.length} 个镜头 · 时间线 v${item.timelineVersion}</p></button>`).join("");
  }

  function renderAssets() {
    const assets = project().shots.flatMap(item => item.candidates.map(candidate => ({ shot: item, candidate })));
    const filtered = assets.filter(item => assetFilter === "all" || assetFilter === "selected" && item.shot.selectedId === item.candidate.id || assetFilter === "generated" && item.candidate.origin === "generated" || assetFilter === "imported" && item.candidate.origin !== "generated");
    $("#asset-list").innerHTML = filtered.length ? filtered.map(({ shot: item, candidate }) => `<button class="asset-card" type="button" data-asset="${esc(candidate.id)}" data-shot-id="${esc(item.id)}" data-focus="asset-${esc(candidate.id)}"><div class="asset-art">${sceneArt(item.number, candidate.variant, true)}${item.selectedId === candidate.id ? '<span class="tag good">已选用</span>' : candidate.visualRevision !== item.visualRevision ? '<span class="tag warning">旧方案</span>' : '<span class="tag">候选</span>'}</div><strong>${numberShot(item)} ${esc(item.title)} · v${candidate.version}</strong><p>${esc(candidate.label)} · ${candidate.origin === "generated" ? "生成占位" : candidate.origin === "imported" ? "导入占位" : "合成占位"}</p></button>`).join("") : '<div class="empty-state"><h3>这个筛选下还没有素材</h3><p>可以切换到全部，或导入一个新的示例版本。</p></div>';
    $$("[data-filter]").forEach(button => { const active = button.dataset.filter === assetFilter; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
  }

  function renderJobs() {
    const currentProject = project();
    const running = currentProject.jobs.filter(job => !domain.terminalStages.includes(job.stage) && job.stage !== "submission_unknown");
    const unknown = currentProject.jobs.filter(job => job.stage === "submission_unknown");
    const complete = currentProject.jobs.filter(job => job.stage === "ready_for_review");
    const budget = domain.budgetUsage(currentProject);
    $("#job-overview").innerHTML = `<div class="stat-card"><strong>${running.length}</strong><span>正在演示执行</span></div><div class="stat-card warning"><strong>${unknown.length}</strong><span>提交待核对</span></div><div class="stat-card"><strong>${complete.length}</strong><span>候选已入库</span></div><div class="stat-card"><strong>${budget.spent + budget.held}<span> / ${budget.limit}</span></strong><span>已用 + 占用演示点</span></div>`;
    $("#job-list").innerHTML = currentProject.jobs.length ? [...currentProject.jobs].reverse().map(job => {
      const unknownJob = job.stage === "submission_unknown";
      const completeJob = job.stage === "ready_for_review";
      const runningJob = !unknownJob && !domain.terminalStages.includes(job.stage);
      const progress = { prepared: 4, submitting: 15, running: 48, provider_succeeded: 80, ingesting: 92, ready_for_review: 100 }[job.stage] || 0;
      const target = currentProject.shots.find(item => item.id === job.shotId);
      return `<article class="job-card ${unknownJob ? "unknown" : ""}"><div><div class="job-title"><h3>${target ? numberShot(target) : "—"} · ${esc(job.shotTitle)}</h3><span class="tag">画面方案 v${job.visualRevision}</span></div><p class="job-meta">${esc(domain.manifests[job.provider]?.name || job.provider)} · ${job.estimate} 演示点${unknownJob ? "暂占用" : job.charged ? "已记账" : "待记账"} · ${target && job.visualRevision !== target.visualRevision ? "旧方案任务，完成后不覆盖当前版本" : "新候选独立保存"}</p><p class="job-meta mono">${esc(job.operationId)}</p></div><div class="job-stage"><span class="tag ${unknownJob ? "warning" : completeJob ? "good" : ""}">${esc(stageLabels[job.stage])}</span><span class="mono">${esc(job.stage)}</span>${runningJob ? `<div class="job-progress"><span style="width:${progress}%"></span></div>` : ""}</div><div class="job-actions"><button type="button" class="button button-quiet button-small" data-job-detail="${esc(job.id)}" data-focus="detail-${esc(job.id)}">记录</button>${unknownJob ? `<button type="button" class="button button-primary button-small" data-reconcile="${esc(job.id)}" data-focus="reconcile-${esc(job.id)}">核对任务</button>` : completeJob ? `<button type="button" class="button button-quiet button-small" data-job-candidate="${esc(job.id)}" data-focus="result-${esc(job.id)}">查看候选</button>` : runningJob ? `<button type="button" class="button button-quiet button-small" data-cancel-job="${esc(job.id)}" data-focus="cancel-${esc(job.id)}">模拟取消</button>` : ""}</div></article>`;
    }).join("") : '<div class="empty-state"><h3>还没有生成任务</h3><p>在分镜工作台确认一个生成方案，试试模拟创建候选。</p></div>';
  }

  function renderExport() {
    const currentProject = project();
    const checks = domain.exportChecks(currentProject);
    $("#export-resolution").value = currentProject.outputResolution;
    const shotNames = shots => shots.map(item => `${numberShot(item)} ${item.title}`).join("、");
    $("#export-version-pill").textContent = `时间线 v${currentProject.timelineVersion}`;
    $("#export-project-title").textContent = currentProject.title;
    $("#export-project-info").textContent = `4 个镜头 · ${currentProject.duration} 秒 · ${currentProject.ratio} · 静态示意`;
    $("#export-story-strip").innerHTML = currentProject.shots.map(item => { const selected = selectedCandidate(item); return `<div class="export-story-frame">${sceneArt(item.number, (selected || previewCandidate(item)).variant, true)}<span>${numberShot(item)} · ${selected ? `v${selected.version} 已选用` : "尚未选用"}</span></div>`; }).join("");
    const lines = [
      { ok: checks.missing.length === 0, label: "每个镜头都有选用素材", detail: checks.missing.length ? `待选用：${shotNames(checks.missing)}` : "4 个镜头均已选择候选。", target: checks.missing[0] },
      { ok: checks.stale.length === 0, label: "选用素材对应当前画面方案", detail: checks.stale.length ? `方案已变化：${shotNames(checks.stale)}` : "没有引用过时的画面方案。", target: checks.stale[0] },
      { ok: checks.unreviewed.length === 0, label: "选用版本已完成人工确认", detail: checks.unreviewed.length ? `待确认：${shotNames(checks.unreviewed)}` : "已选素材均有演示确认记录。", target: checks.unreviewed[0], review: true },
      { ok: true, label: "字幕与时间线快照可构建", detail: `将冻结时间线 v${currentProject.timelineVersion}；本页不验证真实媒体参数。` }
    ];
    $("#export-checks").innerHTML = lines.map(line => `<div class="export-check"><span class="check-circle ${line.ok ? "" : "fail"}">${line.ok ? "✓" : "!"}</span><div><strong>${esc(line.label)}</strong><p>${esc(line.detail)}</p></div>${line.target ? `<button class="text-button accent-link" type="button" data-fix-shot="${esc(line.target.id)}" data-review="${Boolean(line.review)}">处理 ↗</button>` : ""}</div>`).join("");
    $("#simulate-export").disabled = !checks.ok || exportIsRunning;
    $("#simulate-export").innerHTML = `${icon("export")}${exportIsRunning ? "正在模拟渲染…" : checks.ok ? "模拟渲染" : "完成上方检查后模拟渲染"}`;
    if (currentProject.lastExport) {
      const current = currentProject.lastExport.timelineVersion === currentProject.timelineVersion && currentProject.lastExport.resolution === $("#export-resolution").value;
      $("#export-result").innerHTML = `<div class="callout ${current ? "" : "warning"}"><strong>${current ? "渲染演示已完成" : "上一次渲染演示已过期"}</strong><p>${current ? `已演示时间线 v${currentProject.lastExport.timelineVersion} 的合成流程。没有生成视频文件；可下载方案 JSON。` : `上次对应 v${currentProject.lastExport.timelineVersion} / ${esc(currentProject.lastExport.resolution)}。时间线或输出规格已经变化，需要重新合成；现有素材继续保留。`}</p></div>`;
    } else $("#export-result").innerHTML = '<div class="callout neutral"><p>预览图为本地矢量占位。原型不会执行 FFmpeg，也不会下载伪装成成片的文件。</p></div>';
  }

  function renderSettings() {
    setValueUnlessEditing("#max-concurrency", state.settings.maxConcurrency);
    setValueUnlessEditing("#demo-budget", project().budget);
    $("#environment-result").textContent = environmentChecked ? "演示结果：Node / SQLite / FFmpeg 均显示为可配置。没有读取本机可执行文件、版本或路径。" : "不会探测这台设备的实际运行环境。";
  }

  function navigate(view, { focus = false } = {}) {
    if (!validViews.includes(view)) return;
    stopPlayback();
    state.view = view;
    save();
    render();
    try { history.replaceState(null, "", `#${view}`); } catch (_) { /* file:// browsers may limit history APIs. */ }
    if (focus) $("#main-content").focus({ preventScroll: true });
  }

  function activateShot(id, tab = "versions") {
    if (!project().shots.some(item => item.id === id)) return;
    stopPlayback();
    state.activeShotId = id;
    currentTab = tab;
    state.view = "workbench";
    save(); render();
  }

  function openDetail(title, content, actions = []) {
    $("#detail-title").textContent = title;
    $("#detail-content").innerHTML = content;
    $("#detail-actions").innerHTML = actions.map(action => `<button type="button" class="button ${action.primary ? "button-primary" : "button-quiet"}" data-detail-action="${esc(action.id)}">${esc(action.label)}</button>`).join("") || '<button type="button" class="button button-quiet" data-close>关闭</button>';
    $("#detail-dialog").showModal();
  }

  function showBrief() {
    openDetail("创作简报", `<dl class="detail-definition"><dt>项目</dt><dd>${esc(project().title)}</dd><dt>长度与画幅</dt><dd>24 秒 · ${esc(project().ratio)}</dd><dt>镜头来源</dt><dd>生成镜头 + 导入素材 + 确定性合成</dd><dt>画风</dt><dd>${project().style === "warm" ? "深色空间、暖色微光、克制运动" : "安静城市、冷色晨光、轻缓节奏"}</dd></dl><p class="detail-copy">${esc(project().brief)}</p><div class="callout neutral"><p>简报来自你的输入；当前分镜使用示例模板，并未自动分析这段文字。</p></div>`);
  }

  function changeVisualIntent(next, reason = "画面意图已修改") {
    const current = shot();
    current.intent = next;
    current.visualRevision += 1;
    current.planRevision += 1;
    current.planApproved = false;
    touchTimeline();
    pushChange(current, reason, `仅本镜头更新为画面方案 v${current.visualRevision}。旧候选保留并标记待复核；没有自动发起生成或修改其他镜头。`);
    save(); render();
    toast("画面方案已更新。当前镜头的旧候选保留；确认方案后可创建新候选。");
  }

  function submitGeneration() {
    const current = shot();
    const gate = domain.generationGate(current, project(), state.settings, allActiveJobs().length);
    if (!gate.ok) return toast(gate.reasons.join("；"));
    if ($("#shot-intent").value.trim() !== current.intent) return toast("请先保存画面意图的修改，再确认生成方案。");
    const operationId = uid("demo-intent");
    const now = Date.now();
    const job = {
      id: uid("demo-job"), shotId: current.id, shotTitle: current.title, operationId, attemptId: `${operationId}-attempt-1`,
      provider: current.provider, visualRevision: current.visualRevision, planRevision: current.planRevision,
      stage: "prepared", createdAt: now, stageSince: now, estimate: gate.estimate, charged: false, remoteTaskId: null, artifactId: null,
      snapshot: { mode: current.mode, intent: current.intent, ratio: project().ratio, duration: current.duration },
      history: [{ at: now, text: "冻结镜头方案与输入快照，创建新 generation intent，预留演示额度。" }]
    };
    project().jobs.push(job);
    pushChange(current, "已创建生成意图（演示）", "新请求与已有版本独立；完成后生成候选，选用版本仍由你决定。");
    save(); render();
    toast("模拟任务已开始，可到任务页查看；完成后需要手动选用新候选。");
  }

  function completeJob(targetProject, job) {
    const target = targetProject.shots.find(item => item.id === job.shotId);
    if (!target || job.artifactId) return;
    if (!job.charged) { targetProject.spent += job.estimate; job.charged = true; }
    const version = Math.max(...target.candidates.map(item => item.version)) + 1;
    const stale = job.visualRevision !== target.visualRevision;
    const candidate = makeCandidate(target.id, version, job.visualRevision, "generated", false, stale ? "旧方案结果" : "新生成候选");
    candidate.id = uid("demo-artifact");
    target.candidates.push(candidate);
    job.artifactId = candidate.id;
    if (!stale) target.previewId = candidate.id;
    pushChange(target, stale ? "旧方案结果已保留" : "新候选已入库（演示）", stale ? "迟到结果属于旧画面方案，仅进入历史候选；没有覆盖当前素材。" : `候选 v${version} 等待查看与人工确认；现有选用版本保持不变。`);
    job.history.push({ at: Date.now(), text: stale ? "旧方案结果入库；不推进当前方案完成状态，不覆盖当前选用版本。" : "素材入库完成；候选等待人工检查与选用。" });
    if (targetProject.id === state.activeProjectId) toast(stale ? "旧方案结果已保留，当前选用版本保持不变。" : `镜头 ${numberShot(target)} 的新候选已就绪（模拟），可查看并选择版本。`);
  }

  function tickJobs() {
    let changed = false;
    const now = Date.now();
    state.projects.forEach(targetProject => targetProject.jobs.forEach(job => {
      const next = domain.nextJobStage(job, now);
      if (!next) return;
      job.stage = next;
      job.stageSince = now;
      if (next === "running" && !job.remoteTaskId) job.remoteTaskId = uid("demo-upstream");
      job.history.push({ at: now, text: `${stageLabels[next]} · ${next}` });
      if (next === "ready_for_review") completeJob(targetProject, job);
      changed = true;
    }));
    if (changed) { save(); render(); }
  }

  function cancelJob(id) {
    const job = project().jobs.find(item => item.id === id);
    if (!job || domain.terminalStages.includes(job.stage) || job.stage === "submission_unknown") return;
    const submitted = job.stage !== "prepared";
    job.stage = "cancelled";
    job.history.push({ at: Date.now(), text: "显式模拟取消。这里只演示已知任务的终止；真实上游取消与费用以其返回结果为准。" });
    if (submitted && !job.charged) { project().spent += job.estimate; job.charged = true; }
    save(); render(); toast(submitted ? "模拟任务已取消，保留已提交的演示费用；取消不等于退款。" : "尚未提交的模拟任务已取消，预留额度已释放。");
  }

  function showJobDetail(id) {
    const job = project().jobs.find(item => item.id === id);
    if (!job) return;
    openDetail("任务记录 · 演示", `<dl class="detail-definition"><dt>生成意图</dt><dd class="mono">${esc(job.operationId)}</dd><dt>上游尝试</dt><dd class="mono">${esc(job.attemptId)}</dd><dt>远端任务</dt><dd class="mono">${esc(job.remoteTaskId || "尚未取得明确任务 ID")}</dd><dt>输入快照</dt><dd>画面方案 v${job.visualRevision} · ${esc(modeLabels[job.snapshot.mode])} · ${job.snapshot.duration}s</dd><dt>当前状态</dt><dd class="mono">${esc(job.stage)}</dd><dt>成本记录</dt><dd>${job.estimate} 演示点，${job.charged ? "演示已记账" : domain.terminalStages.includes(job.stage) ? "未记账" : "预留中"}</dd></dl><ol class="event-list">${job.history.map(event => `<li><span class="mono">${esc(clock(event.at))}</span><span>${esc(event.text)}</span></li>`).join("")}</ol>`);
  }

  function startReconcile(id) {
    const job = project().jobs.find(item => item.id === id && item.stage === "submission_unknown");
    if (!job) return;
    reconcileJobId = id;
    $("#reconcile-summary").innerHTML = `<dl class="detail-definition"><dt>镜头</dt><dd>${esc(job.shotTitle)} · 旧画面方案 v${job.visualRevision}</dd><dt>原生成意图</dt><dd class="mono">${esc(job.operationId)}</dd><dt>额度</dt><dd>${job.estimate} 演示点继续占用，核对前不释放</dd></dl>`;
    $("#remote-task-id").value = job.remoteTaskId || "demo-upstream-017";
    $("#reconcile-dialog").showModal();
  }

  function finishReconcile() {
    const job = project().jobs.find(item => item.id === reconcileJobId && item.stage === "submission_unknown");
    const remoteId = $("#remote-task-id").value.trim();
    if (!job) return;
    if (!remoteId) { $("#remote-task-id").focus(); return toast("请填入一个演示任务 ID，以记录这次核对。"); }
    job.remoteTaskId = remoteId;
    job.stage = "provider_succeeded";
    job.stageSince = Date.now();
    job.history.push({ at: Date.now(), text: "人工触发核对演示：找到原任务结果，沿用原生成意图与尝试记录，未再次提交。" });
    $("#reconcile-dialog").close();
    save(); render();
    toast("模拟找到了原任务结果，开始入库；旧方案结果不会覆盖当前镜头。");
  }

  function adoptCandidate() {
    const current = shot();
    const candidate = previewCandidate();
    if (candidate.visualRevision !== current.visualRevision) return toast("这是旧画面方案的结果，不能直接标记当前方案完成。");
    if (current.selectedId === candidate.id) return;
    current.selectedId = candidate.id;
    touchTimeline();
    pushChange(current, `选用候选 v${candidate.version}`, "时间线素材引用已更新，其他候选继续保留。没有重新生成其他镜头。");
    save(); render();
    toast(candidate.humanApproved ? "选用版本已更新，其他候选保留。" : "已选用这版。到“审核与证据”标记人工确认后，可通过导出检查。");
  }

  function approveCandidate() {
    const current = shot();
    const candidate = previewCandidate();
    if (candidate.visualRevision !== current.visualRevision) return;
    candidate.humanApproved = true;
    pushChange(current, `候选 v${candidate.version} 已标记人工确认（演示）`, "只更新此候选的演示确认记录；没有把模型未检查项目改为通过。");
    save(); render(); toast("已记录人工确认（演示）。模型、动态与音频检查仍明确显示为未检查。");
  }

  function addLocalCandidate(origin) {
    const current = shot();
    const version = Math.max(...current.candidates.map(item => item.version)) + 1;
    const candidate = makeCandidate(current.id, version, current.visualRevision, origin, false, origin === "imported" ? "新导入示例" : "新排版示例");
    candidate.id = uid("demo-artifact");
    current.candidates.push(candidate);
    current.previewId = candidate.id;
    pushChange(current, origin === "imported" ? "新增导入占位素材" : "新增合成占位素材", "此操作只新增原型素材记录，没有访问本机文件或运行 FFmpeg。当前选用版本保持不变。");
    currentTab = "versions";
    save(); navigate("workbench");
    toast("新示例候选已保存，请检查并选择是否选用。没有读取或生成真实文件。");
  }

  function showImport() {
    const target = state.view === "assets" ? project().shots.find(item => item.kind === "imported") : shot();
    openDetail("导入示例素材", `<p class="detail-copy">将为镜头「${esc(target.title)}」新增一个静态占位版本。当前选用版本继续保留。</p><div class="callout neutral"><p>正式版会打开本机文件选择器、探测媒体并复制到项目目录。这个按钮仅演示素材入库与版本选择，不访问你的文件。</p></div>`, [{ id: "cancel-import", label: "取消" }, { id: `import:${target.id}`, label: "添加示例版本", primary: true }]);
  }

  function showSuggestion() {
    openDetail("镜头助手 · 修改建议", `<p class="detail-copy">针对镜头 ${numberShot(shot())}「${esc(shot().title)}」：</p><ul class="detail-list"><li>在画面意图中加入轻缓推镜与停顿，让节奏更有呼吸感。</li><li>只更新当前镜头的画面方案；字幕与其他镜头保持不变。</li><li>保留旧候选，标记当前画面素材需复核。不会自动生成。</li></ul><div class="callout neutral"><p>这是固定的示例建议，没有调用推理模型。</p></div>`, [{ id: "cancel-suggestion", label: "先不修改" }, { id: "apply-suggestion", label: "应用到当前镜头方案", primary: true }]);
  }

  function stopPlayback() {
    if (playback) clearInterval(playback.timer);
    playback = null;
    $("#play-label").textContent = "预览节奏";
    $("#play-story").setAttribute("aria-label", "预览分镜节奏，仅切换静态画面");
  }

  function togglePlayback() {
    if (playback) { stopPlayback(); renderTimeline(); return; }
    const startedAt = Date.now();
    const targetProject = project();
    playback = { startedAt, timer: null };
    $("#play-label").textContent = "停止预览";
    $("#play-story").setAttribute("aria-label", "停止分镜节奏预览");
    toast("按镜头时长切换静态概念图，不播放真实视频或声音。");
    playback.timer = setInterval(() => {
      const elapsed = Math.min((Date.now() - startedAt) / 1000, targetProject.duration);
      let boundary = 0;
      const current = targetProject.shots.find(item => { boundary += item.duration; return elapsed < boundary; }) || targetProject.shots[targetProject.shots.length - 1];
      if (state.activeShotId !== current.id) { state.activeShotId = current.id; renderWorkbench(); }
      $("#preview-time").textContent = `${timecode(elapsed)} / ${timecode(targetProject.duration)}`;
      $("#preview-progress-fill").style.width = `${elapsed / targetProject.duration * 100}%`;
      if (elapsed >= targetProject.duration) { stopPlayback(); save(); }
    }, 250);
  }

  function simulateExport() {
    const targetProject = project();
    if (!domain.exportChecks(targetProject).ok || exportIsRunning) return;
    const snapshotVersion = targetProject.timelineVersion;
    const resolution = $("#export-resolution").value;
    exportIsRunning = true;
    renderExport();
    toast(`正在演示时间线 v${snapshotVersion} 的本地合成流程，未运行媒体工具。`);
    renderTimer = setTimeout(() => {
      targetProject.lastExport = { timelineVersion: snapshotVersion, resolution, createdAt: Date.now(), demoOnly: true };
      exportIsRunning = false;
      save(); render();
      toast("渲染演示完成，没有生成视频文件。可以下载当前方案 JSON。");
    }, 1600);
  }

  function downloadPlan() {
    const currentProject = project();
    const checks = domain.exportChecks(currentProject);
    const manifest = {
      schema: "owntake.prototype.timeline/1", demoOnly: true,
      warning: "Static interaction prototype. Asset IDs refer to vector placeholders, not real media. No model or FFmpeg was called.",
      project: { id: currentProject.id, title: currentProject.title, brief: currentProject.brief, ratio: currentProject.ratio, duration: currentProject.duration },
      timelineVersion: currentProject.timelineVersion, requestedOutput: $("#export-resolution").value,
      readyInPrototype: checks.ok,
      blockingChecks: { missing: checks.missing.map(item => item.id), stale: checks.stale.map(item => item.id), unreviewed: checks.unreviewed.map(item => item.id) },
      shots: currentProject.shots.map(item => ({ id: item.id, order: item.number, duration: item.duration, visualRevision: item.visualRevision, subtitleRevision: item.subtitleRevision, subtitle: item.subtitle, selectedArtifact: selectedCandidate(item) || null }))
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `owntake-demo-timeline-v${currentProject.timelineVersion}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("已下载当前演示方案 JSON；它包含占位素材引用，不是视频文件。");
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("button, a[data-nav]");
    if (!button || button.disabled) return;
    if (button.hasAttribute("data-close")) { button.closest("dialog")?.close(); return; }
    if (button.dataset.nav) { event.preventDefault(); navigate(button.dataset.nav); return; }
    if (button.dataset.shot) { activateShot(button.dataset.shot); return; }
    if (button.dataset.project) {
      state.activeProjectId = button.dataset.project;
      state.activeShotId = project().shots[0].id;
      currentTab = "versions"; navigate("workbench"); return;
    }
    if (button.dataset.candidate) { shot().previewId = button.dataset.candidate; save(); renderWorkbench(); return; }
    if (button.dataset.tab) { currentTab = button.dataset.tab; renderTabs(); return; }
    if (button.dataset.filter) { assetFilter = button.dataset.filter; renderAssets(); return; }
    if (button.dataset.asset) {
      const target = project().shots.find(item => item.id === button.dataset.shotId);
      if (!target) return;
      target.previewId = button.dataset.asset; activateShot(target.id); return;
    }
    if (button.dataset.jobDetail) { showJobDetail(button.dataset.jobDetail); return; }
    if (button.dataset.reconcile) { startReconcile(button.dataset.reconcile); return; }
    if (button.dataset.cancelJob) { cancelJob(button.dataset.cancelJob); return; }
    if (button.dataset.jobCandidate) {
      const job = project().jobs.find(item => item.id === button.dataset.jobCandidate);
      const target = project().shots.find(item => item.id === job?.shotId);
      if (target && job.artifactId) { target.previewId = job.artifactId; activateShot(target.id); }
      return;
    }
    if (button.dataset.fixShot) { activateShot(button.dataset.fixShot, button.dataset.review === "true" ? "review" : "versions"); return; }
    if (button.dataset.detailAction) {
      const action = button.dataset.detailAction;
      $("#detail-dialog").close();
      if (action === "apply-suggestion") changeVisualIntent(`${shot().intent} 镜头增加轻缓推近，并在关键画面留出短暂停顿。`, "应用了镜头助手的示例建议");
      else if (action.startsWith("import:")) { state.activeShotId = action.slice(7); addLocalCandidate("imported"); }
      return;
    }
    const action = button.dataset.action;
    if (action === "new-project") {
      if (state.projects.length >= 40) return toast("原型最多保存 40 个演示项目；可重置演示数据后继续。");
      $("#new-project-form").reset(); $("#new-project-dialog").showModal(); return;
    }
    if (action === "show-brief") { showBrief(); return; }
    if (action === "import-demo") { showImport(); return; }
    if (action === "rebuild-composite") { addLocalCandidate("composite"); return; }
    if (action === "approve-candidate") { approveCandidate(); return; }
  });

  $("#new-project-form").addEventListener("submit", event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    const brief = String(form.get("brief") || "").trim();
    if (!title || !brief) return;
    const next = makeProject({ title, brief, ratio: String(form.get("ratio")), style: String(form.get("style")) });
    state.projects.unshift(next); state.activeProjectId = next.id; state.activeShotId = next.shots[0].id;
    $("#new-project-dialog").close(); currentTab = "versions"; navigate("workbench");
    toast("演示项目已创建，载入四镜头模板；未调用模型编写剧情。");
  });

  $("#subtitle-form").addEventListener("submit", event => {
    event.preventDefault();
    const current = shot();
    const next = $("#shot-subtitle").value.trim();
    if (next === current.subtitle) return toast("字幕没有变化。");
    current.subtitle = next; current.subtitleRevision += 1; touchTimeline();
    pushChange(current, `字幕更新为 v${current.subtitleRevision}`, "仅使字幕与最终合成过期；画面方案、所有候选和生成任务保持不变。");
    currentTab = "changes"; save(); render();
    toast("字幕已保存。只需重新合成；无需重生成任何镜头。");
  });

  $("#save-intent").addEventListener("click", () => {
    const next = $("#shot-intent").value.trim();
    if (!next) return toast("请填写画面意图。");
    if (next === shot().intent) return toast("画面意图没有变化。");
    changeVisualIntent(next);
  });
  $("#shot-intent").addEventListener("input", () => { if (shot().kind === "generated") renderGenerationSettings(); });

  ["#shot-provider", "#shot-mode"].forEach(selector => {
    $(selector).addEventListener("change", event => {
      const current = shot();
      const field = selector === "#shot-provider" ? "provider" : "mode";
      current[field] = event.target.value;
      current.planRevision += 1; current.planApproved = false;
      pushChange(current, field === "provider" ? "视频适配器已更换" : "生成方式已更改", "仅影响下一次生成方案；已选用素材与历史候选不变，提交前需重新确认。");
      save(); render();
      toast(domain.compatibility(current, project().ratio).ok ? "生成方案已变更，请重新确认。已有素材保持不变。" : "当前能力不兼容，已阻止提交。尾帧约束不会被自动丢弃。");
    });
  });
  $("#approve-plan").addEventListener("change", event => { shot().planApproved = event.target.checked; save(); renderGenerationSettings(); });
  $("#submit-generation").addEventListener("click", submitGeneration);
  $("#adopt-candidate").addEventListener("click", adoptCandidate);
  $("#reconcile-found").addEventListener("click", finishReconcile);
  $("#suggest-revision").addEventListener("click", showSuggestion);
  $("#play-story").addEventListener("click", togglePlayback);
  $("#simulate-export").addEventListener("click", simulateExport);
  $("#download-plan").addEventListener("click", downloadPlan);
  $("#check-environment").addEventListener("click", () => { environmentChecked = true; renderSettings(); toast("已展示模拟检查结果，没有探测这台设备的 Node、FFmpeg 或文件路径。"); });
  $("#settings-form").addEventListener("submit", event => {
    event.preventDefault();
    const budget = Number($("#demo-budget").value);
    const concurrency = Number($("#max-concurrency").value);
    if (!Number.isInteger(budget) || budget < 6 || budget > 999 || ![1, 2, 3].includes(concurrency)) return;
    project().budget = budget; state.settings.maxConcurrency = concurrency;
    save(); render(); toast("已保存当前项目的演示额度与全局演示并发设置。");
  });
  $("#reset-demo").addEventListener("click", () => $("#reset-dialog").showModal());
  $("#confirm-reset").addEventListener("click", () => {
    stopPlayback(); clearTimeout(renderTimer); exportIsRunning = false;
    state = initialState(); currentTab = "versions"; assetFilter = "all"; environmentChecked = false;
    $("#reset-dialog").close(); save(); render(); toast("已恢复初始演示项目，未访问本机其他文件。");
  });
  $("#export-resolution").addEventListener("change", event => { project().outputResolution = event.target.value; save(); renderExport(); if (project().lastExport) toast("输出规格已调整，下次模拟渲染会记录新的规格。"); });

  // Accessible arrow-key tab navigation; all other controls are native buttons/inputs.
  $(".detail-tabs").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = $$("[data-tab]");
    const index = tabs.findIndex(button => button.dataset.tab === currentTab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); currentTab = tabs[next].dataset.tab; renderTabs(); tabs[next].focus();
  });
  $$("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }));

  const hashView = location.hash.slice(1);
  if (validViews.includes(hashView)) state.view = hashView;
  render();
  save();
  setInterval(tickJobs, 400);
  // Read-only inspection is useful for manual QA; it is not an application API.
  window.OwnTakeDemo = Object.freeze({ getState: () => JSON.parse(JSON.stringify(state)), domain });
})();
