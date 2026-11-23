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

// --- 1.1 CURATED MULTI-LANGUAGE PROBLEMS ---
const PROBLEMS = [
  {
    id: 1,
    title: "Two Sum",
    difficulty: "Easy",
    category: "Algorithms",
    tags: ["#hashmap", "#arrays"],
    description: "Given an array of integers nums and an integer target, return indices of the two numbers that add up to target.",
    starterCode: {
      python: `def two_sum(nums, target):\n    # Fix the bug or implement solution\n    pass`,
      cpp: `#include <vector>\nusing namespace std;\n\nvector<int> twoSum(vector<int>& nums, int target) {\n    // Write C++ solution\n    return {};\n}`,
      java: `class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        // Write Java solution\n        return new int[]{};\n    }\n}`,
      javascript: `function twoSum(nums, target) {\n    // Write JS solution\n    return [];\n}`
    }
  },
  {
    id: 2,
    title: "Valid Parentheses",
    difficulty: "Easy",
    category: "Data Structures",
    tags: ["#stack", "#strings"],
    description: "Given a string s containing '(', ')', '{', '}', '[' and ']', determine if the input string is valid.",
    starterCode: {
      python: `def is_valid(s: str) -> bool:\n    pass`,
      cpp: `#include <string>\nusing namespace std;\n\nbool isValid(string s) {\n    return false;\n}`,
      java: `class Solution {\n    public boolean isValid(String s) {\n        return false;\n    }\n}`,
      javascript: `function isValid(s) {\n    return false;\n}`
    }
  }
];
window.PROBLEMS = PROBLEMS;

// Game & Filter State
let currentProblemIndex = 0;
let currentLanguage = "python";

const FILE_NAMES = {
  python: "solution.py",
  cpp: "solution.cpp",
  java: "Solution.java",
  javascript: "solution.js"
};

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
    // 1. Query Supabase user_profiles directly
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

    // 2. If user is not yet in Supabase cloud but has existing score/solves, migrate them up
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

function getProblemCode(problem, lang) {
  if (!problem) return "";
  if (problem.starterCode && problem.starterCode[lang]) {
    return problem.starterCode[lang];
  }
  if (problem.starterCode && problem.starterCode.python) {
    return problem.starterCode.python;
  }
  return problem.buggy_code || "";
}

function renderProblemSequence() {
  const container = document.getElementById("problem-sequence-list");
  if (!container) return;

  container.innerHTML = PROBLEMS.map((p, idx) => {
    const active = idx === currentProblemIndex
      ? "bg-emerald-500/15 border-emerald-500/40 text-white"
      : "bg-[#0d1117] border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/70";

    const diffColor = p.difficulty === "Easy" ? "text-emerald-400"
      : p.difficulty === "Medium" ? "text-amber-400" : "text-rose-400";

    return `
      <button type="button" onclick="selectProblem(${idx})"
        class="w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition cursor-pointer ${active}">
        <span class="truncate font-medium">${p.id}. ${p.title}</span>
        <span class="font-mono text-[10px] ${diffColor} ml-2 shrink-0">${p.difficulty}</span>
      </button>
    `;
  }).join("");

  const progEl = document.getElementById("seq-progress");
  if (progEl) {
    progEl.textContent = `${currentProblemIndex + 1} / ${PROBLEMS.length}`;
  }
}
window.renderProblemSequence = renderProblemSequence;
window.renderProblemSequenceList = renderProblemSequence;

function selectProblem(index) {
  currentProblemIndex = index;
  const problem = PROBLEMS[index];
  if (!problem) return;
  currentProblem = problem;

  const idEl = document.getElementById("problem-id");
  if (idEl) idEl.textContent = `#${problem.id}`;
  const titleEl = document.getElementById("problem-title");
  if (titleEl) titleEl.textContent = problem.title;
  const diffEl = document.getElementById("problem-difficulty");
  if (diffEl) diffEl.textContent = problem.difficulty;
  const catEl = document.getElementById("problem-category");
  if (catEl) catEl.textContent = problem.category;
  const descEl = document.getElementById("problem-desc");
  if (descEl) descEl.textContent = problem.description;

  const tagsContainer = document.getElementById("problem-tags");
  if (tagsContainer) {
    tagsContainer.innerHTML = (problem.tags || []).map(t => {
      const cleanTag = String(t).startsWith("#") ? t : `#${t}`;
      return `<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">${cleanTag}</span>`;
    }).join("");
  }
  const hintBox = document.getElementById("hint-box");
  if (hintBox) hintBox.classList.add("hidden");

  loadStarterCodeForLanguage(currentLanguage);
  renderProblemSequence();
}
window.selectProblem = selectProblem;
window.selectSequenceProblem = function(id) {
  const idx = PROBLEMS.findIndex(p => p.id === id);
  if (idx !== -1) selectProblem(idx);
};

