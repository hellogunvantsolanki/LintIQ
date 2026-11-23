// --- 1. CONFIGURATION ---
const API = (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
  ? "http://127.0.0.1:8000"
  : "https://lintiq.onrender.com";

const SUPABASE_URL = "https://rqkymtiatlkrndsqmoys.supabase.co";
const SUPABASE_KEY = "sb_publishable_Re4QdRQd83O7RAAAAJBx4g_jc6l23_P";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Theme handling (day/night)
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

// Game & Filter State
let currentUser = null;
let currentSession = null;
let monacoEditor = null;
let currentProblem = null;
let selectedCategory = "All";
let selectedDifficulty = "All";
let streak = parseInt(localStorage.getItem("lintiq_streak") || "0", 10);
let score = parseInt(localStorage.getItem("lintiq_score") || "0", 10);
let solves = parseInt(localStorage.getItem("lintiq_solves") || "0", 10);
let timerSeconds = 0;
let timerInterval = null;
let timerRunning = false;
let isInjectingCode = false;
let isExecutionBusy = false;
let testRunCooldownUntil = 0;
let lastDiffCardText = "";

// --- 2. AUTHENTICATION & CLOUD PROFILE SYNC ---
function getDisplayUsername(user) {
  if (!user) return "Engineer";
  return (
    user.user_metadata?.full_name ||
    user.user_metadata?.user_name ||
    user.email?.split("@")[0] ||
    "Engineer"
  );
}

function openAuthModal() {
  document.getElementById("auth-modal").classList.remove("hidden");
  document.getElementById("auth-msg").textContent = "";
}

function closeAuthModal() {
  document.getElementById("auth-modal").classList.add("hidden");
}

async function loginWithOAuth(provider) {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: provider,
    options: {
      redirectTo: window.location.origin
    }
  });
  if (error) alert(`${provider} error: ` + error.message);
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
    email: email,
    options: {
      emailRedirectTo: window.location.origin
    }
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

async function logout() {
  if (!currentUser) return;
  await supabaseClient.auth.signOut();
  window.location.reload();
}

async function syncUserProfileWithCloud(user) {
  if (!user || !user.id || String(user.id).startsWith("mock_") || String(user.id).startsWith("test_")) {
    return;
  }

  const username = getDisplayUsername(user);

  try {
    const { data: cloudProfile, error } = await supabaseClient
      .from("user_profiles")
      .select("id, username, score, streak, solves, tier")
      .eq("id", user.id)
      .maybeSingle();

    if (!error && cloudProfile) {
      if (score > (cloudProfile.score || 0)) {
        const mergedSolves = Math.max(solves, cloudProfile.solves || 0, streak, 1);
        await supabaseClient.from("user_profiles").upsert({
          id: user.id,
          username: username,
          score: score,
          streak: streak,
          solves: mergedSolves,
          tier: cloudProfile.tier || "free",
          last_active: new Date().toISOString()
        }, { onConflict: "id" });
        solves = mergedSolves;
      } else {
        score = cloudProfile.score || 0;
        streak = cloudProfile.streak || 0;
        solves = cloudProfile.solves || 0;
      }
      updateMetrics();
      if (typeof window.syncSettingsModalAuth === "function") {
        window.syncSettingsModalAuth();
      }
      return;
    }

    const headers = {};
    if (currentSession?.access_token) {
      headers["Authorization"] = `Bearer ${currentSession.access_token}`;
    }
    const res = await fetch(`${API}/profile/${encodeURIComponent(user.id)}`, { headers });
    if (res.ok) {
      const backendProfile = await res.json();
      score = Math.max(score, backendProfile.score || 0);
      streak = Math.max(streak, backendProfile.streak || 0);
      solves = Math.max(solves, backendProfile.solves || 0);
      updateMetrics();
    }

    if (score > 0 || solves > 0) {
      await supabaseClient.from("user_profiles").upsert({
        id: user.id,
        username: username,
        score: score,
        streak: streak,
        solves: Math.max(solves, 1),
        tier: "free",
        last_active: new Date().toISOString()
      }, { onConflict: "id" });
    }
  } catch (err) {
    console.warn("Cloud profile sync fallback active:", err);
  }
}

async function initAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentSession = session || null;
  currentUser = session?.user || null;
  updateAuthUI(currentUser);
  if (currentUser) {
    syncUserProfileWithCloud(currentUser);
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentSession = session || null;
    currentUser = session?.user || null;
    updateAuthUI(currentUser);
    if (currentUser) {
      syncUserProfileWithCloud(currentUser);
    }
  });
}

