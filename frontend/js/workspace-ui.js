/**
 * LintIQ — workspace-ui.js
 * All UI controller logic for the workspace page (index.html):
 *   - Left-pane tab switching (Description / Scratchpad)
 *   - Tray tab switching (Testcase / Sandbox Output) & collapse
 *   - Editor fullscreen toggle & code formatting
 *   - Settings dropdown & modal tab controller
 *   - Profile form load/save & summary UI
 *   - Editor preferences load/apply
 *   - Chart.js analytics graph renderer
 *   - Scratchpad auto-save
 *   - MutationObserver for console → auto-switch output tab
 *   - MutationObserver for streak mirror on mobile
 *   - ResizeObserver for Monaco layout
 *   - Export & reset helpers
 *
 * Depends on: shared.js (currentUser, getDisplayUsername), Chart.js (CDN), Monaco (workspace.js)
 */

const LINTIQ_PREFS_KEY = "lintiq_editor_prefs_v1";
const LINTIQ_NOTES_KEY = "lintiq_workspace_notes_v1";
let lintiqChartInstance = null;
let isTrayCollapsed = false;
let isEditorFullscreen = false;

// ─── LEFT-PANE TABS ──────────────────────────────────────────────────────────
function switchLeftTab(tab) {
  const descBtn = document.getElementById("left-tab-btn-desc");
  const notesBtn = document.getElementById("left-tab-btn-notes");
  const descPanel = document.getElementById("left-tab-panel-desc");
  const notesPanel = document.getElementById("left-tab-panel-notes");

  const activeClasses = ["font-semibold", "text-white", "bg-surface", "border-accent"];
  const inactiveClasses = ["text-gray-400", "border-transparent"];

  if (tab === "notes") {
    descPanel?.classList.add("hidden");
    notesPanel?.classList.remove("hidden");
    descBtn?.classList.remove(...activeClasses);
    descBtn?.classList.add(...inactiveClasses);
    notesBtn?.classList.remove(...inactiveClasses);
    notesBtn?.classList.add(...activeClasses);
  } else {
    notesPanel?.classList.add("hidden");
    descPanel?.classList.remove("hidden");
    notesBtn?.classList.remove(...activeClasses);
    notesBtn?.classList.add(...inactiveClasses);
    descBtn?.classList.remove(...inactiveClasses);
    descBtn?.classList.add(...activeClasses);
  }
}

