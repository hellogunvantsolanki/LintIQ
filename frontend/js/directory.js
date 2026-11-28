// --- 1. DIRECTORY STATE (API, supabaseClient, auth & helpers provided by shared.js) ---
let allProblems = [];
let filteredProblems = [];
let solvedIdSet = new Set();
let dailyCountdownInterval = null;

let activeCategory = "All";
let activeDifficulty = "All";
let activeStatus = "All";
let searchQuery = "";
let currentPage = 1;
let pageSize = 25;
let hasPlayedInitialRowCascade = false;

// --- 2. UTILITIES ---
function getDirectoryMode() {
  if (typeof window.getActiveMode === "function") {
    return window.getActiveMode();
  }
  try {
    const urlMode = new URLSearchParams(window.location.search).get("mode");
    if (urlMode === "interview" || urlMode === "practice") {
      sessionStorage.setItem("lintiq_mode", urlMode);
      return urlMode;
    }
    const saved = sessionStorage.getItem("lintiq_mode");
    if (saved === "interview" || saved === "practice") return saved;
  } catch (_) {}
  return "practice";
}

function buildWorkspaceProblemUrl(problemId = null) {
  const mode = encodeURIComponent(getDirectoryMode());
  if (problemId !== null && problemId !== undefined && problemId !== "") {
    return `index.html?mode=${mode}&id=${encodeURIComponent(problemId)}`;
  }
  return `index.html?mode=${mode}`;
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
  const mode = getDirectoryMode();
  try {
    const scoped = localStorage.getItem(`lintiq_last_active_problem_${mode}`);
    if (scoped) return JSON.parse(scoped);
    if (mode === "practice") {
      return JSON.parse(
        localStorage.getItem("lintiq_last_active_problem") || "null",
      );
    }
  } catch (_) {}
  return null;
}

function getLocalSolvedIds() {
  const uid = currentUser?.id || "guest";
  const mode = getDirectoryMode();
  const ids = new Set();
  try {
    const map =
      JSON.parse(
        localStorage.getItem(`lintiq_solved_map_${mode}_${uid}`) || "{}",
      ) || {};
    Object.keys(map).forEach((k) => {
      const n = Number(k);
      if (Number.isFinite(n)) ids.add(n);
    });
  } catch (_) {}
  return ids;
}

// --- 3. USER STATS (Auth modals & navbar state handled by shared.js) ---
async function syncDirUserStats() {
  let streak =
    typeof getEffectiveLocalStreak === "function"
      ? getEffectiveLocalStreak()
      : 0;
  let score = parseInt(localStorage.getItem("lintiq_score") || "0", 10);
  let solves = parseInt(localStorage.getItem("lintiq_solves") || "0", 10);

  if (currentUser?.id) {
    let usedBackendProfile = false;
    try {
      if (currentSession?.access_token) {
        const res = await fetch(
          `${API}/profile/${encodeURIComponent(currentUser.id)}`,
          {
            headers: { Authorization: `Bearer ${currentSession.access_token}` },
          },
        );
        if (res.ok) {
          const backendProfile = await res.json();
          score = Math.max(score, backendProfile.score || 0);
          streak = Number(
            backendProfile.current_streak ?? backendProfile.streak ?? 0,
          );
          solves = Math.max(solves, backendProfile.solves || 0);
          usedBackendProfile = true;
        }
      }

      if (!usedBackendProfile) {
        const { data: profile } = await supabaseClient
          .from("user_profiles")
          .select("score, streak, solves")
          .eq("id", currentUser.id)
          .maybeSingle();

        if (profile) {
          score = Math.max(score, profile.score || 0);
          solves = Math.max(solves, profile.solves || 0);
        }
      }

      // Also pull cloud solved problem IDs & fallback IST streak if backend wasn't reached
      const { data: cloudSolves } = await supabaseClient
        .from("user_solves")
        .select("problem_id, solved_at")
        .eq("user_id", currentUser.id);

      if (Array.isArray(cloudSolves)) {
        if (getDirectoryMode() === "practice") {
          cloudSolves.forEach((row) => {
            const n = Number(row.problem_id);
            if (Number.isFinite(n)) solvedIdSet.add(n);
          });
        }
        if (
          !usedBackendProfile &&
          typeof computeIstStreakFromSolveDates === "function"
        ) {
          streak = computeIstStreakFromSolveDates(
            cloudSolves.map((r) => r.solved_at),
          ).currentStreak;
        }
      }
    } catch (err) {
      console.warn("Cloud stats read fallback:", err);
    }
  }

  const dirStreakEl = document.getElementById("dir-streak");
  if (dirStreakEl) dirStreakEl.textContent = streak;
  document.getElementById("stat-streak").textContent =
    `${streak} ${streak === 1 ? "Day" : "Days"}`;
  document.getElementById("stat-score").textContent =
    `${score.toLocaleString()} pts`;
  document.getElementById("stat-solves").textContent =
    `${Math.max(solves, solvedIdSet.size)} Bugs`;
}