function updateAuthUI(user) {
  const loginBtn = document.getElementById("btn-login");
  const userProfile = document.getElementById("user-profile");
  const userDisplayName = document.getElementById("user-display-name");
  const settingsLogoutBtn = document.getElementById("settings-logout-btn");
  const settingsLogoutDivider = document.getElementById("settings-logout-divider");

  if (user) {
    closeAuthModal();
    loginBtn?.classList.add("hidden");
    userProfile?.classList.remove("hidden");
    settingsLogoutBtn?.classList.remove("hidden");
    settingsLogoutDivider?.classList.remove("hidden");

    const name = getDisplayUsername(user);
    if (userDisplayName) {
      userDisplayName.textContent = name;
      userDisplayName.title = name;
    }
  } else {
    loginBtn?.classList.remove("hidden");
    userProfile?.classList.add("hidden");
    settingsLogoutBtn?.classList.add("hidden");
    settingsLogoutDivider?.classList.add("hidden");
  }

  if (typeof window.syncSettingsModalAuth === "function") {
    window.syncSettingsModalAuth();
  }
}

// --- 3. CATEGORY & DIFFICULTY FILTERING ---
async function initCategoryCounts() {
  try {
    const res = await fetch(`${API}/categories`);
    if (!res.ok) return;
    const data = await res.json();

    const countMap = {};
    (data.categories || []).forEach(c => {
      countMap[c.name] = c.count;
    });

    document.querySelectorAll(".cat-pill").forEach(btn => {
      const cat = btn.getAttribute("data-cat");
      if (cat === "All") {
        btn.innerHTML = `All Tracks <span class="ml-1 text-[10px] opacity-90">(${data.total || 0})</span>`;
      } else if (countMap[cat] !== undefined) {
        btn.innerHTML = `${cat} <span class="ml-1 text-[10px] opacity-80">(${countMap[cat]})</span>`;
      }
    });
  } catch (e) {
    console.error("Could not load category counts:", e);
  }
}

function selectCategory(category) {
  selectedCategory = category;
  document.querySelectorAll(".cat-pill").forEach(btn => {
    if (btn.getAttribute("data-cat") === category) {
      btn.className = "cat-pill px-3 py-1 rounded-full text-xs font-medium transition bg-emerald-600 text-white shadow-sm whitespace-nowrap";
    } else {
      btn.className = "cat-pill px-3 py-1 rounded-full text-xs font-medium transition bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700 whitespace-nowrap";
    }
  });
  loadNewProblem();
}

function selectDifficulty(difficulty) {
  selectedDifficulty = difficulty;
  loadNewProblem();
}

function resetStarterCode() {
  if (!currentProblem || !monacoEditor) return;
  isInjectingCode = true;
  monacoEditor.setValue(currentProblem.buggy_code);
  isInjectingCode = false;
  hideCopyDiffButton();
  resetTimer();
}

// --- 4. PERMANENT CLOUD LEADERBOARD MODAL LOGIC ---
function openLeaderboardModal() {
  document.getElementById("leaderboard-modal").classList.remove("hidden");
  fetchLeaderboard();
}

function closeLeaderboardModal() {
  document.getElementById("leaderboard-modal").classList.add("hidden");
}

async function fetchLeaderboard() {
  const tbody = document.getElementById("leaderboard-rows");
  const syncStatus = document.getElementById("leaderboard-sync-status");

  try {
    let leaders = [];
    let usedSupabaseCloud = false;

    const { data: cloudLeaders, error: cloudError } = await supabaseClient
      .from("user_profiles")
      .select("id, username, score, streak, solves, tier")
      .not("id", "like", "mock_%")
      .not("id", "like", "test_%")
      .order("score", { ascending: false })
      .limit(10);

    if (!cloudError && Array.isArray(cloudLeaders)) {
      leaders = cloudLeaders;
      usedSupabaseCloud = true;
    }

    try {
      const res = await fetch(`${API}/leaderboard`);
      if (res.ok) {
        const backendLeaders = await res.json();
        const map = new Map();
        leaders.forEach(p => map.set(p.id, p));
        (backendLeaders || []).forEach(p => {
          if (!String(p.id).startsWith("mock_") && !String(p.id).startsWith("test_")) {
            const existing = map.get(p.id);
            if (!existing || (p.score || 0) > (existing.score || 0)) {
              map.set(p.id, p);
            }
          }
        });
        leaders = Array.from(map.values())
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, 10);
      }
    } catch (_) {}

    if (syncStatus) {
      syncStatus.textContent = usedSupabaseCloud
        ? "☁️ Synced with Supabase Postgres Cloud"
        : "⚡ Local SQLite Mode (Run SQL setup in Supabase for Cloud)";
    }

    if (!leaders || leaders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-zinc-400">No ranked engineers yet. Sign in and solve a challenge to claim #1!</td></tr>`;
      return;
    }

    const currentUserId = currentUser?.id;

    tbody.innerHTML = leaders.map((player, index) => {
      const isCurrentUser = currentUserId && player.id === currentUserId;
      let rankBadge = `${index + 1}`;
      if (index === 0) rankBadge = "🥇";
      else if (index === 1) rankBadge = "🥈";
      else if (index === 2) rankBadge = "🥉";

      const rowHighlight = isCurrentUser
        ? "bg-emerald-950/40 border-l-2 border-emerald-500 text-white font-bold"
        : "hover:bg-zinc-800/40 text-zinc-300";

      return `
        <tr class="${rowHighlight} transition">
          <td class="py-2.5 px-3 text-zinc-400 font-bold">${rankBadge}</td>
          <td class="py-2.5 px-3 flex items-center gap-1.5">
            <span class="truncate max-w-[140px]" title="${player.username}">${player.username}</span>
            ${isCurrentUser ? '<span class="text-[9px] px-1 bg-emerald-500/20 text-emerald-400 rounded uppercase">You</span>' : ''}
            ${player.tier === 'pro' ? '<span class="text-[9px] px-1 bg-amber-500/20 text-amber-300 rounded uppercase font-semibold">Pro</span>' : ''}
          </td>
          <td class="py-2.5 px-3 text-right text-emerald-400 font-bold">${Number(player.score || 0).toLocaleString()}</td>
          <td class="py-2.5 px-3 text-center text-amber-400">${player.streak > 0 ? `⚡ ${player.streak}` : '0'}</td>
          <td class="py-2.5 px-3 text-right text-zinc-400">${player.solves || 0}</td>
        </tr>
      `;
    }).join("");

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-rose-400">Failed to load leaderboard.</td></tr>`;
    console.error(err);
  }
}