function handleHintClick() {
  switchLeftTab("desc");
  if (typeof requestHint === "function") requestHint();
  setTimeout(() => {
    document.getElementById("hint-box")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 60);
}

// ─── TRAY TABS & COLLAPSE ────────────────────────────────────────────────────
function switchTrayTab(tab) {
  if (isTrayCollapsed) toggleTrayCollapse(false);

  const tcBtn = document.getElementById("tray-tab-btn-testcase");
  const outBtn = document.getElementById("tray-tab-btn-output");
  const tcPanel = document.getElementById("tray-panel-testcase");
  const outPanel = document.getElementById("tray-panel-output");
  const stdinWrapper = document.getElementById("custom-stdin-wrapper");

  if (tab === "output") {
    tcPanel?.classList.add("hidden");
    outPanel?.classList.remove("hidden");
    tcBtn?.classList.remove("font-semibold", "text-white", "border-accent");
    tcBtn?.classList.add("text-gray-400", "border-transparent");
    outBtn?.classList.remove("text-gray-400", "border-transparent");
    outBtn?.classList.add("font-semibold", "text-white", "border-accent");
  } else {
    outPanel?.classList.add("hidden");
    tcPanel?.classList.remove("hidden");
    stdinWrapper?.classList.remove("hidden");
    outBtn?.classList.remove("font-semibold", "text-white", "border-accent");
    outBtn?.classList.add("text-gray-400", "border-transparent");
    tcBtn?.classList.remove("text-gray-400", "border-transparent");
    tcBtn?.classList.add("font-semibold", "text-white", "border-accent");
  }
}

function toggleTrayCollapse(forceState) {
  const tray = document.getElementById("workspace-tray");
  const body = document.getElementById("workspace-tray-body");
  const btn = document.getElementById("btn-collapse-tray");
  isTrayCollapsed = typeof forceState === "boolean" ? forceState : !isTrayCollapsed;

  if (isTrayCollapsed) {
    body?.classList.add("hidden");
    tray?.classList.remove("h-52");
    tray?.classList.add("h-20");
    if (btn) btn.textContent = "▴";
  } else {
    body?.classList.remove("hidden");
    tray?.classList.remove("h-20");
    tray?.classList.add("h-52");
    if (btn) btn.textContent = "▾";
  }
  requestAnimationFrame(() => window.editor?.layout?.());
}

// ─── EDITOR FULLSCREEN & FORMAT ──────────────────────────────────────────────
function toggleEditorFullscreen() {
  const leftPane = document.getElementById("workspace-left-pane");
  const rightPane = document.getElementById("workspace-right-pane");
  isEditorFullscreen = !isEditorFullscreen;

  if (isEditorFullscreen) {
    leftPane?.classList.add("lg:hidden");
    rightPane?.classList.remove("lg:w-[54%]", "xl:w-1/2");
    rightPane?.classList.add("lg:w-full");
  } else {
    leftPane?.classList.remove("lg:hidden");
    rightPane?.classList.remove("lg:w-full");
    rightPane?.classList.add("lg:w-[54%]", "xl:w-1/2");
  }
  requestAnimationFrame(() => window.editor?.layout?.());
}

function formatWorkspaceCode() {
  if (window.editor) {
    window.editor.getAction("editor.action.formatDocument")?.run();
  }
}

// ─── SCRATCHPAD ──────────────────────────────────────────────────────────────
function clearWorkspaceNotes() {
  const el = document.getElementById("workspace-notes-input");
  if (el) {
    el.value = "";
    localStorage.removeItem(LINTIQ_NOTES_KEY);
  }
}

// ─── SETTINGS DROPDOWN HELPERS PROVIDED BY shared.js ────────────────────────
function openSettingsAtTab(tabName) {
  closeSettingsDropdown();
  openSettingsModal();
  switchSettingsTab(tabName);
}

// ─── SETTINGS MODAL TABS ─────────────────────────────────────────────────────
function switchSettingsTab(tabName) {
  document.querySelectorAll(".settings-tab-panel").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".settings-tab-btn").forEach(b => {
    b.classList.remove("border-emerald-500", "text-emerald-400", "font-semibold");
    b.classList.add("border-transparent", "text-zinc-400");
  });

  document.getElementById(`settings-panel-${tabName}`)?.classList.remove("hidden");
  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  if (activeBtn) {
    activeBtn.classList.remove("border-transparent", "text-zinc-400");
    activeBtn.classList.add("border-emerald-500", "text-emerald-400", "font-semibold");
  }

  if (tabName === "analytics") {
    requestAnimationFrame(() => renderLintIQActivityChart());
  }
}

function openSettingsModal() {
  document.getElementById("settings-modal")?.classList.remove("hidden");
  loadLocalProfile();
  loadEditorPrefs();
}

function closeSettingsModal() {
  document.getElementById("settings-modal")?.classList.add("hidden");
}

// ─── PROFILE FORM & SUMMARY ─────────────────────────────────────────────────
function getProfileStorageKey() {
  const uid = currentUser?.id || "guest";
  return `lintiq_user_profile_${uid}`;
}

function getMetricsStorageKey() {
  const uid = currentUser?.id || null;
  return uid ? `lintiq_user_metrics_${uid}` : null;
}

