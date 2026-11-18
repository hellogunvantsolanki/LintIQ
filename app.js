// --- 1. CONFIGURATION ---
const API = (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
  ? "http://127.0.0.1:8000"
  : "https://lintiq.onrender.com";

const SUPABASE_URL = "https://rqkymtiatlkrndsqmoys.supabase.co";
const SUPABASE_KEY = "sb_publishable_Re4QdRQd83O7RAAAAJBx4g_jc6l23_P";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
      // If local progress is higher than cloud (e.g., before cloud table was created), push local up
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
      return;
    }

    // 2. If user is not yet in Supabase cloud but has existing score/solves, migrate them up
    const res = await fetch(`${API}/profile/${encodeURIComponent(user.id)}`);
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

  if (user) {
    closeAuthModal();
    loginBtn.classList.add("hidden");
    userProfile.classList.remove("hidden");

    const name = getDisplayUsername(user);
    userDisplayName.textContent = name;
    userDisplayName.title = name;
  } else {
    loginBtn.classList.remove("hidden");
    userProfile.classList.add("hidden");
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

    // 1. Query Supabase Postgres directly for permanent cloud leaderboard
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

    // 2. Also fetch Backend Leaderboard & merge any local profiles not yet in cloud
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
    } catch (_) {
      // Backend fallback optional if Supabase direct succeeded
    }

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

// --- 5. ARCADE METRICS & CONTROLLED TIMER ---
function updateMetrics() {
  document.getElementById("streak-count").textContent = streak;
  document.getElementById("score-count").textContent = score;
  localStorage.setItem("lintiq_streak", streak);
  localStorage.setItem("lintiq_score", score);
  localStorage.setItem("lintiq_solves", solves);
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
    tagsContainer.innerHTML = tagsList.map(tag => 
      `<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">#${tag}</span>`
    ).join("");

    const tcCount = Array.isArray(currentProblem.test_cases) ? currentProblem.test_cases.length : 0;
    document.getElementById("test-case-count").textContent = `🧪 ${tcCount} Test Assertion${tcCount === 1 ? '' : 's'}`;
    
    const diffBadge = document.getElementById("problem-difficulty");
    diffBadge.textContent = currentProblem.difficulty;
    const diffLower = (currentProblem.difficulty || "").toLowerCase();
    if (diffLower === "easy") {
      diffBadge.className = "text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40";
    } else if (diffLower === "medium") {
      diffBadge.className = "text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40";
    } else {
      diffBadge.className = "text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40";
    }

    if (monacoEditor) {
      isInjectingCode = true;
      monacoEditor.setValue(currentProblem.buggy_code);
      isInjectingCode = false;
    }

    resetTimer();
  } catch (err) {
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
    const res = await fetch(`${API}/submit-patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    if (result.passed) {
      stopTimer();
      statusTag.textContent = "Passed";
      statusTag.className = "text-emerald-400";
      consoleEl.textContent = `✔ Cleared in ${timerSeconds}s!\n${result.message || ''}`;

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
      updateMetrics();

      // Mirror solve directly to Supabase Postgres from authenticated browser session
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

      setTimeout(() => {
        alert(`Bug squashed! +${pointsEarned} Points`);
        loadNewProblem();
      }, 500);
    } else {
      statusTag.textContent = "Failed";
      statusTag.className = "text-rose-400";
      consoleEl.textContent = `✖ Patch Failed:\n${result.message || 'Logic or assertion error.'}`;
      streak = 0;
      updateMetrics();

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
    consoleEl.textContent = "Failed to communicate with test runner.";
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
  monacoEditor = monaco.editor.create(document.getElementById("editor-container"), {
    value: "# Loading challenge code...",
    language: "python",
    theme: "vs-dark",
    fontSize: 14,
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 }
  });

  monacoEditor.onDidFocusEditorText(() => {
    if (!timerRunning && currentProblem) {
      startTimer();
    }
  });

  monacoEditor.onDidChangeModelContent(() => {
    if (!isInjectingCode && !timerRunning && currentProblem) {
      startTimer();
    }
  });

  initAuth();
  updateMetrics();
  initCategoryCounts();
  loadNewProblem();
});



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

    // 1. Refresh category pill counts from /categories
    await refreshCategoryPillCounts();
    if (typeof fetchCategories === "function") await fetchCategories();
    if (typeof loadCategories === "function") await loadCategories();

    // 2. Load the queued AI problem onto the screen
    const nextBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent.includes("Next Challenge")
    );
    if (nextBtn) {
      nextBtn.click();
    }

    setTimeout(() => {
      // Ensure the #ID badge on the card matches the new problem ID
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

    // Unwrap nested { total, categories } structure from fetch_categories_summary()
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