// --- 5. ARCADE METRICS, CUSTOM STDIN, SEEN AI POOL & SHARE FIX HELPERS ---
function updateMetrics() {
  const streakEl = document.getElementById("streak-count");
  const scoreEl = document.getElementById("score-count");
  if (streakEl) streakEl.textContent = streak;
  if (scoreEl) scoreEl.textContent = score;
  localStorage.setItem("lintiq_streak", streak);
  localStorage.setItem("lintiq_score", score);
  localStorage.setItem("lintiq_solves", solves);
}

function getSeenAiIdsKey() {
  return `lintiq_seen_ai_ids_${currentUser?.id || "guest"}`;
}

function getLocalSeenAiIds() {
  try {
    const arr = JSON.parse(localStorage.getItem(getSeenAiIdsKey()) || "[]");
    return Array.isArray(arr) ? arr.filter(Number.isFinite) : [];
  } catch (_) {
    return [];
  }
}

function recordLocalSeenAiId(problemId) {
  const numId = Number(problemId);
  if (!Number.isFinite(numId) || numId < 100000) return;
  try {
    const existing = getLocalSeenAiIds().filter(id => id !== numId);
    existing.push(numId);
    const trimmed = existing.slice(-150);
    localStorage.setItem(getSeenAiIdsKey(), JSON.stringify(trimmed));
  } catch (_) {}
}

function getSampleTestCase() {
  if (!currentProblem || !Array.isArray(currentProblem.test_cases) || currentProblem.test_cases.length === 0) {
    return null;
  }
  return currentProblem.test_cases[0];
}

function getSampleInput() {
  const tc = getSampleTestCase();
  return tc ? String(tc.input ?? "") : "";
}

function normalizeOutput(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim();
}

function updateStdinBadge() {
  const inputEl = document.getElementById("custom-stdin");
  const badgeEl = document.getElementById("stdin-mode-badge");
  if (!inputEl || !badgeEl) return;

  const val = inputEl.value;
  const sampleTc = getSampleTestCase();
  const sample = sampleTc ? String(sampleTc.input ?? "") : "";

  if (sampleTc && val === sample) {
    badgeEl.textContent = "Sample #1";
    badgeEl.className = "px-1.5 py-0.2 rounded bg-zinc-800 text-sky-400 border border-zinc-700 text-[10px]";
  } else if (val === "") {
    badgeEl.textContent = "Empty";
    badgeEl.className = "px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 text-[10px]";
  } else {
    badgeEl.textContent = "Custom";
    badgeEl.className = "px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[10px]";
  }
}

function toggleCustomInput(forceOpen = null) {
  const wrapper = document.getElementById("custom-stdin-wrapper");
  const caret = document.getElementById("stdin-caret");
  if (!wrapper) return;

  const shouldOpen = forceOpen !== null ? forceOpen : wrapper.classList.contains("hidden");
  wrapper.classList.toggle("hidden", !shouldOpen);
  if (caret) caret.textContent = shouldOpen ? "▾" : "▸";
}

function fillSampleInput() {
  const inputEl = document.getElementById("custom-stdin");
  if (!inputEl) return;
  inputEl.value = getSampleInput();
  updateStdinBadge();
  toggleCustomInput(true);
}

function clearCustomInput() {
  const inputEl = document.getElementById("custom-stdin");
  if (!inputEl) return;
  inputEl.value = "";
  updateStdinBadge();
  toggleCustomInput(true);
  inputEl.focus();
}