// --- 4. FETCH CATEGORIES & FULL PROBLEM CATALOG ---
async function loadCategories() {
  const mode = getDirectoryMode();
  try {
    const res = await fetch(
      `${API}/categories?mode=${encodeURIComponent(mode)}`,
    );
    if (!res.ok) return;
    const data = await res.json();

    const allBadge = document.getElementById("cat-count-All");
    if (allBadge)
      allBadge.textContent = Number(data.total || 0).toLocaleString();

    (data.categories || []).forEach((c) => {
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
  const mode = getDirectoryMode();

  try {
    const headers = {};
    if (currentSession?.access_token) {
      headers["Authorization"] = `Bearer ${currentSession.access_token}`;
    }

    const res = await fetch(
      `${API}/problems?mode=${encodeURIComponent(mode)}&category=All&difficulty=All&limit=5000`,
      { headers },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const localSolved = getLocalSolvedIds();
    localSolved.forEach((id) => solvedIdSet.add(id));

    allProblems = (data.problems || []).map((p) => {
      if (p.solved) solvedIdSet.add(Number(p.id));
      return {
        ...p,
        solved: Boolean(p.solved) || solvedIdSet.has(Number(p.id)),
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

  document.querySelectorAll(".dir-cat-pill").forEach((btn) => {
    const isMatch = btn.getAttribute("data-cat") === cat;
    if (isMatch) {
      btn.className =
        "dir-cat-pill px-3 py-1.5 rounded-lg font-medium bg-white/[0.08] text-white border border-white/[0.1] shrink-0 cursor-pointer transition";
    } else {
      btn.className =
        "dir-cat-pill px-3 py-1.5 rounded-lg font-normal bg-transparent border border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] shrink-0 cursor-pointer transition";
    }
  });

  applyFiltersAndRender();
}
window.setDirCategory = setDirCategory;

function handleDirFilterChange() {
  searchQuery = (document.getElementById("dir-search")?.value || "")
    .trim()
    .toLowerCase();
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

function getDirDifficultyMeta(rawDiff) {
  const norm = String(rawDiff || "Medium").trim().toLowerCase();
  if (norm === "very easy") {
    return {
      label: "Very Easy",
      rank: 0,
      pillClass: "bg-cyan-500/10 text-cyan-300 border-cyan-500/20",
      tableBadgeClass: "bg-cyan-500/10 text-cyan-300",
    };
  }
  if (norm === "easy") {
    return {
      label: "Easy",
      rank: 1,
      pillClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
      tableBadgeClass: "bg-emerald-500/10 text-emerald-400",
    };
  }
  if (norm === "hard") {
    return {
      label: "Hard",
      rank: 3,
      pillClass: "bg-rose-500/10 text-rose-400 border-rose-500/20",
      tableBadgeClass: "bg-rose-500/10 text-rose-400",
    };
  }
  return {
    label: "Medium",
    rank: 2,
    pillClass: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    tableBadgeClass: "bg-amber-500/10 text-amber-400",
  };
}

function updateProficiencyCard(trackProblems) {
  const total = trackProblems.length;
  const isInterviewMode = getDirectoryMode() === "interview";
  let veryEasyTotal = 0,
    veryEasySolved = 0;
  let easyTotal = 0,
    easySolved = 0;
  let medTotal = 0,
    medSolved = 0;
  let hardTotal = 0,
    hardSolved = 0;

  trackProblems.forEach((p) => {
    const isSolved = p.solved || solvedIdSet.has(Number(p.id));
    const d = (p.difficulty || "").toLowerCase();
    if (d === "very easy") {
      veryEasyTotal++;
      if (isSolved) veryEasySolved++;
    } else if (d === "easy") {
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

  const totalSolved = veryEasySolved + easySolved + medSolved + hardSolved;
  const pct = total > 0 ? ((totalSolved / total) * 100).toFixed(1) : "0.0";

  document.getElementById("prog-track-label").textContent =
    activeCategory === "All" ? "ALL TRACKS" : activeCategory.toUpperCase();
  document.getElementById("prog-solved").textContent =
    totalSolved.toLocaleString();
  document.getElementById("prog-total").textContent = total.toLocaleString();
  document.getElementById("prog-pct").textContent = `${pct}%`;

  const showVeryEasy = !isInterviewMode;
  const veryEasyOpt = document.getElementById("dir-opt-very-easy");
  if (veryEasyOpt) veryEasyOpt.hidden = !showVeryEasy;
  const veryEasyWrap = document.getElementById("prog-very-easy-wrap");
  if (veryEasyWrap) veryEasyWrap.classList.toggle("hidden", !showVeryEasy);
  const barVeryEasy = document.getElementById("bar-very-easy");
  if (barVeryEasy) {
    barVeryEasy.classList.toggle("hidden", !showVeryEasy);
    barVeryEasy.style.width =
      total > 0 ? `${(veryEasySolved / total) * 100}%` : "0%";
  }
  const progVeryEasy = document.getElementById("prog-very-easy");
  if (progVeryEasy) {
    progVeryEasy.textContent = `Very Easy: ${veryEasySolved}/${veryEasyTotal}`;
  }

  document.getElementById("bar-easy").style.width =
    total > 0 ? `${(easySolved / total) * 100}%` : "0%";
  document.getElementById("bar-med").style.width =
    total > 0 ? `${(medSolved / total) * 100}%` : "0%";
  document.getElementById("bar-hard").style.width =
    total > 0 ? `${(hardSolved / total) * 100}%` : "0%";

  document.getElementById("prog-easy").textContent =
    `Easy: ${easySolved}/${easyTotal}`;
  document.getElementById("prog-med").textContent =
    `Medium: ${medSolved}/${medTotal}`;
  document.getElementById("prog-hard").textContent =
    `Hard: ${hardSolved}/${hardTotal}`;
  document.getElementById("prog-remaining").textContent =
    `${(total - totalSolved).toLocaleString()} Remaining in Track`;
}

function renderActiveSessionCard() {
  const saved = getLastActiveProblem();
  const fallback =
    allProblems.find((p) => !p.solved && !solvedIdSet.has(Number(p.id))) ||
    allProblems[0];
  const target = saved && saved.id ? saved : fallback;
  if (!target) return;

  const diffMeta = getDirDifficultyMeta(target.difficulty || "Easy");
  const diffEl = document.getElementById("active-diff");
  diffEl.textContent = diffMeta.label;
  diffEl.className = `px-2 py-0.5 text-[11px] font-medium border rounded ${diffMeta.pillClass}`;

  document.getElementById("active-badge-text").textContent = saved
    ? "ACTIVE SESSION"
    : "NEXT RECOMMENDED";
  document.getElementById("active-updated").textContent = saved
    ? formatTimeAgo(saved.updatedAt)
    : "Ready to start";
  document.getElementById("active-meta").textContent =
    `${target.id} • ${target.category || "General"}`;
  document.getElementById("active-title").textContent =
    target.title || `Problem ${target.id}`;
  document.getElementById("active-desc").textContent =
    target.description ||
    target.description_preview ||
    "Inspect the buggy implementation and patch all edge cases.";

  const resumeBtn = document.getElementById("active-resume-btn");
  resumeBtn.href = buildWorkspaceProblemUrl(target.id);
  resumeBtn.textContent = saved
    ? `▶ Resume Problem ${target.id}`
    : `▶ Start Problem ${target.id}`;
}

function applyFiltersAndRender() {
  // Refresh solved flag from merged set
  allProblems.forEach((p) => {
    p.solved = Boolean(p.solved) || solvedIdSet.has(Number(p.id));
  });

  const trackScoped =
    activeCategory === "All"
      ? allProblems
      : allProblems.filter(
          (p) =>
            (p.category || "").toLowerCase() === activeCategory.toLowerCase(),
        );

  updateProficiencyCard(trackScoped);

  filteredProblems = trackScoped.filter((p) => {
    if (
      activeDifficulty !== "All" &&
      (p.difficulty || "").toLowerCase() !== activeDifficulty.toLowerCase()
    ) {
      return false;
    }
    if (activeStatus === "Solved" && !p.solved) return false;
    if (activeStatus === "Todo" && p.solved) return false;

    if (searchQuery) {
      const cleanQ = searchQuery.replace(/^#/, "");
      const inId = String(p.id) === cleanQ;
      const inTitle = (p.title || "").toLowerCase().includes(searchQuery);
      const inCat = (p.category || "").toLowerCase().includes(searchQuery);
      const inTags =
        Array.isArray(p.tags) &&
        p.tags.some((t) => String(t).toLowerCase().includes(cleanQ));
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

  const shouldCascadeRows = !hasPlayedInitialRowCascade && pageItems.length > 0;
  if (shouldCascadeRows) {
    hasPlayedInitialRowCascade = true;
  }

  tbody.innerHTML = pageItems
    .map((p, idx) => {
      const isActive = lastActiveId && Number(lastActiveId) === Number(p.id);
      const statusCell = p.solved
        ? `<span class="text-emerald-400 font-medium" title="Solved">✓</span>`
        : isActive
          ? `<span class="text-amber-400 font-medium" title="Active Session">✎</span>`
          : `<span class="text-zinc-600" title="Todo">•</span>`;

      const diffMeta = getDirDifficultyMeta(p.difficulty || "Medium");
      const diffBadge = `<span class="inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-medium rounded whitespace-nowrap ${diffMeta.tableBadgeClass}">${escapeHtml(diffMeta.label)}</span>`;

      const tagsHtml = (Array.isArray(p.tags) ? p.tags.slice(0, 3) : [])
        .map((tag) => {
          const clean = String(tag).replace(/^#+/, "").trim();
          return `<span class="text-[11px] bg-white/[0.04] border border-white/[0.07] px-1.5 py-0.5 rounded text-zinc-400">${escapeHtml(clean)}</span>`;
        })
        .join(" ");

      const assertsText =
        p.test_count > 0
          ? `${p.test_count} Assertion${p.test_count === 1 ? "" : "s"}`
          : "Sandbox Suite";

      const pid = Number(p.id);
      const problemHref = buildWorkspaceProblemUrl(pid);
      const actionHtml =
        isActive && !p.solved
          ? `<a href="${problemHref}" class="inline-flex items-center justify-center text-xs font-medium text-amber-400 hover:text-amber-300 whitespace-nowrap">Resume →</a>`
          : p.solved
            ? `<a href="${problemHref}" class="inline-flex items-center justify-center text-xs font-medium text-zinc-400 hover:text-white whitespace-nowrap">Review</a>`
            : `<a href="${problemHref}" class="inline-flex items-center justify-center px-2.5 py-1 text-xs font-medium text-zinc-200 bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] rounded-md transition whitespace-nowrap">Solve</a>`;

      const rowBg = isActive ? "bg-amber-500/[0.03]" : "";
      const rowEnterClass = shouldCascadeRows && idx < 12 ? " dir-row-enter" : "";
      const rowEnterStyle =
        shouldCascadeRows && idx < 12
          ? ` style="animation-delay: ${idx * 25}ms;"`
          : "";

      return `
      <tr class="hover:bg-white/[0.03] transition ${rowBg}${rowEnterClass}"${rowEnterStyle}>
        <td class="py-3.5 pl-6 pr-3 w-20 text-center">${statusCell}</td>
        <td class="py-3.5 text-left pl-4 pr-4">
          <div class="flex items-center gap-2 flex-wrap">
            <a href="${problemHref}" class="inline-flex items-baseline gap-4 font-medium text-zinc-100 hover:text-emerald-400 transition">
              <span class="text-zinc-500 tabular-nums shrink-0">${pid}.</span><span>${escapeHtml(p.title)}</span>
            </a>
            ${tagsHtml}
          </div>
        </td>
        <td class="py-3.5 px-4 text-center text-zinc-400 text-xs whitespace-nowrap">${escapeHtml(p.category || "General")}</td>
        <td class="py-3.5 px-4 text-center whitespace-nowrap">${diffBadge}</td>
        <td class="py-3.5 px-4 text-center text-zinc-400 text-xs tabular-nums whitespace-nowrap">${assertsText}</td>
        <td class="py-3.5 pl-4 pr-6 text-center">${actionHtml}</td>
      </tr>
    `;
    })
    .join("");
}

function renderPagination(totalPages) {
  const container = document.getElementById("pagination-controls");
  if (!container) return;

  const pages = [];
  const addPage = (p) => {
    if (!pages.includes(p)) pages.push(p);
  };

  addPage(1);
  for (
    let p = Math.max(2, currentPage - 1);
    p <= Math.min(totalPages - 1, currentPage + 1);
    p++
  ) {
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
  pages.forEach((p) => {
    if (prev && p - prev > 1) {
      html += `<span class="px-1.5 text-gray-600">…</span>`;
    }
    const activeClass =
      p === currentPage
        ? "bg-white/[0.1] text-white font-medium border-white/[0.16]"
        : "bg-surface text-zinc-400 border-white/[0.08] hover:bg-white/[0.05] hover:text-white";
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

  const exists = allProblems.find((p) => Number(p.id) === id);
  if (exists) {
    window.location.href = buildWorkspaceProblemUrl(Number(exists.id));
  } else {
    showToast(`Problem #${id} was not found in the catalog.`, "warn");
  }
}
window.jumpToProblemNumber = jumpToProblemNumber;

function pickRandomProblem() {
  const pool = filteredProblems.length > 0 ? filteredProblems : allProblems;
  if (pool.length === 0) {
    window.location.href = buildWorkspaceProblemUrl();
    return;
  }
  const unsolved = pool.filter((p) => !p.solved);
  const candidates = unsolved.length > 0 ? unsolved : pool;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  window.location.href = buildWorkspaceProblemUrl(pick.id);
}
window.pickRandomProblem = pickRandomProblem;

// --- 7. BUG OF THE DAY BANNER & COUNTDOWN ---
function stopDailyCountdown() {
  if (dailyCountdownInterval !== null) {
    clearInterval(dailyCountdownInterval);
    dailyCountdownInterval = null;
  }
}

function startDailyCountdown(resetsAt) {
  stopDailyCountdown();
  const countdownEl = document.getElementById("daily-bug-countdown");
  if (!countdownEl || !resetsAt) return;

  const targetMs = new Date(resetsAt).getTime();
  if (Number.isNaN(targetMs)) return;

  countdownEl.title = "Resets daily at 12:00 AM IST (UTC+05:30)";

  let refreshed = false;
  const tick = () => {
    const diffSec = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
    if (diffSec <= 0) {
      countdownEl.textContent = "Resetting...";
      stopDailyCountdown();
      if (!refreshed) {
        refreshed = true;
        setTimeout(() => loadDailyChallenge(), 1200);
      }
      return;
    }
    const hrs = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;
    countdownEl.textContent = `Resets in ${hrs}h ${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s (IST)`;
  };

  tick();
  dailyCountdownInterval = setInterval(tick, 1000);
}

async function loadDailyChallenge() {
  const banner = document.getElementById("daily-bug-banner");
  if (!banner) return;
  const mode = getDirectoryMode();

  try {
    const headers = {};
    if (currentSession?.access_token) {
      headers["Authorization"] = `Bearer ${currentSession.access_token}`;
    }
    const res = await fetch(
      `${API}/daily-challenge?mode=${encodeURIComponent(mode)}`,
      { headers },
    );
    if (!res.ok) return;
    const rawText = await res.text();
    const data = rawText ? JSON.parse(rawText) : null;
    if (!data || !data.problem) {
      banner.classList.add("hidden");
      return;
    }

    const prob = data.problem;
    const pid = Number(prob.id);
    const problemHref = buildWorkspaceProblemUrl(pid);
    const titleLink = document.getElementById("daily-bug-title-link");
    const diffEl = document.getElementById("daily-bug-diff");
    const catEl = document.getElementById("daily-bug-category");
    const actionEl = document.getElementById("daily-bug-action");

    if (titleLink) {
      titleLink.href = problemHref;
      titleLink.innerHTML = `<span class="text-amber-300 tabular-nums mr-1.5">${escapeHtml(pid)}.</span>${escapeHtml(prob.title || "Daily Challenge")}`;
    }

    const dailyDiffMeta = getDirDifficultyMeta(prob.difficulty || "Hard");
    if (diffEl) {
      diffEl.textContent = dailyDiffMeta.label;
      diffEl.className = `px-2 py-0.5 text-xs font-medium rounded border ${dailyDiffMeta.pillClass}`;
    }

    if (catEl) {
      catEl.textContent = prob.category || "General";
    }

    const dailyDateKey = data.date_ist || data.date_utc;
    const localDone = dailyDateKey
      ? localStorage.getItem(`lintiq_daily_done_${mode}_${dailyDateKey}`) ===
        String(pid)
      : false;
    const isCompletedToday = Boolean(data.completed_today) || localDone;

    if (actionEl) {
      if (isCompletedToday) {
        actionEl.innerHTML = `
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-xs font-medium whitespace-nowrap">✓ Completed Today</span>
            <a href="${problemHref}" class="px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-xs text-zinc-200 hover:text-white transition whitespace-nowrap">Review →</a>
          </div>
        `;
      } else {
        actionEl.innerHTML = `
          <a id="daily-bug-cta" href="${problemHref}" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.1] text-white text-xs font-medium transition whitespace-nowrap">Solve Daily Bug →</a>
        `;
      }
    }

    banner.classList.remove("hidden");
    startDailyCountdown(data.resets_at_utc || data.resets_at);
  } catch (err) {
    console.warn("Could not load daily challenge banner:", err);
  }
}

// --- 8. BOOTSTRAP ---
async function initDirectory() {
  await initAuth();

  supabaseClient.auth.onAuthStateChange(async () => {
    await Promise.all([syncDirUserStats(), loadDailyChallenge()]);
    applyFiltersAndRender();
  });

  await Promise.all([
    loadCategories(),
    syncDirUserStats(),
    loadDailyChallenge(),
  ]);

  await loadAllProblems();
}

window.addEventListener("beforeunload", stopDailyCountdown);
window.addEventListener("pagehide", stopDailyCountdown);
window.addEventListener("DOMContentLoaded", initDirectory);
