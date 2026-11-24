// --- 1. CONFIGURATION (Matches app.js) ---
const API = (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
  ? "http://127.0.0.1:8000"
  : "https://lintiq.onrender.com";

const SUPABASE_URL = "https://rqkymtiatlkrndsqmoys.supabase.co";
const SUPABASE_KEY = "sb_publishable_Re4QdRQd83O7RAAAAJBx4g_jc6l23_P";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Directory State
let dirSession = null;
let dirUser = null;
let allProblems = [];
let filteredProblems = [];
let solvedIdSet = new Set();

let activeCategory = "All";
let activeDifficulty = "All";
let activeStatus = "All";
let searchQuery = "";
let currentPage = 1;
let pageSize = 25;

// --- 2. UTILITIES ---
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDirDisplayName(user) {
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

function formatTimeAgo(timestampMs) {
  if (!timestampMs) return "Ready";
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return "Updated just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `Updated ${days}d ago`;
}

function getLastActiveProblem() {
  try {
    return JSON.parse(localStorage.getItem("lintiq_last_active_problem") || "null");
  } catch (_) {
    return null;
  }
}

function getLocalSolvedIds() {
  const uid = dirUser?.id || "guest";
  const ids = new Set();
  try {
    const map = JSON.parse(localStorage.getItem(`lintiq_solved_map_${uid}`) || "{}") || {};
    Object.keys(map).forEach(k => {
      const n = Number(k);
      if (Number.isFinite(n)) ids.add(n);
    });
  } catch (_) {}
  return ids;
}

// --- 3. AUTHENTICATION & USER STATS ---
function openDirAuthModal() {
  document.getElementById("dir-auth-modal")?.classList.remove("hidden");
  const msg = document.getElementById("dir-auth-msg");
  if (msg) msg.textContent = "";
}
window.openDirAuthModal = openDirAuthModal;

function closeDirAuthModal() {
  document.getElementById("dir-auth-modal")?.classList.add("hidden");
}
window.closeDirAuthModal = closeDirAuthModal;

async function dirLoginWithOAuth(provider) {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.origin }
  });
  if (error) alert(`${provider} error: ` + error.message);
}
window.dirLoginWithOAuth = dirLoginWithOAuth;

