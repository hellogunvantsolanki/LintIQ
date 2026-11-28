/**
 * LintIQ — shared.js
 * Single source of truth for: API base URL, Supabase client, Auth state,
 * login/logout handlers, display-name helpers, escapeHtml, and theme toggle.
 * Loaded on EVERY page right after tailwind-config.js + Supabase CDN.
 */

// ─── 1. API BASE URL ────────────────────────────────────────────────────────
const API = (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
  ? "http://127.0.0.1:8000"
  : "https://lintiq.onrender.com";

// ─── 2. SUPABASE CLIENT ─────────────────────────────────────────────────────
const SUPABASE_URL = "https://rqkymtiatlkrndsqmoys.supabase.co";
const SUPABASE_KEY = "sb_publishable_Re4QdRQd83O7RAAAAJBx4g_jc6l23_P";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── 3. GLOBAL AUTH STATE ────────────────────────────────────────────────────
let currentUser = null;
let currentSession = null;

// ─── 4. UTILITY HELPERS ──────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeAppMode(rawMode) {
  return String(rawMode || "").trim().toLowerCase() === "interview"
    ? "interview"
    : "practice";
}

function getActiveMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const urlMode = String(params.get("mode") || "").trim().toLowerCase();
    if (urlMode === "practice" || urlMode === "interview") {
      try {
        sessionStorage.setItem("lintiq_mode", urlMode);
      } catch (_) {}
      return urlMode;
    }
  } catch (_) {}
  try {
    const saved = String(sessionStorage.getItem("lintiq_mode") || "").trim().toLowerCase();
    if (saved === "practice" || saved === "interview") {
      return saved;
    }
  } catch (_) {}
  return "practice";
}

function appendModeParam(url, mode = getActiveMode()) {
  const norm = normalizeAppMode(mode);
  const sep = String(url).includes("?") ? "&" : "?";
  return `${url}${sep}mode=${encodeURIComponent(norm)}`;
}

function getDisplayUsername(user) {
  if (!user) return "Engineer";
  return (
    user.user_metadata?.full_name ||
    user.user_metadata?.user_name ||
    user.email?.split("@")[0] ||
    "Engineer"
  );
}

function getInitials(name) {
  return String(name || "LQ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(p => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "LQ";
}

function showToast(message, type = "info") {
  let container = document.getElementById("lintiq-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "lintiq-toast-container";
    container.className = "fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm pointer-events-none";
    document.body.appendChild(container);
  }
  const palette = {
    info: "bg-[#141822] border-surface-border text-gray-200",
    success: "bg-[#0d1f18] border-emerald-500/40 text-emerald-300",
    warn: "bg-[#1f190d] border-amber-500/40 text-amber-300",
    error: "bg-[#221016] border-rose-500/40 text-rose-300",
  };
  const toast = document.createElement("div");
  toast.className = `pointer-events-auto px-3.5 py-2.5 rounded-lg border shadow-2xl text-xs font-mono transition-opacity duration-200 ${palette[type] || palette.info}`;
  toast.textContent = String(message || "");
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 220);
  }, 3500);
}

function clearUserScopedStorage() {
  const staticKeys = [
    "lintiq_score",
    "lintiq_streak",
    "lintiq_last_streak_date",
    "lintiq_max_streak",
    "lintiq_solves",
    "lintiq_last_active_problem",
    "lintiq_active_user_id",
  ];
  staticKeys.forEach(k => localStorage.removeItem(k));
  const toDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith("lintiq_solved_map_") || k.startsWith("lintiq_last_active_problem_"))) {
      toDelete.push(k);
    }
  }
  toDelete.forEach(k => localStorage.removeItem(k));
}

function getIstDateKeys(nowMs = Date.now()) {
  const istOffsetMs = 330 * 60 * 1000;
  const todayIst = new Date(nowMs + istOffsetMs);
  const yesterdayIst = new Date(nowMs + istOffsetMs - 86400000);
  return {
    todayStr: todayIst.toISOString().slice(0, 10),
    yesterdayStr: yesterdayIst.toISOString().slice(0, 10),
  };
}

