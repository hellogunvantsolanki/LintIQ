/**
 * LintIQ — settings.js
 * Shared controller for settings-profile.html, settings-editor.html, and settings-dashboard.html.
 * Depends on: shared.js (API, supabaseClient, currentUser, initAuth, getDisplayUsername, getInitials, escapeHtml)
 */

const SETTINGS_PREFS_KEY = "lintiq_editor_prefs_v1";
const DEFAULT_EDITOR_PREFS = {
  fontSize: 14,
  tabSize: 4,
  minimap: false,
  wordWrap: "on",
  autoTimer: true,
  astWarn: true,
};

const RUNTIME_LABELS = {
  python: "Python 3.11",
  javascript: "JavaScript (Node)",
  cpp: "C++20",
};

let settingsChartInstance = null;

function getSettingsProfileKey() {
  const uid = currentUser?.id || "guest";
  return `lintiq_user_profile_${uid}`;
}

function getSettingsMetricsKey() {
  return currentUser?.id ? `lintiq_user_metrics_${currentUser.id}` : null;
}

function getDefaultProfile() {
  const user = currentUser || null;
  const fullName = user ? getDisplayUsername(user) : "Guest Engineer";
  const email = user?.email || "";
  const github = user?.user_metadata?.user_name || "";
  return {
    full_name: fullName,
    github,
    email,
    location: "",
    bio: "LintIQ Bug Hunter",
    website: github ? `https://github.com/${github}` : "",
    language: "python",
  };
}

function getDefaultMetrics() {
  return {
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    patchesSolved: [0, 0, 0, 0, 0, 0, 0],
    avgLatencyMs: [0, 0, 0, 0, 0, 0, 0],
    totalAccepted: 0,
    totalAttempts: 0,
    passRate: 0,
    bestStreak: 0,
  };
}

function computeRankTier(score) {
  if (score >= 5000) return "Principal Auditor";
  if (score >= 2500) return "Staff Bug Hunter";
  if (score >= 1000) return "Bug Hunter III";
  if (score >= 300) return "Bug Hunter II";
  return "Bug Hunter I";
}

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

// ─── PAGE 1: SETTINGS PROFILE ────────────────────────────────────────────────
function updateProfileCardUI(profile, cloudStats = null) {
  const el = (id) => document.getElementById(id);
  const cleanName = (profile.full_name || "Guest Engineer").trim();
  const initials = getInitials(cleanName);

  if (el("card-avatar-initials")) el("card-avatar-initials").textContent = initials;
  if (el("card-display-name")) el("card-display-name").textContent = cleanName;
  if (el("card-display-bio")) el("card-display-bio").textContent = (profile.bio || "LintIQ Bug Hunter").trim();
  if (el("card-primary-stack")) el("card-primary-stack").textContent = RUNTIME_LABELS[profile.language] || "Python 3.11";
  if (el("card-location")) el("card-location").textContent = profile.location || "Not set";

  const score = cloudStats?.score ?? parseInt(localStorage.getItem("lintiq_score") || "0", 10);
  const solves = cloudStats?.solves ?? parseInt(localStorage.getItem("lintiq_solves") || "0", 10);
  const streak = cloudStats?.streak ?? parseInt(localStorage.getItem("lintiq_streak") || "0", 10);

  if (el("card-rank-tier")) el("card-rank-tier").textContent = `★ ${computeRankTier(score)}`;
  if (el("card-solved-count")) el("card-solved-count").textContent = `${Number(solves)} bugs`;
  if (el("card-score-count")) el("card-score-count").textContent = `${Number(score).toLocaleString()} pts`;
  if (el("card-streak-count")) el("card-streak-count").textContent = `${Number(streak)} ${streak === 1 ? "day" : "days"}`;

  if (el("settings-footer-account")) {
    el("settings-footer-account").textContent = currentUser?.id
      ? `Account: ${currentUser.id.slice(0, 8)}… · LintIQ`
      : "Session: Local Guest · Sign in to sync cloud progress";
  }

  const headerAvatar = el("header-user-avatar");
  if (headerAvatar && currentUser) headerAvatar.textContent = initials;
  const headerName = el("user-display-name");
  if (headerName && currentUser) headerName.textContent = cleanName;
}