function getSolvedMapKey() {
  return `lintiq_solved_map_${currentUser?.id || "guest"}`;
}

function getSolvedMap() {
  try {
    return JSON.parse(localStorage.getItem(getSolvedMapKey()) || "{}") || {};
  } catch (_) {
    return {};
  }
}

function saveSolvedMap(map) {
  try {
    localStorage.setItem(getSolvedMapKey(), JSON.stringify(map));
  } catch (_) {}
}

function getGradeIcon(grade) {
  if (grade === "Surgical") return "🩹";
  if (grade === "Clean") return "✨";
  return "🔧";
}

function ensureCopyDiffButton() {
  let btn = document.getElementById("btn-copy-diff-card");
  if (btn) return btn;

  const statusTag = document.getElementById("status-tag");
  if (!statusTag || !statusTag.parentElement) return null;

  btn = document.createElement("button");
  btn.id = "btn-copy-diff-card";
  btn.type = "button";
  btn.className = "hidden ml-auto mr-2 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 transition cursor-pointer";
  btn.textContent = "📋 Share Fix";
  btn.addEventListener("click", copyDiffCardToClipboard);

  statusTag.parentElement.insertBefore(btn, statusTag);
  return btn;
}

function hideCopyDiffButton() {
  lastDiffCardText = "";
  const btn = document.getElementById("btn-copy-diff-card");
  if (btn) {
    btn.classList.add("hidden");
    btn.textContent = "📋 Share Fix";
  }
}

function buildDiffCardMarkdown(problem, metrics, pointsEarned, solveSecs) {
  const fence = String.fromCharCode(96).repeat(3);
  const icon = getGradeIcon(metrics.grade);
  const allDiff = Array.isArray(metrics.diff_lines) ? metrics.diff_lines : [];
  const shownLines = allDiff.slice(0, 10);
  const totalChanged = (metrics.lines_added || 0) + (metrics.lines_removed || 0);
  const remaining = Math.max(0, totalChanged - shownLines.length);

  const codeBody = shownLines.length > 0
    ? shownLines.join("\n") + (remaining > 0 ? `\n... (+${remaining} more changed lines)` : "")
    : "# (No line diff recorded)";

  const multPart = metrics.multiplier > 1 ? `, ${metrics.multiplier}x` : "";
  const ptsPart = pointsEarned > 0 ? ` | +${pointsEarned} pts` : "";

  return [
    `${icon} LintIQ — ${problem.title} (#${problem.id})`,
    `${metrics.grade} Patch (+${metrics.lines_added} -${metrics.lines_removed} lines${multPart}) | ⚡ ${metrics.runtime_ms}ms | ⏱️ ${solveSecs}s${ptsPart}`,
    fence,
    codeBody,
    fence,
    "Try to beat my fix 👉 https://thelintiq.com"
  ].join("\n");
}

async function copyDiffCardToClipboard() {
  if (!lastDiffCardText) return;
  const btn = document.getElementById("btn-copy-diff-card");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(lastDiffCardText);
    } else {
      const ta = document.createElement("textarea");
      ta.value = lastDiffCardText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    if (btn) {
      btn.textContent = "✓ Copied!";
      setTimeout(() => {
        if (btn && !btn.classList.contains("hidden")) {
          btn.textContent = "📋 Share Fix";
        }
      }, 2000);
    }
  } catch (err) {
    console.warn("Clipboard copy failed:", err);
  }
}

function recordLintIQSolve(solveSeconds, passed, actualRuntimeMs = null) {
  if (!currentUser?.id) return;

  const key = `lintiq_user_metrics_${currentUser.id}`;
  const current = JSON.parse(localStorage.getItem(key) || "null") || {
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    patchesSolved: [0, 0, 0, 0, 0, 0, 0],
    avgLatencyMs: [0, 0, 0, 0, 0, 0, 0],
    totalAccepted: 0,
    totalAttempts: 0,
    passRate: 0,
    bestStreak: 0
  };

  const todayIdx = current.patchesSolved.length - 1;
  current.totalAttempts = (current.totalAttempts || 0) + 1;

  if (passed) {
    current.patchesSolved[todayIdx] += 1;
    current.totalAccepted = (current.totalAccepted || 0) + 1;
    current.bestStreak = Math.max(current.bestStreak || 0, streak);
  }

  current.passRate = Math.round((current.totalAccepted / current.totalAttempts) * 100);

  const execMs = (typeof actualRuntimeMs === "number" && actualRuntimeMs > 0)
    ? Math.round(actualRuntimeMs)
    : Math.max(18, Math.min(120, Math.round(solveSeconds * 1.5)));

  current.avgLatencyMs[todayIdx] = current.avgLatencyMs[todayIdx] === 0
    ? execMs
    : Math.round((current.avgLatencyMs[todayIdx] + execMs) / 2);

  localStorage.setItem(key, JSON.stringify(current));

  if (typeof window.syncSettingsModalAuth === "function") {
    window.syncSettingsModalAuth();
  }
}

function resetTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerSeconds = 0;
  timerRunning = false;
  updateTimerDisplay();
  document.getElementById("timer-status").textContent = "(Ready)";
  document.getElementById("timer-status").className = "text-[10px] uppercase tracking-wider text-zinc-400 ml-1";
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  document.getElementById("timer-status").textContent = "(Running)";
  document.getElementById("timer-status").className = "text-[10px] uppercase tracking-wider text-emerald-400 ml-1";

  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerRunning = false;
  document.getElementById("timer-status").textContent = "(Solved)";
  document.getElementById("timer-status").className = "text-[10px] uppercase tracking-wider text-sky-400 ml-1";
}

function updateTimerDisplay() {
  const mins = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const secs = String(timerSeconds % 60).padStart(2, '0');
  document.getElementById("timer-display").textContent = `${mins}:${secs}`;
}

// --- 6. PROBLEM LIFECYCLE (STATELESS RENDERER) ---
function renderProblem(problem, customConsoleMsg = null) {
  if (!problem) return;

  currentProblem = problem;
  hideCopyDiffButton();

  document.getElementById("problem-id").textContent = `#${problem.id}`;
  document.getElementById("problem-title").textContent = problem.title;
  document.getElementById("problem-desc").textContent = problem.description;
  document.getElementById("problem-category").textContent = problem.category || "General";

  const tagsContainer = document.getElementById("problem-tags");
  const tagsList = Array.isArray(problem.tags) ? problem.tags : [];
  tagsContainer.innerHTML = tagsList.map(tag => {
    const cleanTag = String(tag).startsWith("#") ? tag : `#${tag}`;
    return `<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">${cleanTag}</span>`;
  }).join("");

  const tcCount = Array.isArray(problem.test_cases) ? problem.test_cases.length : 0;
  document.getElementById("test-case-count").textContent = `🧪 ${tcCount} Test Assertion${tcCount === 1 ? '' : 's'}`;

  const diffBadge = document.getElementById("problem-difficulty");
  diffBadge.textContent = problem.difficulty || "Medium";

  document.getElementById("hint-box").classList.add("hidden");
  document.getElementById("status-tag").textContent = "Idle";
  document.getElementById("status-tag").className = "text-zinc-400";
  document.getElementById("console-output").textContent =
    customConsoleMsg ||
    "Click inside the code editor to start timing and solve the bug. Use ▶ Test Run anytime without risking your streak.";

  const stdinEl = document.getElementById("custom-stdin");
  if (stdinEl) {
    stdinEl.value = getSampleInput();
    updateStdinBadge();
    toggleCustomInput(false);
  }

  if (monacoEditor) {
    isInjectingCode = true;
    monacoEditor.setValue(problem.buggy_code || "");
    isInjectingCode = false;
  }

  resetTimer();
}

async function loadNewProblem() {
  try {
    resetTimer();
    hideCopyDiffButton();
    document.getElementById("problem-title").textContent = "Fetching next bug hunt...";
    document.getElementById("hint-box").classList.add("hidden");
    document.getElementById("console-output").textContent = "Click inside the code editor to start timing and solve the bug. Use ▶ Test Run anytime without risking your streak.";
    document.getElementById("status-tag").textContent = "Idle";
    document.getElementById("status-tag").className = "text-zinc-400";

    const params = new URLSearchParams();
    if (selectedCategory && selectedCategory !== "All") {
      params.set("category", selectedCategory);
    }
    if (selectedDifficulty && selectedDifficulty !== "All") {
      params.set("difficulty", selectedDifficulty);
    }
    if (currentProblem?.id) {
      params.set("exclude_id", currentProblem.id);
    }

    const res = await fetch(`${API}/get-problem?${params.toString()}`);

    if (res.status === 404) {
      document.getElementById("problem-title").textContent = "No challenges match this filter";
      document.getElementById("problem-desc").textContent = `No ${selectedDifficulty !== 'All' ? selectedDifficulty : ''} challenges found in "${selectedCategory}". Switch difficulty to "All Levels" or select another category.`;
      document.getElementById("problem-tags").innerHTML = "";
      return;
    }

    if (!res.ok) throw new Error("Could not fetch problem from backend.");

    const problem = await res.json();
    renderProblem(problem);
  } catch (err) {
    document.getElementById("problem-title").textContent = "Failed to load challenge";
    document.getElementById("problem-desc").textContent = "Make sure your FastAPI backend is running on port 8000.";
    console.error(err);
  }
}