function getDefaultProfileFromAuth() {
  const user = currentUser || null;
  const fullName = user && typeof getDisplayUsername === "function"
    ? getDisplayUsername(user)
    : "Guest Engineer";
  const email = user?.email || "";
  const github = user?.user_metadata?.user_name || "";

  return {
    full_name: fullName,
    github,
    email,
    location: "India",
    bio: "LintIQ Bug Hunter",
    website: github ? `https://github.com/${github}` : "",
    language: "python"
  };
}

function getDefaultLintIQMetrics() {
  return {
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    patchesSolved: [0, 0, 0, 0, 0, 0, 0],
    avgLatencyMs: [0, 0, 0, 0, 0, 0, 0],
    totalAccepted: 0,
    totalAttempts: 0,
    passRate: 0,
    bestStreak: 0
  };
}

function updateProfileSummaryUI(p) {
  const cleanName = (p.full_name || "Guest Engineer").trim();
  const el = (id) => document.getElementById(id);
  el("profile-display-name") && (el("profile-display-name").textContent = cleanName);
  el("profile-display-role") && (el("profile-display-role").textContent = (p.bio || "LintIQ Bug Hunter").trim());
  el("profile-display-github") && (el("profile-display-github").textContent = p.github ? `@${p.github.replace(/^@/, "")}` : "");
  el("summary-location") && (el("summary-location").textContent = p.location || "India");

  const langMap = { python: "Python 3.11", javascript: "JavaScript (Node.js)", cpp: "C++20" };
  el("summary-lang") && (el("summary-lang").textContent = langMap[p.language] || "Python 3.11");

  const initials = cleanName.split(/\s+/).filter(Boolean).map(part => part[0]).join("").toUpperCase().slice(0, 2) || "LQ";
  el("profile-initials") && (el("profile-initials").textContent = initials);
  const headerAvatar = el("header-user-avatar");
  if (headerAvatar) headerAvatar.textContent = initials;
}

function loadLocalProfile() {
  const defaults = getDefaultProfileFromAuth();
  const saved = JSON.parse(localStorage.getItem(getProfileStorageKey()) || "null");
  const profile = saved ? { ...defaults, ...saved } : defaults;

  const el = (id) => document.getElementById(id);
  if (el("input-fullname")) el("input-fullname").value = profile.full_name || "";
  if (el("input-github")) el("input-github").value = profile.github || "";
  if (el("input-email")) el("input-email").value = profile.email || "";
  if (el("input-location")) el("input-location").value = profile.location || "India";
  if (el("input-bio")) el("input-bio").value = profile.bio || "";
  if (el("input-website")) el("input-website").value = profile.website || "";
  if (el("input-lang")) el("input-lang").value = profile.language || "python";
  updateProfileSummaryUI(profile);
}

function saveUserProfile(event) {
  event.preventDefault();
  const payload = {
    full_name: document.getElementById("input-fullname").value.trim(),
    github: document.getElementById("input-github").value.trim(),
    email: document.getElementById("input-email").value.trim(),
    location: document.getElementById("input-location").value.trim(),
    bio: document.getElementById("input-bio").value.trim(),
    website: document.getElementById("input-website").value.trim(),
    language: document.getElementById("input-lang").value
  };

  localStorage.setItem(getProfileStorageKey(), JSON.stringify(payload));
  updateProfileSummaryUI(payload);

  const statusEl = document.getElementById("profile-save-status");
  if (statusEl) {
    statusEl.textContent = "Saved!";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  }
}