function toIstDateKeyFromTs(rawTs) {
  if (!rawTs) return null;
  const dt = new Date(rawTs);
  if (Number.isNaN(dt.getTime())) return null;
  return new Date(dt.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function computeIstStreakFromSolveDates(timestamps) {
  const { todayStr, yesterdayStr } = getIstDateKeys();
  const daySet = new Set();
  (timestamps || []).forEach(ts => {
    const k = toIstDateKeyFromTs(ts);
    if (k) daySet.add(k);
  });
  if (daySet.size === 0) {
    return { currentStreak: 0, maxStreak: 0, lastStreakDate: null };
  }

  const sorted = Array.from(daySet).sort();
  const lastStreakDate = sorted[sorted.length - 1];

  let maxStreak = 0;
  let run = 0;
  let prevMs = null;
  sorted.forEach(k => {
    const ms = Date.parse(`${k}T00:00:00Z`);
    if (prevMs !== null && Math.round((ms - prevMs) / 86400000) === 1) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > maxStreak) maxStreak = run;
    prevMs = ms;
  });

  let currentStreak = 0;
  let cursorKey = daySet.has(todayStr) ? todayStr : (daySet.has(yesterdayStr) ? yesterdayStr : null);
  while (cursorKey && daySet.has(cursorKey)) {
    currentStreak += 1;
    const prevDate = new Date(Date.parse(`${cursorKey}T00:00:00Z`) - 86400000);
    cursorKey = prevDate.toISOString().slice(0, 10);
  }

  return { currentStreak, maxStreak, lastStreakDate };
}

function getEffectiveLocalStreak() {
  const rawStreak = parseInt(localStorage.getItem("lintiq_streak") || "0", 10);
  const lastDate = (localStorage.getItem("lintiq_last_streak_date") || "").trim();
  const { todayStr, yesterdayStr } = getIstDateKeys();
  if (!lastDate || (lastDate !== todayStr && lastDate !== yesterdayStr)) {
    return 0;
  }
  return Math.max(0, Number.isFinite(rawStreak) ? rawStreak : 0);
}

// ─── 5. THEME HANDLING ──────────────────────────────────────────────────────
let userTheme = localStorage.getItem("lintiq_theme") || "dark";

function applyTheme() {
  if (userTheme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

function toggleTheme() {
  userTheme = userTheme === "dark" ? "light" : "dark";
  localStorage.setItem("lintiq_theme", userTheme);
  applyTheme();
}

applyTheme();

// ─── 6. AUTH: OPEN / CLOSE MODAL ─────────────────────────────────────────────
function openAuthModal() {
  document.getElementById("auth-modal")?.classList.remove("hidden");
  const msg = document.getElementById("auth-msg");
  if (msg) msg.textContent = "";
}

function closeAuthModal() {
  document.getElementById("auth-modal")?.classList.add("hidden");
}

// ─── 7. AUTH: OAUTH + EMAIL MAGIC LINK ───────────────────────────────────────
function getCurrentAuthRedirectUrl() {
  return window.location.origin + window.location.pathname + window.location.search;
}

async function loginWithOAuth(provider) {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider,
    options: { redirectTo: getCurrentAuthRedirectUrl() }
  });
  if (error) showToast(`${provider} sign-in error: ${error.message}`, "error");
}

async function handleEmailAuth(event) {
  event.preventDefault();
  const email = document.getElementById("auth-email").value.trim();
  const msgEl = document.getElementById("auth-msg");
  const btn = document.getElementById("btn-email-submit");

  btn.disabled = true;
  btn.textContent = "Sending link...";
  msgEl.className = "text-[11px] text-center text-zinc-400";
  msgEl.textContent = "";

  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: getCurrentAuthRedirectUrl() }
  });

  btn.disabled = false;
  btn.textContent = "Send Magic Sign-In Link";

  if (error) {
    msgEl.className = "text-[11px] text-center text-rose-400";
    msgEl.textContent = error.message;
  } else {
    msgEl.className = "text-[11px] text-center text-emerald-400";
    msgEl.textContent = "Check your email inbox for your magic link!";
  }
}

// ─── 8. AUTH: LOGOUT ─────────────────────────────────────────────────────────
async function logout() {
  clearUserScopedStorage();
  try {
    if (window.supabaseClient?.auth) {
      await window.supabaseClient.auth.signOut();
    }
  } catch (_) {}
  currentSession = null;
  currentUser = null;
  if (typeof updateAuthUI === "function") {
    updateAuthUI(null);
  }
  window.location.reload();
}

// ─── 9. AUTH UI UPDATE (called by navbar.js after injection) ─────────────────
function updateAuthUI(user) {
  currentUser = user || null;
  const loginBtn = document.getElementById("btn-login");
  const userProfile = document.getElementById("user-profile");
  const userDisplayName = document.getElementById("user-display-name");
  const headerAvatar = document.getElementById("header-user-avatar");
  const settingsLogoutBtn = document.getElementById("settings-logout-btn");
  const settingsLogoutDivider = document.getElementById("settings-logout-divider");
  const settingsPageLogoutBtn = document.getElementById("settings-page-logout-btn");

  if (user) {
    closeAuthModal();
    loginBtn?.classList.add("hidden");
    userProfile?.classList.remove("hidden");
    settingsLogoutBtn?.classList.remove("hidden");
    settingsLogoutDivider?.classList.remove("hidden");
    settingsPageLogoutBtn?.classList.remove("hidden");

    const name = getDisplayUsername(user);
    if (userDisplayName) {
      userDisplayName.textContent = name;
      userDisplayName.title = name;
    }
    if (headerAvatar) {
      headerAvatar.textContent = getInitials(name);
    }
  } else {
    loginBtn?.classList.remove("hidden");
    userProfile?.classList.add("hidden");
    settingsLogoutBtn?.classList.add("hidden");
    settingsLogoutDivider?.classList.add("hidden");
    settingsPageLogoutBtn?.classList.add("hidden");
  }

  if (typeof window.syncSettingsModalAuth === "function") {
    window.syncSettingsModalAuth();
  }
}