function switchLanguage(lang) {
  currentLanguage = lang;
  const langSelect = document.getElementById("language-select");
  if (langSelect && langSelect.value !== lang) {
    langSelect.value = lang;
  }
  loadStarterCodeForLanguage(lang);
}
window.switchLanguage = switchLanguage;

function loadStarterCodeForLanguage(lang) {
  const problem = PROBLEMS[currentProblemIndex] || currentProblem;
  if (!problem) return;
  const code = (problem.starterCode && problem.starterCode[lang]) || problem.buggy_code || "// Starter code coming soon";

  const filenameEl = document.getElementById("editor-filename");
  if (filenameEl) {
    filenameEl.textContent = FILE_NAMES[lang] || "solution.py";
  }

  // Update Monaco Editor language & value
  const ed = window.editor || window.monacoEditor || monacoEditor;
  if (ed && window.monaco) {
    isInjectingCode = true;
    monaco.editor.setModelLanguage(ed.getModel(), lang);
    ed.setValue(code);
    isInjectingCode = false;
  }
}
window.loadStarterCodeForLanguage = loadStarterCodeForLanguage;

function resetStarterCode() {
  loadStarterCodeForLanguage(currentLanguage);
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

// --- 5. ARCADE METRICS, GRAPH TELEMETRY & CONTROLLED TIMER ---
function updateMetrics() {
  const streakEl = document.getElementById("streak-count");
  const scoreEl = document.getElementById("score-count");
  if (streakEl) streakEl.textContent = streak;
  if (scoreEl) scoreEl.textContent = score;
  localStorage.setItem("lintiq_streak", streak);
  localStorage.setItem("lintiq_score", score);
  localStorage.setItem("lintiq_solves", solves);
}

function recordLintIQSolve(solveSeconds, passed) {
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

  const simulatedExecMs = Math.max(18, Math.min(120, Math.round(solveSeconds * 1.5)));
  current.avgLatencyMs[todayIdx] = current.avgLatencyMs[todayIdx] === 0
    ? simulatedExecMs
    : Math.round((current.avgLatencyMs[todayIdx] + simulatedExecMs) / 2);

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
  const status = document.getElementById("timer-status");
  if (status) {
    status.textContent = "(Ready)";
    status.className = "timer-status";
  }
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  const status = document.getElementById("timer-status");
  if (status) {
    status.textContent = "(Running)";
    status.className = "timer-status text-emerald-400";
  }

  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerRunning = false;
  const status = document.getElementById("timer-status");
  if (status) {
    status.textContent = "(Solved)";
    status.className = "timer-status text-sky-400";
  }
}

function updateTimerDisplay() {
  const mins = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const secs = String(timerSeconds % 60).padStart(2, '0');
  document.getElementById("timer-display").textContent = `${mins}:${secs}`;
}

// --- 6. PROBLEM LIFECYCLE ---
async function loadNewProblem() {
  try {
    resetTimer();
    document.getElementById("problem-title").textContent = "Fetching next bug hunt...";
    document.getElementById("hint-box").classList.add("hidden");
    document.getElementById("console-output").textContent = "Click inside the code editor to start timing and solve the bug.";
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

    currentProblem = await res.json();

    document.getElementById("problem-id").textContent = `#${currentProblem.id}`;
    document.getElementById("problem-title").textContent = currentProblem.title;
    document.getElementById("problem-desc").textContent = currentProblem.description;
    document.getElementById("problem-category").textContent = currentProblem.category || "General";

    const tagsContainer = document.getElementById("problem-tags");
    const tagsList = Array.isArray(currentProblem.tags) ? currentProblem.tags : [];
    tagsContainer.innerHTML = tagsList.map(tag => {
      const cleanTag = String(tag).startsWith("#") ? tag : `#${tag}`;
      return `<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">${cleanTag}</span>`;
    }).join("");

    const tcCount = Array.isArray(currentProblem.test_cases) ? currentProblem.test_cases.length : 0;
    document.getElementById("test-case-count").textContent = `🧪 ${tcCount} Test Assertion${tcCount === 1 ? '' : 's'}`;

    const diffBadge = document.getElementById("problem-difficulty");
    diffBadge.textContent = currentProblem.difficulty;

    document.getElementById("hint-box").classList.add("hidden");

    if (monacoEditor) {
      isInjectingCode = true;
      monacoEditor.setValue(getProblemCode(currentProblem, selectedLanguage));
      isInjectingCode = false;
    }

    resetTimer();
    renderProblemSequenceList();
  } catch (err) {
    console.warn("Backend load failed, falling back to local PROBLEMS:", err);
    const candidate = PROBLEMS.find(p => p.id !== currentProblem?.id) || PROBLEMS[0];
    if (candidate) {
      currentProblem = candidate;
      document.getElementById("problem-id").textContent = `#${candidate.id}`;
      document.getElementById("problem-title").textContent = candidate.title;
      document.getElementById("problem-desc").textContent = candidate.description;
      document.getElementById("problem-category").textContent = candidate.category || "General";

      const tagsContainer = document.getElementById("problem-tags");
      if (tagsContainer) {
        tagsContainer.innerHTML = (candidate.tags || []).map(tag => {
          const cleanTag = String(tag).startsWith("#") ? tag : `#${tag}`;
          return `<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">${cleanTag}</span>`;
        }).join("");
      }

      const diffBadge = document.getElementById("problem-difficulty");
      if (diffBadge) diffBadge.textContent = candidate.difficulty;
      document.getElementById("hint-box").classList.add("hidden");

      if (monacoEditor) {
        isInjectingCode = true;
        monacoEditor.setValue(getProblemCode(candidate, selectedLanguage));
        isInjectingCode = false;
      }
      resetTimer();
      renderProblemSequenceList();
      return;
    }
    document.getElementById("problem-title").textContent = "Failed to load challenge";
    document.getElementById("problem-desc").textContent = "Make sure your FastAPI backend is running on port 8000.";
    console.error(err);
  }
}

// --- 7. PATCH SUBMISSION & SUPABASE CLOUD PERSISTENCE ---
async function submitPatch() {
  if (!currentProblem || !monacoEditor) return;

  const userCode = monacoEditor.getValue();
  const consoleEl = document.getElementById("console-output");
  const statusTag = document.getElementById("status-tag");
  const submitBtn = document.getElementById("btn-submit");

  submitBtn.disabled = true;
  submitBtn.textContent = "Judging...";
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

      let pointsEarned = 0;
      if (result.profile) {
        streak = result.profile.streak;
        score = result.profile.score;
        solves = result.profile.solves;
        pointsEarned = result.profile.points_earned;
      } else {
        const timeBonus = Math.max(0, 60 - timerSeconds);
        streak += 1;
        solves += 1;
        pointsEarned = 100 + (streak * 10) + timeBonus;
        score += pointsEarned;
      }

      consoleEl.textContent = `✔ Cleared in ${timerSeconds}s! (+${pointsEarned} Points)\n${result.message || ''}`;
      updateMetrics();
      recordLintIQSolve(timerSeconds, true);

      if (userId && !String(userId).startsWith("mock_") && !String(userId).startsWith("test_")) {
        supabaseClient.from("user_profiles").upsert({
          id: userId,
          username: username,
          streak: streak,
          score: score,
          solves: solves,
          last_active: new Date().toISOString()
        }, { onConflict: "id" }).then(() => {});
      }
    } else {
      statusTag.textContent = "Failed";
      statusTag.className = "text-rose-400";
      consoleEl.textContent = `✖ Patch Failed:\n${result.message || 'Logic or assertion error.'}`;
      streak = 0;
      updateMetrics();
      recordLintIQSolve(timerSeconds, false);

      if (userId && !String(userId).startsWith("mock_") && !String(userId).startsWith("test_")) {
        supabaseClient.from("user_profiles").update({
          streak: 0,
          last_active: new Date().toISOString()
        }).eq("id", userId).then(() => {});
      }
    }
  } catch (err) {
    statusTag.textContent = "Error";
    statusTag.className = "text-rose-400";
    consoleEl.textContent = `Failed to communicate with test runner: ${err.message}`;
    console.error(err);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Patch";
  }
}