async function dirHandleEmailAuth(event) {
  event.preventDefault();
  const email = document.getElementById("dir-auth-email").value.trim();
  const msgEl = document.getElementById("dir-auth-msg");
  const btn = document.getElementById("dir-btn-email-submit");

  btn.disabled = true;
  btn.textContent = "Sending link...";
  msgEl.className = "text-[11px] text-center text-gray-400";
  msgEl.textContent = "";

  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
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
window.dirHandleEmailAuth = dirHandleEmailAuth;

async function dirLogout() {
  await supabaseClient.auth.signOut();
  window.location.reload();
}
window.dirLogout = dirLogout;

function updateDirAuthUI(user) {
  const loginBtn = document.getElementById("dir-btn-login");
  const profileBox = document.getElementById("dir-user-profile");
  const nameEl = document.getElementById("dir-user-name");
  const avatarEl = document.getElementById("dir-user-avatar");

  if (user) {
    closeDirAuthModal();
    loginBtn?.classList.add("hidden");
    profileBox?.classList.remove("hidden");
    const displayName = getDirDisplayName(user);
    if (nameEl) {
      nameEl.textContent = displayName.toUpperCase();
      nameEl.title = displayName;
    }
    if (avatarEl) avatarEl.textContent = getInitials(displayName);
  } else {
    loginBtn?.classList.remove("hidden");
    profileBox?.classList.add("hidden");
  }
}

async function syncDirUserStats() {
  let streak = parseInt(localStorage.getItem("lintiq_streak") || "0", 10);
  let score = parseInt(localStorage.getItem("lintiq_score") || "0", 10);
  let solves = parseInt(localStorage.getItem("lintiq_solves") || "0", 10);

  if (dirUser?.id) {
    try {
      const { data: profile } = await supabaseClient
        .from("user_profiles")
        .select("score, streak, solves")
        .eq("id", dirUser.id)
        .maybeSingle();

      if (profile) {
        score = Math.max(score, profile.score || 0);
        streak = Math.max(streak, profile.streak || 0);
        solves = Math.max(solves, profile.solves || 0);
      }

      // Also pull cloud solved problem IDs if user_solves is readable
      const { data: cloudSolves } = await supabaseClient
        .from("user_solves")
        .select("problem_id")
        .eq("user_id", dirUser.id);

      if (Array.isArray(cloudSolves)) {
        cloudSolves.forEach(row => {
          const n = Number(row.problem_id);
          if (Number.isFinite(n)) solvedIdSet.add(n);
        });
      }
    } catch (err) {
      console.warn("Cloud stats read fallback:", err);
    }
  }

  document.getElementById("dir-streak").textContent = streak;
  document.getElementById("stat-streak").textContent = `${streak} ${streak === 1 ? "Day" : "Days"}`;
  document.getElementById("stat-score").textContent = `${score.toLocaleString()} pts`;
  document.getElementById("stat-solves").textContent = `${Math.max(solves, solvedIdSet.size)} Bugs`;
}

// --- 4. FETCH CATEGORIES & FULL PROBLEM CATALOG ---
async function loadCategories() {
  try {
    const res = await fetch(`${API}/categories`);
    if (!res.ok) return;
    const data = await res.json();

    const allBadge = document.getElementById("cat-count-All");
    if (allBadge) allBadge.textContent = Number(data.total || 0).toLocaleString();

    (data.categories || []).forEach(c => {
      const badge = document.getElementById(`cat-count-${c.name}`);
      if (badge) badge.textContent = Number(c.count || 0).toLocaleString();
    });
  } catch (err) {
    console.warn("Could not load category counts:", err);
  }
}

async function loadAllProblems() {
  const tbody = document.getElementById("directory-rows");
  const footerStatus = document.getElementById("dir-sync-footer");

  try {
    const headers = {};
    if (dirSession?.access_token) {
      headers["Authorization"] = `Bearer ${dirSession.access_token}`;
    }

    const res = await fetch(`${API}/problems?category=All&difficulty=All&limit=5000`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const localSolved = getLocalSolvedIds();
    localSolved.forEach(id => solvedIdSet.add(id));

    allProblems = (data.problems || []).map(p => {
      if (p.solved) solvedIdSet.add(Number(p.id));
      return {
        ...p,
        solved: Boolean(p.solved) || solvedIdSet.has(Number(p.id))
      };
    });

    // Update category badges from exact deduplicated catalog if /categories hasn't filled yet
    const allCountEl = document.getElementById("cat-count-All");
    if (allCountEl && allCountEl.textContent === "...") {
      allCountEl.textContent = allProblems.length.toLocaleString();
    }

    if (footerStatus) {
      footerStatus.textContent = `${allProblems.length.toLocaleString()} Catalog Bugs Loaded`;
    }

    renderActiveSessionCard();
    applyFiltersAndRender();
  } catch (err) {
    console.error("Failed to fetch problems:", err);
    if (footerStatus) footerStatus.textContent = "Backend unreachable";
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-12 text-center space-y-3">
            <div class="text-rose-400 font-mono">Could not load problems from ${escapeHtml(API)}</div>
            <div class="text-xs text-gray-500">Make sure your FastAPI server is running (or Render has finished waking up).</div>
            <button onclick="loadAllProblems()" class="px-4 py-1.5 bg-accent hover:bg-accent-hover text-black font-semibold rounded-lg text-xs cursor-pointer">
              Retry Connection
            </button>
          </td>
        </tr>
      `;
    }
  }
}

// --- 5. FILTERING, PROGRESS STATS & ACTIVE SESSION ---
function setDirCategory(cat) {
  activeCategory = cat;
  currentPage = 1;

  document.querySelectorAll(".dir-cat-pill").forEach(btn => {
    const isMatch = btn.getAttribute("data-cat") === cat;
    if (isMatch) {
      btn.className = "dir-cat-pill px-3 py-1.5 rounded-full font-semibold bg-accent text-black shrink-0 cursor-pointer transition";
    } else {
      btn.className = "dir-cat-pill px-3 py-1.5 rounded-full font-medium bg-surface-container border border-surface-border text-gray-300 hover:text-white shrink-0 cursor-pointer transition";
    }
  });

  applyFiltersAndRender();
}
window.setDirCategory = setDirCategory;

function handleDirFilterChange() {
  searchQuery = (document.getElementById("dir-search")?.value || "").trim().toLowerCase();
  activeDifficulty = document.getElementById("dir-difficulty")?.value || "All";
  activeStatus = document.getElementById("dir-status")?.value || "All";
  currentPage = 1;
  applyFiltersAndRender();
}
window.handleDirFilterChange = handleDirFilterChange;

function resetDirFilters() {
  const searchEl = document.getElementById("dir-search");
  const diffEl = document.getElementById("dir-difficulty");
  const statusEl = document.getElementById("dir-status");
  if (searchEl) searchEl.value = "";
  if (diffEl) diffEl.value = "All";
  if (statusEl) statusEl.value = "All";
  searchQuery = "";
  activeDifficulty = "All";
  activeStatus = "All";
  setDirCategory("All");
}
window.resetDirFilters = resetDirFilters;

function updateProficiencyCard(trackProblems) {
  const total = trackProblems.length;
  let easyTotal = 0, easySolved = 0;
  let medTotal = 0, medSolved = 0;
  let hardTotal = 0, hardSolved = 0;

  trackProblems.forEach(p => {
    const isSolved = p.solved || solvedIdSet.has(Number(p.id));
    const d = (p.difficulty || "").toLowerCase();
    if (d === "easy") {
      easyTotal++;
      if (isSolved) easySolved++;
    } else if (d === "hard") {
      hardTotal++;
      if (isSolved) hardSolved++;
    } else {
      medTotal++;
      if (isSolved) medSolved++;
    }
  });

  const totalSolved = easySolved + medSolved + hardSolved;
  const pct = total > 0 ? ((totalSolved / total) * 100).toFixed(1) : "0.0";

  document.getElementById("prog-track-label").textContent = activeCategory === "All" ? "ALL TRACKS" : activeCategory.toUpperCase();
  document.getElementById("prog-solved").textContent = totalSolved.toLocaleString();
  document.getElementById("prog-total").textContent = total.toLocaleString();
  document.getElementById("prog-pct").textContent = `${pct}%`;

  document.getElementById("bar-easy").style.width = total > 0 ? `${(easySolved / total) * 100}%` : "0%";
  document.getElementById("bar-med").style.width = total > 0 ? `${(medSolved / total) * 100}%` : "0%";
  document.getElementById("bar-hard").style.width = total > 0 ? `${(hardSolved / total) * 100}%` : "0%";

  document.getElementById("prog-easy").textContent = `Easy: ${easySolved}/${easyTotal}`;
  document.getElementById("prog-med").textContent = `Medium: ${medSolved}/${medTotal}`;
  document.getElementById("prog-hard").textContent = `Hard: ${hardSolved}/${hardTotal}`;
  document.getElementById("prog-remaining").textContent = `${(total - totalSolved).toLocaleString()} Remaining in Track`;
}

function renderActiveSessionCard() {
  const saved = getLastActiveProblem();
  const fallback = allProblems.find(p => !p.solved && !solvedIdSet.has(Number(p.id))) || allProblems[0];
  const target = saved && saved.id ? saved : fallback;
  if (!target) return;

  const diff = (target.difficulty || "Easy").toLowerCase();
  const diffEl = document.getElementById("active-diff");
  diffEl.textContent = (target.difficulty || "Easy").toUpperCase();
  diffEl.className = diff === "easy"
    ? "px-2 py-0.5 text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded uppercase"
    : diff === "hard"
      ? "px-2 py-0.5 text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded uppercase"
      : "px-2 py-0.5 text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded uppercase";

  document.getElementById("active-badge-text").textContent = saved ? "ACTIVE SESSION" : "NEXT RECOMMENDED";
  document.getElementById("active-updated").textContent = saved ? formatTimeAgo(saved.updatedAt) : "Ready to start";
  document.getElementById("active-meta").textContent = `#${target.id} • ${target.category || "General"}`;
  document.getElementById("active-title").textContent = target.title || `Problem #${target.id}`;
  document.getElementById("active-desc").textContent = target.description || target.description_preview || "Inspect the buggy implementation and patch all edge cases.";

  const resumeBtn = document.getElementById("active-resume-btn");
  resumeBtn.href = `index.html?id=${encodeURIComponent(target.id)}`;
  resumeBtn.textContent = saved ? `▶ Resume Problem #${target.id}` : `▶ Start Problem #${target.id}`;
}

function applyFiltersAndRender() {
  // Refresh solved flag from merged set
  allProblems.forEach(p => {
    p.solved = Boolean(p.solved) || solvedIdSet.has(Number(p.id));
  });

  const trackScoped = activeCategory === "All"
    ? allProblems
    : allProblems.filter(p => (p.category || "").toLowerCase() === activeCategory.toLowerCase());

  updateProficiencyCard(trackScoped);

  filteredProblems = trackScoped.filter(p => {
    if (activeDifficulty !== "All" && (p.difficulty || "").toLowerCase() !== activeDifficulty.toLowerCase()) {
      return false;
    }
    if (activeStatus === "Solved" && !p.solved) return false;
    if (activeStatus === "Todo" && p.solved) return false;

    if (searchQuery) {
      const cleanQ = searchQuery.replace(/^#/, "");
      const inId = String(p.id) === cleanQ;
      const inTitle = (p.title || "").toLowerCase().includes(searchQuery);
      const inCat = (p.category || "").toLowerCase().includes(searchQuery);
      const inTags = Array.isArray(p.tags) && p.tags.some(t => String(t).toLowerCase().includes(cleanQ));
      if (!inId && !inTitle && !inCat && !inTags) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredProblems.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;

  renderTablePage();
  renderPagination(totalPages);
}

// --- 6. TABLE & PAGINATION RENDERING ---
function renderTablePage() {
  const tbody = document.getElementById("directory-rows");
  const matchBadge = document.getElementById("table-match-badge");
  const rangeInfo = document.getElementById("page-range-info");

  if (matchBadge) {
    matchBadge.textContent = `${filteredProblems.length.toLocaleString()} problems`;
  }

  if (filteredProblems.length === 0) {
    if (rangeInfo) rangeInfo.textContent = "Showing 0 of 0 problems";
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-12 text-center text-gray-400">
          No challenges match your current filter.
          <button onclick="resetDirFilters()" class="text-emerald-400 hover:underline ml-1 cursor-pointer">Reset filters</button>
        </td>
      </tr>
    `;
    return;
  }

  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, filteredProblems.length);
  const pageItems = filteredProblems.slice(startIdx, endIdx);
  const lastActiveId = getLastActiveProblem()?.id;

  if (rangeInfo) {
    rangeInfo.textContent = `Showing ${startIdx + 1}–${endIdx} of ${filteredProblems.length.toLocaleString()} problems`;
  }

  tbody.innerHTML = pageItems.map(p => {
    const isActive = lastActiveId && Number(lastActiveId) === Number(p.id);
    const statusCell = p.solved
      ? `<span class="text-emerald-400 font-bold" title="Solved">✓</span>`
      : isActive
        ? `<span class="text-amber-400 font-bold" title="Active Session">✎</span>`
        : `<span class="text-gray-600" title="Todo">•</span>`;

    const diff = (p.difficulty || "Medium").toLowerCase();
    const diffBadge = diff === "easy"
      ? `<span class="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/10 text-emerald-400 rounded">Easy</span>`
      : diff === "hard"
        ? `<span class="px-2 py-0.5 text-[10px] font-bold bg-rose-500/10 text-rose-400 rounded">Hard</span>`
        : `<span class="px-2 py-0.5 text-[10px] font-bold bg-amber-500/10 text-amber-400 rounded">Medium</span>`;

    const tagsHtml = (Array.isArray(p.tags) ? p.tags.slice(0, 3) : []).map(tag => {
      const clean = String(tag).startsWith("#") ? tag : `#${tag}`;
      return `<span class="text-[10px] bg-surface-container border border-surface-border/70 px-1.5 py-0.5 rounded text-gray-400 font-mono">${escapeHtml(clean)}</span>`;
    }).join(" ");

    const assertsText = p.test_count > 0
      ? `${p.test_count} Assertion${p.test_count === 1 ? "" : "s"}`
      : "Sandbox Suite";

    const actionHtml = isActive && !p.solved
      ? `<a href="index.html?id=${p.id}" class="text-xs font-semibold text-amber-400 hover:text-amber-300 whitespace-nowrap">Resume →</a>`
      : p.solved
        ? `<a href="index.html?id=${p.id}" class="text-xs font-medium text-gray-400 hover:text-white whitespace-nowrap">Review</a>`
        : `<a href="index.html?id=${p.id}" class="px-2.5 py-1 text-xs font-semibold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 rounded transition whitespace-nowrap">Solve</a>`;

    const rowBg = isActive ? "bg-amber-500/[0.03]" : "";

    return `
      <tr class="hover:bg-surface-hover/60 transition ${rowBg}">
        <td class="py-3 px-4 text-center">${statusCell}</td>
        <td class="py-3 px-4">
          <div class="flex items-center gap-2 flex-wrap">
            <a href="index.html?id=${p.id}" class="font-medium text-white hover:text-emerald-400 transition">
              <span class="text-gray-500 font-mono mr-1">${p.id}.</span>${escapeHtml(p.title)}
            </a>
            ${tagsHtml}
          </div>
        </td>
        <td class="py-3 px-4 text-gray-400 font-mono text-[11px] whitespace-nowrap">${escapeHtml(p.category || "General")}</td>
        <td class="py-3 px-4 whitespace-nowrap">${diffBadge}</td>
        <td class="py-3 px-4 text-gray-400 font-mono text-[11px] whitespace-nowrap">${assertsText}</td>
        <td class="py-3 px-4 text-right">${actionHtml}</td>
      </tr>
    `;
  }).join("");
}

function renderPagination(totalPages) {
  const container = document.getElementById("pagination-controls");
  if (!container) return;

  const pages = [];
  const addPage = (p) => { if (!pages.includes(p)) pages.push(p); };

  addPage(1);
  for (let p = Math.max(2, currentPage - 1); p <= Math.min(totalPages - 1, currentPage + 1); p++) {
    addPage(p);
  }
  if (totalPages > 1) addPage(totalPages);

  let html = `
    <button onclick="goToPage(${currentPage - 1})" ${currentPage <= 1 ? "disabled" : ""}
      class="px-2 py-1 rounded border border-surface-border bg-surface hover:bg-surface-hover disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed">
      ‹
    </button>
  `;

  let prev = 0;
  pages.forEach(p => {
    if (prev && p - prev > 1) {
      html += `<span class="px-1.5 text-gray-600">…</span>`;
    }
    const activeClass = p === currentPage
      ? "bg-accent text-black font-bold border-accent"
      : "bg-surface text-gray-300 border-surface-border hover:bg-surface-hover";
    html += `
      <button onclick="goToPage(${p})" class="px-2.5 py-1 rounded border text-xs transition cursor-pointer ${activeClass}">
        ${p}
      </button>
    `;
    prev = p;
  });

  html += `
    <button onclick="goToPage(${currentPage + 1})" ${currentPage >= totalPages ? "disabled" : ""}
      class="px-2 py-1 rounded border border-surface-border bg-surface hover:bg-surface-hover disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed">
      ›
    </button>
  `;

  container.innerHTML = html;
}

function goToPage(page) {
  const totalPages = Math.max(1, Math.ceil(filteredProblems.length / pageSize));
  currentPage = Math.min(Math.max(1, page), totalPages);
  renderTablePage();
  renderPagination(totalPages);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
window.goToPage = goToPage;

function changePageSize(size) {
  pageSize = parseInt(size, 10) || 25;
  currentPage = 1;
  applyFiltersAndRender();
}
window.changePageSize = changePageSize;

function jumpToProblemNumber(event) {
  event.preventDefault();
  const input = document.getElementById("goto-problem-input");
  const id = parseInt(input?.value, 10);
  if (!Number.isFinite(id) || id < 1) return;

  const exists = allProblems.find(p => Number(p.id) === id);
  if (exists) {
    window.location.href = `index.html?id=${exists.id}`;
  } else {
    alert(`Problem #${id} was not found in the catalog.`);
  }
}
window.jumpToProblemNumber = jumpToProblemNumber;

function pickRandomProblem() {
  const pool = filteredProblems.length > 0 ? filteredProblems : allProblems;
  if (pool.length === 0) {
    window.location.href = "index.html";
    return;
  }
  const unsolved = pool.filter(p => !p.solved);
  const candidates = unsolved.length > 0 ? unsolved : pool;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  window.location.href = `index.html?id=${encodeURIComponent(pick.id)}`;
}
window.pickRandomProblem = pickRandomProblem;

// --- 7. BOOTSTRAP ---
async function initDirectory() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  dirSession = session || null;
  dirUser = session?.user || null;
  updateDirAuthUI(dirUser);

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    dirSession = session || null;
    dirUser = session?.user || null;
    updateDirAuthUI(dirUser);
    await syncDirUserStats();
    applyFiltersAndRender();
  });

  await Promise.all([
    loadCategories(),
    syncDirUserStats()
  ]);

  await loadAllProblems();
}

window.addEventListener("DOMContentLoaded", initDirectory);