// ─── 10. BOOTSTRAP AUTH (called by each page's main JS) ──────────────────────
let _authListenerRegistered = false;

async function initAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentSession = session || null;
  currentUser = session?.user || null;

  const prevUid = localStorage.getItem("lintiq_active_user_id");
  const nextUid = currentUser?.id || null;
  if (prevUid && prevUid !== nextUid) {
    clearUserScopedStorage();
  }
  if (nextUid) {
    localStorage.setItem("lintiq_active_user_id", nextUid);
  }

  updateAuthUI(currentUser);

  if (!_authListenerRegistered) {
    _authListenerRegistered = true;
    supabaseClient.auth.onAuthStateChange((event, newSession) => {
      const previousStored = localStorage.getItem("lintiq_active_user_id");
      currentSession = newSession || null;
      currentUser = newSession?.user || null;
      const incomingUid = currentUser?.id || null;

      if (event === "SIGNED_OUT" || (previousStored && previousStored !== incomingUid)) {
        clearUserScopedStorage();
      }
      if (incomingUid) {
        localStorage.setItem("lintiq_active_user_id", incomingUid);
      }

      updateAuthUI(currentUser);
    });
  }

  return { user: currentUser, session: currentSession };
}

// ─── 11. SETTINGS POPOVER DROPDOWN & JSON EXPORT (ALL PAGES) ─────────────────
function toggleSettingsDropdown(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("settings-popover-menu");
  const btn = document.getElementById("open-settings-btn");
  if (!menu) return;
  const isOpen = !menu.classList.toggle("hidden");
  if (btn) btn.setAttribute("aria-expanded", String(isOpen));
}

function closeSettingsDropdown() {
  document.getElementById("settings-popover-menu")?.classList.add("hidden");
  document.getElementById("open-settings-btn")?.setAttribute("aria-expanded", "false");
}

document.addEventListener("click", (e) => {
  const wrapper = document.getElementById("settings-dropdown-wrapper");
  if (wrapper && !wrapper.contains(e.target)) {
    closeSettingsDropdown();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSettingsDropdown();
  }
});

function exportLintIQData() {
  const uid = currentUser?.id || "guest";
  const profileKey = `lintiq_user_profile_${uid}`;
  const prefsKey = "lintiq_editor_prefs_v1";
  const metricsKey = currentUser?.id ? `lintiq_user_metrics_${currentUser.id}` : null;

  const safeJson = (k, fallback) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  };

  const defaultProfile = {
    full_name: currentUser ? getDisplayUsername(currentUser) : "Guest Engineer",
    github: currentUser?.user_metadata?.user_name || "",
    email: currentUser?.email || "",
    location: "",
    bio: "LintIQ Bug Hunter",
    website: "",
    language: "python",
  };

  const bundle = {
    exported_at: new Date().toISOString(),
    user_id: uid,
    profile: safeJson(profileKey, null) || defaultProfile,
    preferences: safeJson(prefsKey, {}),
    metrics: metricsKey ? safeJson(metricsKey, null) : null,
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "lintiq-profile-backup.json";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── EXPOSE GLOBALS ──────────────────────────────────────────────────────────
window.API = API;
window.supabaseClient = supabaseClient;
window.currentUser = null;        // Will be kept in sync via initAuth
window.currentSession = null;
window.escapeHtml = escapeHtml;
window.normalizeAppMode = normalizeAppMode;
window.getActiveMode = getActiveMode;
window.appendModeParam = appendModeParam;
window.getDisplayUsername = getDisplayUsername;
window.getInitials = getInitials;
window.showToast = showToast;
window.clearUserScopedStorage = clearUserScopedStorage;
window.getIstDateKeys = getIstDateKeys;
window.computeIstStreakFromSolveDates = computeIstStreakFromSolveDates;
window.getEffectiveLocalStreak = getEffectiveLocalStreak;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.loginWithOAuth = loginWithOAuth;
window.handleEmailAuth = handleEmailAuth;
window.logout = logout;
window.updateAuthUI = updateAuthUI;
window.initAuth = initAuth;
window.toggleTheme = toggleTheme;
window.toggleSettingsDropdown = toggleSettingsDropdown;
window.closeSettingsDropdown = closeSettingsDropdown;
window.exportLintIQData = exportLintIQData;

// Keep window refs in sync when auth changes
Object.defineProperty(window, 'currentUser', {
  get() { return currentUser; },
  set(v) { currentUser = v; },
  configurable: true
});
Object.defineProperty(window, 'currentSession', {
  get() { return currentSession; },
  set(v) { currentSession = v; },
  configurable: true
});