// --- 7. SAFE TEST RUN (SAMPLE #1 ASSERTION CHECK + CUSTOM STDIN, ZERO STREAK PENALTY) ---
async function runTestCode() {
  if (!currentProblem || !monacoEditor || isExecutionBusy) return;

  const now = Date.now();
  if (now < testRunCooldownUntil) return;

  const prefs = JSON.parse(localStorage.getItem("lintiq_editor_prefs_v1") || "null") || {};
  const timerStatusText = document.getElementById("timer-status")?.textContent || "";
  if (prefs.autoTimer !== false && !timerRunning && timerStatusText !== "(Solved)") {
    startTimer();
  }

  const userCode = monacoEditor.getValue();
  const stdinEl = document.getElementById("custom-stdin");
  const sampleTc = getSampleTestCase();
  const sampleInput = sampleTc ? String(sampleTc.input ?? "") : "";
  const stdinVal = stdinEl ? stdinEl.value : sampleInput;
  const modeLabel = document.getElementById("stdin-mode-badge")?.textContent || "Custom";

  const isSampleMode = Boolean(
    sampleTc &&
    stdinVal === sampleInput &&
    sampleTc.expected_output !== undefined &&
    sampleTc.expected_output !== null
  );

  const consoleEl = document.getElementById("console-output");
  const statusTag = document.getElementById("status-tag");
  const testBtn = document.getElementById("btn-test-run");
  const submitBtn = document.getElementById("btn-submit");

  isExecutionBusy = true;
  testRunCooldownUntil = now + 1500;
  hideCopyDiffButton();

  if (testBtn) {
    testBtn.disabled = true;
    testBtn.textContent = "Running...";
  }
  if (submitBtn) submitBtn.disabled = true;

  statusTag.textContent = "Testing...";
  statusTag.className = "text-sky-400";

  try {
    const res = await fetch(`${API}/run-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: currentProblem.id,
        user_code: userCode,
        stdin: stdinVal,
        language: currentProblem.language || "python"
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || `Server error (${res.status})`);
    }

    const msText = data.runtime_ms ? `${data.runtime_ms}ms` : "<1ms";
    const stdoutRaw = String(data.stdout || "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
    const stderrTrimmed = String(data.stderr || "").trim();

    if (data.ok) {
      if (isSampleMode) {
        const actualNorm = normalizeOutput(data.stdout);
        const expectedNorm = normalizeOutput(sampleTc.expected_output);

        if (actualNorm === expectedNorm) {
          statusTag.textContent = "Sample Passed";
          statusTag.className = "text-emerald-400";

          const lines = [
            `✓ SAMPLE #1 PASSED (⚡ ${msText} | Streak safe)`,
            `Output:\n${actualNorm || "(Empty output)"}`
          ];
          if (stderrTrimmed) {
            lines.push(`\nSTDERR:\n${stderrTrimmed}`);
          }
          lines.push("\n→ Ready? Click SUBMIT PATCH to grade all hidden assertions.");
          consoleEl.textContent = lines.join("\n");
        } else {
          statusTag.textContent = "Sample Failed";
          statusTag.className = "text-rose-400";

          const lines = [
            `✖ SAMPLE #1 FAILED (⚡ ${msText} | Streak safe)`,
            `Input:\n${stdinVal || "(Empty)"}`,
            `Expected:\n${expectedNorm || "(Empty)"}`,
            `Your Output:\n${actualNorm || "(No stdout printed)"}`
          ];
          if (stderrTrimmed) {
            lines.push(`STDERR:\n${stderrTrimmed}`);
          }
          consoleEl.textContent = lines.join("\n\n");
        }
      } else {
        statusTag.textContent = "Test Run";
        statusTag.className = "text-sky-400";

        const lines = [
          `▶ TEST RUN (${modeLabel} | ⚡ ${msText} | Streak safe)`
        ];
        lines.push(stdoutRaw ? stdoutRaw : "(No stdout printed)");
        if (stderrTrimmed) {
          lines.push(`\nSTDERR:\n${stderrTrimmed}`);
        }
        consoleEl.textContent = lines.join("\n");
      }
    } else {
      statusTag.textContent = "Test Error";
      statusTag.className = "text-rose-400";

      const errTitle = (data.error_type || "error").replace(/_/g, " ").toUpperCase();
      const lines = [
        `✖ TEST RUN — ${errTitle} (${modeLabel} | ⚡ ${msText} | Streak safe)`
      ];
      if (stdoutRaw) {
        lines.push(`STDOUT (before error):\n${stdoutRaw}`);
      }
      if (stderrTrimmed) {
        lines.push(stderrTrimmed);
      }
      consoleEl.textContent = lines.join("\n");
    }
  } catch (err) {
    statusTag.textContent = "Test Error";
    statusTag.className = "text-rose-400";
    consoleEl.textContent = `✖ Test Run failed: ${err.message}`;
    console.error(err);
  } finally {
    isExecutionBusy = false;
    if (submitBtn) submitBtn.disabled = false;
    const waitLeft = Math.max(0, testRunCooldownUntil - Date.now());
    setTimeout(() => {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = "▶ Test Run";
      }
    }, waitLeft);
  }
}