async function initProfileSettingsPage() {
  const defaults = getDefaultProfile();
  const saved = readLocalJson(getSettingsProfileKey(), null);
  const profile = saved ? { ...defaults, ...saved } : defaults;

  const el = (id) => document.getElementById(id);
  if (el("input-fullname")) el("input-fullname").value = profile.full_name || "";
  if (el("input-github")) el("input-github").value = profile.github || "";
  if (el("input-email")) el("input-email").value = profile.email || "";
  if (el("input-location")) el("input-location").value = profile.location || "";
  if (el("input-bio")) el("input-bio").value = profile.bio || "";
  if (el("input-website")) el("input-website").value = profile.website || "";
  if (el("input-lang")) el("input-lang").value = RUNTIME_LABELS[profile.language] ? profile.language : "python";

  updateProfileCardUI(profile);

  if (currentUser?.id) {
    try {
      const { data: cloudProfile } = await supabaseClient
        .from("user_profiles")
        .select("score, streak, solves")
        .eq("id", currentUser.id)
        .maybeSingle();

      if (cloudProfile) {
        updateProfileCardUI(profile, cloudProfile);
      }
    } catch (err) {
      console.warn("Profile cloud stats lookup skipped:", err);
    }
  }
}

function saveSettingsProfile(event) {
  if (event) event.preventDefault();
  const el = (id) => document.getElementById(id);
  const payload = {
    full_name: el("input-fullname")?.value.trim() || "Guest Engineer",
    github: el("input-github")?.value.trim() || "",
    email: el("input-email")?.value.trim() || "",
    location: el("input-location")?.value.trim() || "",
    bio: el("input-bio")?.value.trim() || "LintIQ Bug Hunter",
    website: el("input-website")?.value.trim() || "",
    language: el("input-lang")?.value || "python",
  };

  localStorage.setItem(getSettingsProfileKey(), JSON.stringify(payload));
  updateProfileCardUI(payload);

  const statusEl = el("profile-save-status");
  if (statusEl) {
    statusEl.textContent = "Saved!";
    statusEl.classList.remove("hidden");
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2500);
  }
}

// ─── PAGE 2: SETTINGS EDITOR ─────────────────────────────────────────────────
function readEditorPrefsFromStorage() {
  const saved = readLocalJson(SETTINGS_PREFS_KEY, null);
  return saved ? { ...DEFAULT_EDITOR_PREFS, ...saved } : { ...DEFAULT_EDITOR_PREFS };
}

function syncEditorControlsFromPrefs(prefs) {
  const el = (id) => document.getElementById(id);
  const fontSize = Math.min(20, Math.max(12, parseInt(prefs.fontSize, 10) || 14));
  const tabSize = parseInt(prefs.tabSize, 10) === 2 ? 2 : 4;

  if (el("pref-fontsize")) el("pref-fontsize").value = String(fontSize);
  if (el("font-size-val")) el("font-size-val").textContent = `${fontSize}px`;
  if (el("pref-tabsize")) el("pref-tabsize").value = String(tabSize);
  if (el("pref-minimap")) el("pref-minimap").checked = Boolean(prefs.minimap);
  if (el("pref-wordwrap")) el("pref-wordwrap").checked = prefs.wordWrap !== "off";
  if (el("pref-autotimer")) el("pref-autotimer").checked = prefs.autoTimer !== false;
  if (el("pref-astwarn")) el("pref-astwarn").checked = prefs.astWarn !== false;
}

function saveEditorPrefsFromControls() {
  const el = (id) => document.getElementById(id);
  const fontSize = Math.min(20, Math.max(12, parseInt(el("pref-fontsize")?.value, 10) || 14));
  const tabSize = parseInt(el("pref-tabsize")?.value, 10) === 2 ? 2 : 4;
  const minimap = Boolean(el("pref-minimap")?.checked);
  const wordWrap = el("pref-wordwrap")?.checked ? "on" : "off";
  const autoTimer = el("pref-autotimer")?.checked ?? true;
  const astWarn = el("pref-astwarn")?.checked ?? true;

  if (el("font-size-val")) el("font-size-val").textContent = `${fontSize}px`;

  const prefs = { fontSize, tabSize, minimap, wordWrap, autoTimer, astWarn };
  localStorage.setItem(SETTINGS_PREFS_KEY, JSON.stringify(prefs));

  const statusEl = el("editor-pref-status");
  if (statusEl) {
    statusEl.textContent = "● Saved to browser preferences";
    setTimeout(() => {
      statusEl.textContent = "● Preferences applied live";
    }, 1500);
  }
}