// ─── EDITOR PREFERENCES ─────────────────────────────────────────────────────
function applyEditorPrefs() {
  const fontSize = parseInt(document.getElementById("pref-fontsize")?.value, 10) || 14;
  const tabSize = parseInt(document.getElementById("pref-tabsize")?.value, 10) || 4;
  const minimap = document.getElementById("pref-minimap")?.checked || false;
  const wordWrap = document.getElementById("pref-wordwrap")?.checked ? "on" : "off";
  const autoTimer = document.getElementById("pref-autotimer")?.checked ?? true;
  const astWarn = document.getElementById("pref-astwarn")?.checked ?? true;

  const valEl = document.getElementById("editor-fontsize-val");
  if (valEl) valEl.textContent = `${fontSize}px`;

  const prefs = { fontSize, tabSize, minimap, wordWrap, autoTimer, astWarn };
  localStorage.setItem(LINTIQ_PREFS_KEY, JSON.stringify(prefs));

  if (window.editor && typeof window.editor.updateOptions === "function") {
    window.editor.updateOptions({ fontSize, tabSize, minimap: { enabled: minimap }, wordWrap });
  }
}

function loadEditorPrefs() {
  const prefs = JSON.parse(localStorage.getItem(LINTIQ_PREFS_KEY) || "null");
  if (!prefs) return;
  const el = (id) => document.getElementById(id);
  if (el("pref-fontsize")) el("pref-fontsize").value = prefs.fontSize || 14;
  if (el("pref-tabsize")) el("pref-tabsize").value = prefs.tabSize || 4;
  if (el("pref-minimap")) el("pref-minimap").checked = Boolean(prefs.minimap);
  if (el("pref-wordwrap")) el("pref-wordwrap").checked = prefs.wordWrap !== "off";
  if (el("pref-autotimer")) el("pref-autotimer").checked = prefs.autoTimer !== false;
  if (el("pref-astwarn")) el("pref-astwarn").checked = prefs.astWarn !== false;
  applyEditorPrefs();
}