// --- 8. PATCH SUBMISSION & SURGICAL PATCH SCORING ---
async function submitPatch() {
  if (!currentProblem || !monacoEditor || isExecutionBusy) return;

  const userCode = monacoEditor.getValue();
  const consoleEl = document.getElementById("console-output");
  const statusTag = document.getElementById("status-tag");
  const submitBtn = document.getElementById("btn-submit");
  const testBtn = document.getElementById("btn-test-run");

  isExecutionBusy = true;
  hideCopyDiffButton();
  submitBtn.disabled = true;
  submitBtn.textContent = "Judging...";
  if (testBtn) testBtn.disabled = true;

  statusTag.textContent = "Running...";
  statusTag.className = "text-amber-400";

  const userId = currentUser?.id || null;
  const username = currentUser ? getDisplayUsername(currentUser) : null;
  const accessToken = currentSession?.access_token || null;

  try {
    const headers = { "Content-Type": "application/json" };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const res = await fetch(`${API}/submit-patch`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        problem_id: currentProblem.id,
        user_code: userCode,
        test_cases: currentProblem.test_cases,
        language: currentProblem.language || "python",
        user_id: userId,
        username: username,
        time_seconds: timerSeconds,
        access_token: accessToken
      })
    });

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.detail || `Server error (${res.status})`);
    }

    if (result.passed) {
      stopTimer();
      statusTag.textContent = "Passed";
      statusTag.className = "text-emerald-400";

      const pm = result.patch_metrics || null;
      const multiplier = pm ? Number(pm.multiplier || 1.0) : 1.0;
      const grade = pm ? pm.grade : "Refactor";
      const runtimeMs = pm ? pm.runtime_ms : (result.runtime_ms || null);

      const solvedMap = getSolvedMap();
      const pidKey = String(currentProblem.id);
      const prevRecord = solvedMap[pidKey];

      let pointsEarned = 0;
      let solveNote = "";

      if (result.profile) {
        streak = result.profile.streak;
        score = result.profile.score;
        solves = result.profile.solves;
        pointsEarned = result.profile.points_earned;
      } else {
        const timeBonus = Math.max(0, 60 - timerSeconds);
        if (prevRecord) {
          const candidatePoints = Math.round((100 + (Math.max(1, streak) * 10) + timeBonus) * multiplier);
          if (candidatePoints > (prevRecord.bestPoints || 0)) {
            pointsEarned = candidatePoints - (prevRecord.bestPoints || 0);
            score += pointsEarned;
            solvedMap[pidKey] = { bestPoints: candidatePoints, bestGrade: grade };
            saveSolvedMap(solvedMap);
            solveNote = " (New Best Grade!)";
          } else {
            pointsEarned = 0;
            solveNote = " (Already solved)";
          }
        } else {
          streak += 1;
          solves += 1;
          pointsEarned = Math.round((100 + (streak * 10) + timeBonus) * multiplier);
          score += pointsEarned;
          solvedMap[pidKey] = { bestPoints: pointsEarned, bestGrade: grade };
          saveSolvedMap(solvedMap);
        }
      }

      if (pm) {
        const icon = getGradeIcon(pm.grade);
        const multLabel = pm.multiplier > 1 ? ` (${pm.multiplier}x)` : "";
        const summaryLine = `✓ PASSED | ${icon} ${pm.grade} Patch (+${pm.lines_added} -${pm.lines_removed} lines) | ⚡ ${pm.runtime_ms}ms | +${pointsEarned} pts${multLabel}${solveNote}`;
        consoleEl.textContent = `${summaryLine}\nCleared in ${timerSeconds}s — ${result.message || ''}`;

        lastDiffCardText = buildDiffCardMarkdown(currentProblem, pm, pointsEarned, timerSeconds);
        const copyBtn = ensureCopyDiffButton();
        if (copyBtn) {
          copyBtn.classList.remove("hidden");
        }
      } else {
        consoleEl.textContent = `✔ Cleared in ${timerSeconds}s! (+${pointsEarned} Points${solveNote})\n${result.message || ''}`;
      }

      updateMetrics();
      recordLintIQSolve(timerSeconds, true, runtimeMs);
    } else {
      statusTag.textContent = "Failed";
      statusTag.className = "text-rose-400";
      consoleEl.textContent = `✖ Patch Failed:\n${result.message || 'Logic or assertion error.'}`;
      streak = 0;
      updateMetrics();
      recordLintIQSolve(timerSeconds, false);
    }
  } catch (err) {
    statusTag.textContent = "Error";
    statusTag.className = "text-rose-400";
    consoleEl.textContent = `Failed to communicate with test runner: ${err.message}`;
    console.error(err);
  } finally {
    isExecutionBusy = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Patch";
    if (testBtn) testBtn.disabled = false;
  }
}