function resetEditorDefaults() {
  localStorage.setItem(SETTINGS_PREFS_KEY, JSON.stringify(DEFAULT_EDITOR_PREFS));
  syncEditorControlsFromPrefs(DEFAULT_EDITOR_PREFS);
  const statusEl = document.getElementById("editor-pref-status");
  if (statusEl) {
    statusEl.textContent = "● Defaults restored (14px, 4 spaces)";
  }
}

function initEditorSettingsPage() {
  const prefs = readEditorPrefsFromStorage();
  syncEditorControlsFromPrefs(prefs);

  const sessionBadge = document.getElementById("editor-session-badge");
  if (sessionBadge) {
    sessionBadge.textContent = currentUser ? "Synced account" : "Local session";
  }
  const footerMeta = document.getElementById("settings-footer-account");
  if (footerMeta) {
    footerMeta.textContent = currentUser?.id
      ? `Account: ${currentUser.id.slice(0, 8)}… · LintIQ`
      : "Session: Local Guest · Preferences saved locally";
  }
}

// ─── PAGE 3: SETTINGS DASHBOARD ──────────────────────────────────────────────
function renderDashboardChart(metrics) {
  const canvas = document.getElementById("settings-activity-chart");
  if (!canvas || typeof Chart === "undefined") return;

  if (settingsChartInstance) {
    settingsChartInstance.destroy();
    settingsChartInstance = null;
  }

  settingsChartInstance = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: metrics.labels || ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      datasets: [
        {
          label: "Bugs Patched",
          data: metrics.patchesSolved || [0, 0, 0, 0, 0, 0, 0],
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.16)",
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          yAxisID: "y",
        },
        {
          label: "Exec Latency (ms)",
          data: metrics.avgLatencyMs || [0, 0, 0, 0, 0, 0, 0],
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56, 189, 248, 0.1)",
          borderWidth: 2,
          borderDash: [4, 4],
          tension: 0.35,
          fill: false,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: "#cbd5e1", font: { size: 11 } },
        },
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", font: { size: 11 } },
          grid: { color: "rgba(35, 41, 56, 0.6)" },
        },
        y: {
          type: "linear",
          position: "left",
          beginAtZero: true,
          ticks: { color: "#10b981", stepSize: 1, font: { size: 11 } },
          grid: { color: "rgba(35, 41, 56, 0.6)" },
        },
        y1: {
          type: "linear",
          position: "right",
          beginAtZero: true,
          ticks: { color: "#38bdf8", font: { size: 11 } },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

async function initDashboardSettingsPage() {
  const loggedOutEl = document.getElementById("dashboard-logged-out");
  const authContentEl = document.getElementById("dashboard-auth-content");
  const sessionBadge = document.getElementById("dashboard-session-badge");
  const footerMeta = document.getElementById("settings-footer-account");

  if (!currentUser?.id) {
    loggedOutEl?.classList.remove("hidden");
    authContentEl?.classList.add("hidden");
    authContentEl?.classList.remove("flex");
    if (sessionBadge) sessionBadge.textContent = "Guest — Sign in required";
    if (footerMeta) footerMeta.textContent = "Sign in to view account telemetry";
    if (settingsChartInstance) {
      settingsChartInstance.destroy();
      settingsChartInstance = null;
    }
    return;
  }

  loggedOutEl?.classList.add("hidden");
  authContentEl?.classList.remove("hidden");
  authContentEl?.classList.add("flex");
  if (sessionBadge) sessionBadge.textContent = "Live telemetry";
  if (footerMeta) footerMeta.textContent = `Account: ${currentUser.id.slice(0, 8)}… · LintIQ`;

  const displayName = getDisplayUsername(currentUser);
  const acctNameEl = document.getElementById("dashboard-account-name");
  if (acctNameEl) acctNameEl.textContent = displayName;

  const profile = readLocalJson(getSettingsProfileKey(), getDefaultProfile());
  const trackEl = document.getElementById("dashboard-active-track");
  if (trackEl) trackEl.textContent = RUNTIME_LABELS[profile.language] || "Python 3.11";

  const metricsKey = getSettingsMetricsKey();
  const metrics = (metricsKey && readLocalJson(metricsKey, null)) || getDefaultMetrics();

  let cloudSolves = parseInt(localStorage.getItem("lintiq_solves") || "0", 10);
  let cloudStreak = parseInt(localStorage.getItem("lintiq_streak") || "0", 10);
  let cloudScore = parseInt(localStorage.getItem("lintiq_score") || "0", 10);

  try {
    const { data: cloudProfile } = await supabaseClient
      .from("user_profiles")
      .select("score, streak, solves")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (cloudProfile) {
      cloudSolves = Math.max(cloudSolves, cloudProfile.solves || 0);
      cloudStreak = Math.max(cloudStreak, cloudProfile.streak || 0);
      cloudScore = Math.max(cloudScore, cloudProfile.score || 0);
    }
  } catch (err) {
    console.warn("Dashboard cloud profile read failed:", err);
  }

  const totalSolves = Math.max(metrics.totalAccepted || 0, cloudSolves);
  const bestStreak = Math.max(metrics.bestStreak || 0, cloudStreak);
  const nonZeroLatencies = (metrics.avgLatencyMs || []).filter(v => Number(v) > 0);
  const avgMs = nonZeroLatencies.length > 0
    ? Math.round(nonZeroLatencies.reduce((a, b) => a + b, 0) / nonZeroLatencies.length)
    : 0;
  const attempts = metrics.totalAttempts || 0;
  const accepted = metrics.totalAccepted || 0;
  const passRate = metrics.passRate || (attempts > 0 ? Math.round((accepted / attempts) * 100) : 0);

  const el = (id) => document.getElementById(id);
  if (el("stat-patches")) el("stat-patches").textContent = String(totalSolves);
  if (el("stat-patches-sub")) el("stat-patches-sub").textContent = `${cloudScore.toLocaleString()} pts`;
  if (el("stat-runtime")) el("stat-runtime").innerHTML = `${avgMs} <span class="text-xs text-gray-400 font-normal">ms</span>`;
  if (el("stat-accuracy")) el("stat-accuracy").textContent = `${passRate}%`;
  if (el("stat-accuracy-sub")) el("stat-accuracy-sub").textContent = `${accepted} of ${attempts} local runs`;
  if (el("stat-best-streak")) el("stat-best-streak").textContent = String(bestStreak);

  // Peak day summary
  const solvedArr = metrics.patchesSolved || [0, 0, 0, 0, 0, 0, 0];
  const labels = metrics.labels || ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let peakVal = 0;
  let peakDay = "—";
  solvedArr.forEach((v, idx) => {
    if (Number(v) >= peakVal && Number(v) > 0) {
      peakVal = Number(v);
      peakDay = labels[idx] || "Today";
    }
  });
  if (el("dashboard-peak-summary")) {
    el("dashboard-peak-summary").innerHTML = peakVal > 0
      ? `Peak: <strong class="text-emerald-400">+${peakVal} Patches</strong> on ${escapeHtml(peakDay)}`
      : `Peak: <span class="text-gray-400">No patches logged this week</span>`;
  }

  renderDashboardChart(metrics);
}

function exportSettingsBackup() {
  const metricsKey = getSettingsMetricsKey();
  const bundle = {
    exported_at: new Date().toISOString(),
    user_id: currentUser?.id || "guest",
    profile: readLocalJson(getSettingsProfileKey(), null) || getDefaultProfile(),
    preferences: readEditorPrefsFromStorage(),
    metrics: metricsKey ? (readLocalJson(metricsKey, null) || getDefaultMetrics()) : null,
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "lintiq-profile-backup.json";
  a.click();
  URL.revokeObjectURL(url);
}

function resetSettingsTelemetry() {
  const metricsKey = getSettingsMetricsKey();
  if (!metricsKey) return;
  localStorage.removeItem(metricsKey);
  initDashboardSettingsPage();
}

// ─── PAGE ROUTER / BOOTSTRAP ─────────────────────────────────────────────────
async function bootstrapSettingsPage() {
  const pageType = document.body.getAttribute("data-settings-page");
  await initAuth();

  const runPageInit = () => {
    const pageLogoutBtn = document.getElementById("settings-page-logout-btn");
    if (pageLogoutBtn) {
      pageLogoutBtn.classList.toggle("hidden", !currentUser);
    }
    if (pageType === "profile") initProfileSettingsPage();
    else if (pageType === "editor") initEditorSettingsPage();
    else if (pageType === "dashboard") initDashboardSettingsPage();
  };

  runPageInit();
  supabaseClient.auth.onAuthStateChange(() => {
    runPageInit();
  });
}

window.saveSettingsProfile = saveSettingsProfile;
window.saveEditorPrefsFromControls = saveEditorPrefsFromControls;
window.resetEditorDefaults = resetEditorDefaults;
window.exportSettingsBackup = exportSettingsBackup;
window.resetSettingsTelemetry = resetSettingsTelemetry;

window.addEventListener("DOMContentLoaded", bootstrapSettingsPage);