// ─── CHART.JS ANALYTICS ─────────────────────────────────────────────────────
function renderLintIQActivityChart() {
  const loggedOutEl = document.getElementById("analytics-logged-out");
  const authContentEl = document.getElementById("analytics-auth-content");
  const metricsKey = getMetricsStorageKey();

  if (!metricsKey) {
    loggedOutEl?.classList.remove("hidden");
    authContentEl?.classList.add("hidden");
    if (lintiqChartInstance) { lintiqChartInstance.destroy(); lintiqChartInstance = null; }
    return;
  }

  loggedOutEl?.classList.add("hidden");
  authContentEl?.classList.remove("hidden");

  const accountNameEl = document.getElementById("analytics-account-name");
  if (accountNameEl && typeof getDisplayUsername === "function" && currentUser) {
    accountNameEl.textContent = getDisplayUsername(currentUser);
  }

  const metrics = JSON.parse(localStorage.getItem(metricsKey) || "null") || getDefaultLintIQMetrics();
  const totalSolves = Math.max(metrics.totalAccepted || 0, typeof solves === "number" ? solves : 0);
  const bestStreak = Math.max(metrics.bestStreak || 0, typeof streak === "number" ? streak : 0);
  const latestMs = metrics.avgLatencyMs[metrics.avgLatencyMs.length - 1] || 0;

  const el = (id) => document.getElementById(id);
  if (el("stat-patches")) el("stat-patches").textContent = totalSolves;
  if (el("stat-runtime")) el("stat-runtime").textContent = `${latestMs} ms`;
  if (el("stat-accuracy")) el("stat-accuracy").textContent = `${metrics.passRate || 0}%`;
  if (el("stat-best-streak")) el("stat-best-streak").textContent = bestStreak;

  const canvas = document.getElementById("lintiq-activity-chart");
  if (!canvas || typeof Chart === "undefined") return;
  if (lintiqChartInstance) lintiqChartInstance.destroy();

  lintiqChartInstance = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: metrics.labels,
      datasets: [
        { label: "Bugs Patched", data: metrics.patchesSolved, borderColor: "#34d399", backgroundColor: "rgba(52, 211, 153, 0.16)", borderWidth: 2, tension: 0.35, fill: true, yAxisID: "y" },
        { label: "Exec Latency (ms)", data: metrics.avgLatencyMs, borderColor: "#38bdf8", backgroundColor: "rgba(56, 189, 248, 0.1)", borderWidth: 2, borderDash: [4, 4], tension: 0.35, fill: false, yAxisID: "y1" }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#d4d4d8", font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: "#a1a1aa", font: { size: 11 } }, grid: { color: "rgba(63, 63, 70, 0.4)" } },
        y: { type: "linear", position: "left", beginAtZero: true, ticks: { color: "#34d399", stepSize: 1, font: { size: 11 } }, grid: { color: "rgba(63, 63, 70, 0.4)" } },
        y1: { type: "linear", position: "right", beginAtZero: true, ticks: { color: "#38bdf8", font: { size: 11 } }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

// ─── RESET METRICS (exportLintIQData provided by shared.js) ───────────────────
function resetLintIQMetrics() {
  const metricsKey = getMetricsStorageKey();
  if (!metricsKey) return;
  localStorage.setItem(metricsKey, JSON.stringify(getDefaultLintIQMetrics()));
  renderLintIQActivityChart();
}

// ─── SYNC HOOK ───────────────────────────────────────────────────────────────
window.syncSettingsModalAuth = function () {
  loadLocalProfile();
  const modal = document.getElementById("settings-modal");
  if (modal && !modal.classList.contains("hidden")) {
    const analyticsPanel = document.getElementById("settings-panel-analytics");
    if (analyticsPanel && !analyticsPanel.classList.contains("hidden")) {
      renderLintIQActivityChart();
    }
  }
};

// ─── DOM-READY BOOTSTRAP ─────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  loadEditorPrefs();

  // Scratchpad auto-save
  const notesEl = document.getElementById("workspace-notes-input");
  if (notesEl) {
    notesEl.value = localStorage.getItem(LINTIQ_NOTES_KEY) || "";
    notesEl.addEventListener("input", () => {
      localStorage.setItem(LINTIQ_NOTES_KEY, notesEl.value);
    });
  }

  // Auto-switch to output tab when console content changes
  const consoleEl = document.getElementById("console-output");
  if (consoleEl && typeof MutationObserver !== "undefined") {
    let initialSkip = true;
    new MutationObserver(() => {
      if (initialSkip) { initialSkip = false; return; }
      switchTrayTab("output");
    }).observe(consoleEl, { childList: true, characterData: true, subtree: true });
  }

  // Mirror streak count to mobile badge
  const streakEl = document.getElementById("streak-count");
  const mobileStreakEl = document.getElementById("mobile-streak-mirror");
  if (streakEl && mobileStreakEl && typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      mobileStreakEl.textContent = streakEl.textContent;
    }).observe(streakEl, { childList: true, characterData: true, subtree: true });
  }

  // Auto-layout Monaco on resize
  const editorEl = document.getElementById("editor-container");
  if (editorEl && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (window.editor && typeof window.editor.layout === "function") {
        window.editor.layout();
      }
    }).observe(editorEl);
  }
});

// ─── EXPOSE GLOBALS ──────────────────────────────────────────────────────────
window.switchLeftTab = switchLeftTab;
window.handleHintClick = handleHintClick;
window.switchTrayTab = switchTrayTab;
window.toggleTrayCollapse = toggleTrayCollapse;
window.toggleEditorFullscreen = toggleEditorFullscreen;
window.formatWorkspaceCode = formatWorkspaceCode;
window.clearWorkspaceNotes = clearWorkspaceNotes;
window.openSettingsAtTab = openSettingsAtTab;
window.switchSettingsTab = switchSettingsTab;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.saveUserProfile = saveUserProfile;
window.applyEditorPrefs = applyEditorPrefs;
window.resetLintIQMetrics = resetLintIQMetrics;
window.fillSampleInput = typeof fillSampleInput !== "undefined" ? fillSampleInput : function() {};
window.clearCustomInput = typeof clearCustomInput !== "undefined" ? clearCustomInput : function() {};