// --- 9. AI HINT ENGINE ---
async function requestHint() {
  if (!currentProblem || !monacoEditor) return;
  const hintBox = document.getElementById("hint-box");
  const hintText = document.getElementById("hint-text");

  hintBox.classList.remove("hidden");
  hintText.textContent = "Synthesizing contextual hint...";

  try {
    const res = await fetch(`${API}/get-hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: currentProblem.id,
        user_code: monacoEditor.getValue()
      })
    });
    const data = await res.json();
    hintText.textContent = data.hint || "Inspect how the loop handles edge bounds.";
  } catch (e) {
    hintText.textContent = "Examine variable boundaries and off-by-one offsets.";
  }
}

// --- 10. MONACO INITIALIZATION ---
require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs" } });
require(["vs/editor/editor.main"], function () {
  const savedPrefs = JSON.parse(localStorage.getItem("lintiq_editor_prefs_v1") || "null") || {};

  monacoEditor = monaco.editor.create(document.getElementById("editor-container"), {
    value: "# Loading challenge code...",
    language: "python",
    theme: "vs-dark",
    fontSize: savedPrefs.fontSize || 14,
    tabSize: savedPrefs.tabSize || 4,
    insertSpaces: true,
    minimap: { enabled: Boolean(savedPrefs.minimap) },
    wordWrap: savedPrefs.wordWrap || "on",
    automaticLayout: true,
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 }
  });

  window.editor = monacoEditor;
  window.monacoEditor = monacoEditor;

  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    submitPatch();
  });
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Quote, () => {
    runTestCode();
  });

  monacoEditor.onDidFocusEditorText(() => {
    const prefs = JSON.parse(localStorage.getItem("lintiq_editor_prefs_v1") || "null") || {};
    if (prefs.autoTimer !== false && !timerRunning && currentProblem) {
      startTimer();
    }
  });

  monacoEditor.onDidChangeModelContent(() => {
    const prefs = JSON.parse(localStorage.getItem("lintiq_editor_prefs_v1") || "null") || {};
    if (prefs.autoTimer !== false && !isInjectingCode && !timerRunning && currentProblem) {
      startTimer();
    }
  });

  const stdinEl = document.getElementById("custom-stdin");
  if (stdinEl) {
    stdinEl.addEventListener("input", updateStdinBadge);
  }

  initAuth();
  updateMetrics();
  initCategoryCounts();
  loadNewProblem();
});

// --- 11. INSTANT SHARED AI POOL GENERATOR & CATEGORY REFRESH ---
async function generateAIChallenge() {
  const btn = document.getElementById("ai-generate-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "✨ Loading AI Bug...";
  }

  const outEl = document.getElementById("console-output");
  if (outEl) {
    outEl.textContent = "🤖 Fetching a verified unseen AI bug challenge...";
  }

  try {
    const params = new URLSearchParams();
    if (selectedCategory && selectedCategory !== "All") {
      params.set("category", selectedCategory);
    }
    if (selectedDifficulty && selectedDifficulty !== "All") {
      params.set("difficulty", selectedDifficulty);
    }
    if (currentUser?.id) {
      params.set("user_id", currentUser.id);
    }

    const seenIds = getLocalSeenAiIds();
    if (seenIds.length > 0) {
      params.set("exclude_ids", seenIds.slice(-80).join(","));
    }

    const headers = {};
    if (currentSession?.access_token) {
      headers["Authorization"] = `Bearer ${currentSession.access_token}`;
    }

    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${API}/generate-ai-problem${query}`, {
      method: "POST",
      headers
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || "Failed to generate AI challenge");
    }

    recordLocalSeenAiId(data.id);

    const speedNote = data.source === "ai_pool" ? "Instant AI Pool" : "Freshly Synthesized";
    renderProblem(
      data,
      `✨ AI Challenge #${data.id} (${data.title}) ready [${speedNote}]! Click inside the editor to hunt the bug.`
    );

    refreshCategoryPillCounts();
  } catch (err) {
    if (outEl) {
      outEl.textContent = `❌ AI Generation Error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✨ Generate AI Bug";
    }
  }
}
window.generateAIChallenge = generateAIChallenge;

async function refreshCategoryPillCounts() {
  try {
    const res = await fetch(`${API}/categories`);
    if (!res.ok) return;
    const data = await res.json();

    const countMap = {};
    (data.categories || []).forEach(c => {
      countMap[c.name] = c.count;
    });

    document.querySelectorAll(".cat-pill").forEach(btn => {
      const cat = btn.getAttribute("data-cat");
      if (cat === "All") {
        btn.innerHTML = `All Tracks <span class="ml-1 text-[10px] opacity-90">(${data.total || 0})</span>`;
      } else if (countMap[cat] !== undefined) {
        btn.innerHTML = `${cat} <span class="ml-1 text-[10px] opacity-80">(${countMap[cat]})</span>`;
      }
    });
  } catch (e) {
    console.warn("Could not refresh category counts:", e);
  }
}