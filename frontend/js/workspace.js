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

// --- 1.1 CURATED MULTI-LANGUAGE FALLBACK PROBLEMS ---
const PROBLEMS = [
  {
    id: 1,
    title: "Two Sum",
    difficulty: "Easy",
    category: "Algorithms",
    tags: ["#hashmap", "#arrays"],
    description: "Given an array of integers nums and an integer target, return indices of the two numbers that add up to target.",
    language: "python",
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
    language: "python",
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

// Sequential Problem Navigation State
let problemSequence = [];
let currentSeqIndex = 0;
const API_BASE = API;

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
  document.getElementById("auth-modal")?.classList.remove("hidden");
  const msg = document.getElementById("auth-msg");
  if (msg) msg.textContent = "";
}

function closeAuthModal() {
  document.getElementById("auth-modal")?.classList.add("hidden");
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
      btn.className = "cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-emerald-600 text-white shadow-sm whitespace-nowrap shrink-0 cursor-pointer";
    } else {
      btn.className = "cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-700 whitespace-nowrap shrink-0 cursor-pointer";
    }
  });
  currentSeqIndex = 0;
  fetchProblemSequence(category, selectedDifficulty, true);
}

function selectDifficulty(difficulty) {
  selectedDifficulty = difficulty;
  currentSeqIndex = 0;
  fetchProblemSequence(selectedCategory, difficulty, true);
}

function getProblemCode(problem, lang) {
  if (!problem) return "";
  if (problem.starterCode && problem.starterCode[lang]) {
    return problem.starterCode[lang];
  }
  const probLang = (problem.language || "python").toLowerCase();
  if (problem.buggy_code && (lang === probLang || !problem.starterCode)) {
    return problem.buggy_code;
  }
  if (problem.starterCode && problem.starterCode.python) {
    return problem.starterCode.python;
  }
  return problem.buggy_code || "";
}

function renderProblemSequence() {
  const container = document.getElementById("problem-sequence-list");
  const list = problemSequence.length > 0 ? problemSequence : PROBLEMS;
  const activeIdx = problemSequence.length > 0 ? currentSeqIndex : currentProblemIndex;

  if (container && !container.classList.contains("hidden")) {
    container.innerHTML = list.slice(0, 200).map((p, idx) => {
      const active = idx === activeIdx
        ? "bg-emerald-500/15 border-emerald-500/40 text-white"
        : "bg-[#0d1117] border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/70";

      const diffColor = p.difficulty === "Easy" ? "text-emerald-400"
        : p.difficulty === "Medium" ? "text-amber-400" : "text-rose-400";

      if (problemSequence.length > 0) {
        return `
          <button type="button" onclick="jumpToProblemById(${p.id})"
            class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs transition cursor-pointer ${active}">
            <span class="flex items-center gap-1.5 truncate font-medium">
              <span class="w-4 text-center">${p.solved ? "✅" : "○"}</span>
              ${idx + 1}. ${p.title}
            </span>
            <span class="font-mono text-[10px] ${diffColor} ml-2 shrink-0">${p.difficulty}</span>
          </button>
        `;
      }
      return `
        <button type="button" onclick="selectProblem(${idx})"
          class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs transition cursor-pointer ${active}">
          <span class="truncate font-medium">${p.id}. ${p.title}</span>
          <span class="font-mono text-[10px] ${diffColor} ml-2 shrink-0">${p.difficulty}</span>
        </button>
      `;
    }).join("");
  }

  const progEl = document.getElementById("seq-progress");
  if (progEl) {
    const idx = problemSequence.length > 0 ? currentSeqIndex : currentProblemIndex;
    const total = list.length;
    progEl.textContent = total > 0 ? `${idx + 1} / ${total}` : "0 / 0";
  }
}
window.renderProblemSequence = renderProblemSequence;
window.renderProblemSequenceList = renderProblemSequence;

function selectProblem(index) {
  currentProblemIndex = index;
  const problem = PROBLEMS[index];
  if (!problem) return;
  renderProblem(problem);
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
  const problem = currentProblem || PROBLEMS[currentProblemIndex];
  if (!problem) return;

  const code = getProblemCode(problem, lang) || "// Starter code coming soon";

  const filenameEl = document.getElementById("editor-filename");
  if (filenameEl) {
    filenameEl.textContent = FILE_NAMES[lang] || "solution.py";
  }

  const ed = window.editor || window.monacoEditor || monacoEditor;
  if (ed && window.monaco) {
    const model = ed.getModel();
    isInjectingCode = true;
    if (model) {
      monaco.editor.setModelLanguage(model, lang);
    }
    ed.setValue(code);
    isInjectingCode = false;
  }
}
window.loadStarterCodeForLanguage = loadStarterCodeForLanguage;