// --- 8. AI HINT ENGINE ---
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

// --- 9. MONACO INITIALIZATION ---
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

  // Expose globally so Settings > Editor Settings can update options live
  window.editor = monacoEditor;
  window.monacoEditor = monacoEditor;

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

  initAuth();
  updateMetrics();
  initCategoryCounts();
  if (typeof selectProblem === "function" && Array.isArray(window.PROBLEMS) && window.PROBLEMS.length > 0) {
    selectProblem(0);
  } else {
    loadNewProblem();
  }
});

// --- 10. AI CHALLENGE GENERATOR & CATEGORY REFRESH ---
async function generateAIChallenge() {
  const btn = document.getElementById("ai-generate-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "✨ Generating...";
  }

  const outEl =
    document.getElementById("console-output") ||
    document.getElementById("sandbox-output") ||
    document.getElementById("output-box");
  if (outEl) {
    outEl.textContent =
      "🤖 Gemini AI is synthesizing a new buggy program and verifying 4 test assertions...";
  }

  try {
    const params = new URLSearchParams();
    if (typeof currentCategory !== "undefined" && currentCategory && currentCategory !== "All") {
      params.set("category", currentCategory);
    } else if (typeof selectedCategory !== "undefined" && selectedCategory && selectedCategory !== "All") {
      params.set("category", selectedCategory);
    }

    if (typeof currentDifficulty !== "undefined" && currentDifficulty && currentDifficulty !== "All") {
      params.set("difficulty", currentDifficulty);
    } else if (typeof selectedDifficulty !== "undefined" && selectedDifficulty && selectedDifficulty !== "All") {
      params.set("difficulty", selectedDifficulty);
    }

    const query = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${API}/generate-ai-problem${query}`, { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || "Failed to generate AI challenge");
    }

    await refreshCategoryPillCounts();
    if (typeof fetchCategories === "function") await fetchCategories();
    if (typeof loadCategories === "function") await loadCategories();

    const nextBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent.includes("Next Challenge")
    );
    if (nextBtn) {
      nextBtn.click();
    }

    setTimeout(() => {
      const idEl =
        document.getElementById("problem-id") ||
        document.getElementById("challenge-id");
      if (idEl && data.id) {
        idEl.textContent = `#${data.id}`;
      }
      if (outEl) {
        outEl.textContent = `✨ New AI Challenge #${data.id} (${data.title}) loaded! Click inside the editor to hunt the bug.`;
      }
    }, 300);
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

    const countsMap = {};
    let total = 0;

    const rawCats =
      data && typeof data === "object" && !Array.isArray(data) && data.categories
        ? data.categories
        : data;

    if (Array.isArray(rawCats)) {
      rawCats.forEach((item) => {
        if (item && typeof item === "object") {
          const name = item.category || item.name || item.track;
          const cnt = Number(item.count ?? item.total ?? 0);
          if (name && Number.isFinite(cnt)) {
            countsMap[String(name).toLowerCase()] = cnt;
            total += cnt;
          }
        }
      });
    } else if (rawCats && typeof rawCats === "object") {
      Object.entries(rawCats).forEach(([k, v]) => {
        if (k.toLowerCase() === "total") return;
        const cnt =
          typeof v === "object" && v !== null
            ? Number(v.count ?? v.total ?? 0)
            : Number(v);
        if (Number.isFinite(cnt)) {
          countsMap[k.toLowerCase()] = cnt;
          total += cnt;
        }
      });
    }

    let domSum = 0;
    let allTracksBtn = null;

    document.querySelectorAll("button").forEach((btn) => {
      const txt = btn.textContent.trim();
      if (txt.startsWith("All Tracks")) {
        allTracksBtn = btn;
      } else {
        Object.entries(countsMap).forEach(([catLower, cnt]) => {
          if (txt.toLowerCase().startsWith(catLower)) {
            const cleanName = txt.replace(/\s*\([^)]*\)\s*$/, "").trim();
            btn.innerHTML = `${cleanName} <span class="opacity-75">(${cnt})</span>`;
          }
        });
        const match = btn.textContent.match(/\((\d+)\)/);
        if (match) domSum += Number(match[1]);
      }
    });

    const finalTotal =
      total > 0
        ? total
        : Number.isFinite(Number(data?.total)) && Number(data.total) > 0
        ? Number(data.total)
        : domSum;

    if (allTracksBtn && Number.isFinite(finalTotal) && finalTotal > 0) {
      allTracksBtn.innerHTML = `All Tracks <span class="opacity-75">(${finalTotal})</span>`;
    }
  } catch (e) {
    console.warn("Could not refresh category counts:", e);
  }
}