function resetStarterCode() {
  if (!currentProblem) return;
  loadStarterCodeForLanguage(currentLanguage);
  hideCopyDiffButton();
  resetTimer();
}

// --- SEQUENTIAL PROBLEM NAVIGATION (API-Backed) ---
async function fetchProblemSequence(category, difficulty, autoLoadFirst = true) {
  category = category || selectedCategory || "All";
  difficulty = difficulty || selectedDifficulty || "All";
  const url = `${API_BASE}/problems?category=${encodeURIComponent(category)}&difficulty=${encodeURIComponent(difficulty)}&limit=5000`;

  try {
    const headers = {};
    if (currentSession?.access_token) {
      headers["Authorization"] = `Bearer ${currentSession.access_token}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const localSolvedMap = getSolvedMap();
    problemSequence = (data.problems || []).map(p => ({
      ...p,
      solved: Boolean(p.solved) || Boolean(localSolvedMap[String(p.id)])
    }));

    const drawerCount = document.getElementById("drawer-count");
    if (drawerCount) drawerCount.textContent = `${data.total} Challenges (Sequential)`;

    renderDrawerRows(problemSequence);
    renderProblemSequence();

    if (autoLoadFirst && problemSequence.length > 0) {
      loadSequentialProblem(0);
    } else if (autoLoadFirst && problemSequence.length === 0) {
      document.getElementById("problem-title").textContent = "No challenges match this filter";
      document.getElementById("problem-desc").textContent = `No ${difficulty !== "All" ? difficulty : ""} challenges found in "${category}". Switch difficulty to "All Levels" or select another category.`;
      document.getElementById("problem-tags").innerHTML = "";
    }
  } catch (err) {
    console.warn("Could not fetch problem sequence, using local fallback:", err);
  }
}
window.fetchProblemSequence = fetchProblemSequence;

function renderDrawerRows(list) {
  const container = document.getElementById("problem-sequence-rows");
  if (!container) return;

  // Cap rendered DOM rows to 250 for smooth drawer scrolling; search narrows across all 1,600+
  const visible = list.slice(0, 250);
  const moreCount = Math.max(0, list.length - visible.length);

  container.innerHTML = visible.map((p) => {
    const isActive = problemSequence[currentSeqIndex]?.id === p.id;
    const diffClass =
      p.difficulty === "Easy" ? "text-emerald-400" :
      p.difficulty === "Medium" ? "text-amber-400" : "text-rose-400";

    return `
      <button
        onclick="jumpToProblemById(${p.id})"
        class="w-full px-4 py-3 flex items-center justify-between gap-3 text-left transition cursor-pointer ${
          isActive ? "bg-emerald-500/15 border-l-2 border-emerald-400" : "hover:bg-[#161b22]"
        }"
      >
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-4 text-center text-xs">${p.solved ? "✅" : "○"}</span>
          <span class="text-xs font-mono text-zinc-500 shrink-0">#${p.id}</span>
          <span class="text-xs font-medium text-zinc-200 truncate">${p.title}</span>
        </div>
        <span class="text-[11px] font-mono font-semibold shrink-0 ${diffClass}">${p.difficulty}</span>
      </button>
    `;
  }).join("") + (moreCount > 0
    ? `<div class="px-4 py-3 text-center text-[11px] font-mono text-zinc-500">Use search above or <a href="problem-directory.html" class="text-emerald-400 hover:underline">open Problem Directory</a> to browse ${moreCount} more challenges.</div>`
    : "");
}
window.renderDrawerRows = renderDrawerRows;

function filterDrawerList(query) {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const filtered = problemSequence.filter(
    (p, idx) => p.title.toLowerCase().includes(q) || String(idx + 1) === q || String(p.id) === q
  );
  renderDrawerRows(filtered);
}
window.filterDrawerList = filterDrawerList;

async function loadProblemByIdDirect(problemId) {
  try {
    resetTimer();
    hideCopyDiffButton();
    document.getElementById("problem-title").textContent = "Loading challenge...";
    document.getElementById("hint-box")?.classList.add("hidden");

    const res = await fetch(`${API_BASE}/problems/${encodeURIComponent(problemId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const problem = await res.json();

    const seqIdx = problemSequence.findIndex(p => Number(p.id) === Number(problem.id));
    if (seqIdx !== -1) currentSeqIndex = seqIdx;

    renderProblem(problem);
    renderDrawerRows(problemSequence);
    renderProblemSequence();
  } catch (err) {
    console.error("Failed to load problem by ID:", err);
    if (problemSequence.length > 0) {
      loadSequentialProblem(0);
    } else {
      loadNewProblem();
    }
  }
}
window.loadProblemByIdDirect = loadProblemByIdDirect;

async function loadSequentialProblem(seqIndex) {
  if (seqIndex < 0 || seqIndex >= problemSequence.length) return;
  currentSeqIndex = seqIndex;
  const target = problemSequence[seqIndex];

  try {
    resetTimer();
    hideCopyDiffButton();
    document.getElementById("problem-title").textContent = "Loading challenge...";
    document.getElementById("hint-box")?.classList.add("hidden");

    const res = await fetch(`${API_BASE}/problems/${target.id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const problem = await res.json();

    renderProblem(problem);
    renderDrawerRows(problemSequence);
    renderProblemSequence();
  } catch (err) {
    console.error("Failed to load sequential problem:", err);
    document.getElementById("problem-title").textContent = "Failed to load challenge";
    document.getElementById("problem-desc").textContent = "Make sure your FastAPI backend is running.";
  }
}
window.loadSequentialProblem = loadSequentialProblem;

function jumpToProblemById(id) {
  const idx = problemSequence.findIndex(p => Number(p.id) === Number(id));
  if (idx !== -1) {
    loadSequentialProblem(idx);
    closeProblemListDrawer();
  } else {
    loadProblemByIdDirect(id);
    closeProblemListDrawer();
  }
}
window.jumpToProblemById = jumpToProblemById;

function loadNextProblem() {
  if (problemSequence.length > 0) {
    if (currentSeqIndex + 1 < problemSequence.length) {
      loadSequentialProblem(currentSeqIndex + 1);
    }
    return;
  }
  if (PROBLEMS.length === 0) return;
  currentProblemIndex = (currentProblemIndex + 1) % PROBLEMS.length;
  selectProblem(currentProblemIndex);
}
window.loadNextProblem = loadNextProblem;

function loadPrevProblem() {
  if (problemSequence.length > 0) {
    if (currentSeqIndex - 1 >= 0) {
      loadSequentialProblem(currentSeqIndex - 1);
    }
    return;
  }
  if (PROBLEMS.length === 0) return;
  currentProblemIndex = (currentProblemIndex - 1 + PROBLEMS.length) % PROBLEMS.length;
  selectProblem(currentProblemIndex);
}
window.loadPrevProblem = loadPrevProblem;

function openProblemListDrawer() {
  document.getElementById("problem-list-drawer")?.classList.remove("hidden");
}
window.openProblemListDrawer = openProblemListDrawer;

function closeProblemListDrawer() {
  document.getElementById("problem-list-drawer")?.classList.add("hidden");
}
window.closeProblemListDrawer = closeProblemListDrawer;

// --- 4. PERMANENT CLOUD LEADERBOARD MODAL LOGIC ---
function openLeaderboardModal() {
  document.getElementById("leaderboard-modal")?.classList.remove("hidden");
  fetchLeaderboard();
}

function closeLeaderboardModal() {
  document.getElementById("leaderboard-modal")?.classList.add("hidden");
}

async function fetchLeaderboard() {
  const tbody = document.getElementById("leaderboard-rows");
  const syncStatus = document.getElementById("leaderboard-sync-status");
  if (!tbody) return;

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

function saveLastActiveProblem(problem) {
  if (!problem || !problem.id) return;
  try {
    localStorage.setItem("lintiq_last_active_problem", JSON.stringify({
      id: problem.id,
      title: problem.title,
      difficulty: problem.difficulty || "Medium",
      category: problem.category || "General",
      description: String(problem.description || "").slice(0, 160),
      updatedAt: Date.now()
    }));
  } catch (_) {}
}

function syncProblemUrl(problemId) {
  if (!problemId || !window.history || typeof window.history.replaceState !== "function") return;
  const url = new URL(window.location.href);
  url.searchParams.set("id", String(problemId));
  url.searchParams.delete("ai");
  window.history.replaceState(null, "", url.pathname + url.search);
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
  const status = document.getElementById("timer-status");
  if (status) {
    status.textContent = "READY";
    status.className = "text-[10px] uppercase tracking-wider text-gray-400";
  }
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  const status = document.getElementById("timer-status");
  if (status) {
    status.textContent = "RUNNING";
    status.className = "text-[10px] uppercase tracking-wider text-emerald-400";
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
    status.textContent = "SOLVED";
    status.className = "text-[10px] uppercase tracking-wider text-sky-400";
  }
}

function updateTimerDisplay() {
  const mins = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const secs = String(timerSeconds % 60).padStart(2, '0');
  const display = document.getElementById("timer-display");
  if (display) display.textContent = `${mins}:${secs}`;
}

// --- 6. PROBLEM LIFECYCLE (STATELESS RENDERER) ---
function renderProblem(problem, customConsoleMsg = null) {
  if (!problem) return;

  currentProblem = problem;
  window.currentProblem = problem;
  hideCopyDiffButton();

  // Persist active session for problem-directory.html & update browser URL
  saveLastActiveProblem(problem);
  if (Number(problem.id) < 100000) {
    syncProblemUrl(problem.id);
  }

  document.getElementById("problem-id").textContent = `#${problem.id}`;
  document.getElementById("problem-title").textContent = `#${problem.id} ${problem.title}`;
  document.getElementById("problem-desc").textContent = problem.description;
  document.getElementById("problem-category").textContent = problem.category || "General";

  const tagsContainer = document.getElementById("problem-tags");
  const tagsList = Array.isArray(problem.tags) ? problem.tags : [];
  tagsContainer.innerHTML = tagsList.map(tag => {
    const cleanTag = String(tag).startsWith("#") ? tag : `#${tag}`;
    return `<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-surface-container text-gray-400 border border-surface-border">${cleanTag}</span>`;
  }).join("");

  const tcCount = Array.isArray(problem.test_cases) ? problem.test_cases.length : 0;
  document.getElementById("test-case-count").textContent = `🧪 ${tcCount} Test Assertion${tcCount === 1 ? '' : 's'}`;

  const diffBadge = document.getElementById("problem-difficulty");
  const diffText = (problem.difficulty || "Medium").toUpperCase();
  diffBadge.textContent = diffText;
  if (diffText === "EASY") {
    diffBadge.className = "px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded";
  } else if (diffText === "HARD") {
    diffBadge.className = "px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded";
  } else {
    diffBadge.className = "px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded";
  }

  document.getElementById("hint-box")?.classList.add("hidden");
  const statusTag = document.getElementById("status-tag");
  if (statusTag) {
    statusTag.textContent = "Idle";
    statusTag.className = "text-[10px] font-mono bg-surface-border text-gray-300 px-1.5 py-0.2 rounded";
  }
  document.getElementById("console-output").textContent =
    customConsoleMsg ||
    "Click inside the code editor to start timing and solve the bug. Use ▶ Test Run anytime without risking your streak.";

  const stdinEl = document.getElementById("custom-stdin");
  if (stdinEl) {
    stdinEl.value = getSampleInput();
    updateStdinBadge();
  }

  const targetLang = (problem.language || "python").toLowerCase();
  currentLanguage = targetLang;
  const langSelect = document.getElementById("language-select");
  if (langSelect && FILE_NAMES[targetLang]) {
    langSelect.value = targetLang;
  }
  loadStarterCodeForLanguage(targetLang);

  resetTimer();
}

async function loadNewProblem() {
  try {
    resetTimer();
    hideCopyDiffButton();
    document.getElementById("problem-title").textContent = "Fetching next bug hunt...";
    document.getElementById("hint-box")?.classList.add("hidden");
    document.getElementById("console-output").textContent = "Click inside the code editor to start timing and solve the bug. Use ▶ Test Run anytime without risking your streak.";

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
    renderProblemSequence();
  } catch (err) {
    console.warn("Backend load failed, falling back to local PROBLEMS:", err);
    const candidate = PROBLEMS.find(p => p.id !== currentProblem?.id) || PROBLEMS[0];
    if (candidate) {
      renderProblem(candidate);
      renderProblemSequence();
      return;
    }
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
  const timerStatusText = (document.getElementById("timer-status")?.textContent || "").toUpperCase();
  if (prefs.autoTimer !== false && !timerRunning && !timerStatusText.includes("SOLVED")) {
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
  statusTag.className = "text-[10px] font-mono bg-sky-500/15 text-sky-400 px-1.5 py-0.2 rounded";

  try {
    const res = await fetch(`${API}/run-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: currentProblem.id,
        user_code: userCode,
        stdin: stdinVal,
        language: currentLanguage || currentProblem.language || "python"
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
          statusTag.className = "text-[10px] font-mono bg-emerald-500/15 text-emerald-400 px-1.5 py-0.2 rounded";

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
          statusTag.className = "text-[10px] font-mono bg-rose-500/15 text-rose-400 px-1.5 py-0.2 rounded";

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
        statusTag.className = "text-[10px] font-mono bg-sky-500/15 text-sky-400 px-1.5 py-0.2 rounded";

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
      statusTag.className = "text-[10px] font-mono bg-rose-500/15 text-rose-400 px-1.5 py-0.2 rounded";

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
    statusTag.className = "text-[10px] font-mono bg-rose-500/15 text-rose-400 px-1.5 py-0.2 rounded";
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
  statusTag.className = "text-[10px] font-mono bg-amber-500/15 text-amber-400 px-1.5 py-0.2 rounded";

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
        language: currentLanguage || currentProblem.language || "python",
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
      statusTag.className = "text-[10px] font-mono bg-emerald-500/15 text-emerald-400 px-1.5 py-0.2 rounded";

      // Mark solved checkmark live in Problem Sequence & Drawer
      const seqItem = problemSequence.find(p => Number(p.id) === Number(currentProblem.id));
      if (seqItem && !seqItem.solved) {
        seqItem.solved = true;
        renderProblemSequence();
        renderDrawerRows(problemSequence);
      }

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
        solvedMap[pidKey] = { bestPoints: Math.max(prevRecord?.bestPoints || 0, pointsEarned), bestGrade: grade };
        saveSolvedMap(solvedMap);
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
      statusTag.className = "text-[10px] font-mono bg-rose-500/15 text-rose-400 px-1.5 py-0.2 rounded";
      consoleEl.textContent = `✖ Patch Failed:\n${result.message || 'Logic or assertion error.'}`;
      streak = 0;
      updateMetrics();
      recordLintIQSolve(timerSeconds, false);
    }
  } catch (err) {
    statusTag.textContent = "Error";
    statusTag.className = "text-[10px] font-mono bg-rose-500/15 text-rose-400 px-1.5 py-0.2 rounded";
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

// --- 10. MONACO INITIALIZATION & DEEP-LINK ROUTING ---
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

  // Parse URL params (?id=42, ?category=Algorithms, ?difficulty=Hard, ?ai=1)
  const urlParams = new URLSearchParams(window.location.search);
  const requestedId = parseInt(urlParams.get("id") || "", 10);
  const requestedAi = urlParams.get("ai") === "1";
  const requestedCat = urlParams.get("category");
  const requestedDiff = urlParams.get("difficulty");

  if (requestedCat) selectedCategory = requestedCat;
  if (requestedDiff) {
    selectedDifficulty = requestedDiff;
    const diffEl = document.getElementById("difficulty-select");
    if (diffEl) diffEl.value = requestedDiff;
  }

  initAuth().then(() => {
    const autoLoadFirst = !Number.isFinite(requestedId) && !requestedAi;
    fetchProblemSequence(selectedCategory, selectedDifficulty, autoLoadFirst).then(() => {
      if (requestedAi) {
        generateAIChallenge();
        return;
      }

      if (Number.isFinite(requestedId)) {
        const matchIdx = problemSequence.findIndex(p => Number(p.id) === requestedId);
        if (matchIdx !== -1) {
          loadSequentialProblem(matchIdx);
        } else {
          loadProblemByIdDirect(requestedId);
        }
        return;
      }

      if (problemSequence.length === 0) {
        if (typeof selectProblem === "function" && Array.isArray(window.PROBLEMS) && window.PROBLEMS.length > 0) {
          selectProblem(0);
        } else {
          loadNewProblem();
        }
      }
    }).catch(() => {
      if (Number.isFinite(requestedId)) {
        loadProblemByIdDirect(requestedId);
      } else if (typeof selectProblem === "function" && Array.isArray(window.PROBLEMS) && window.PROBLEMS.length > 0) {
        selectProblem(0);
      } else {
        loadNewProblem();
      }
    });
  });

  updateMetrics();
  initCategoryCounts();
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