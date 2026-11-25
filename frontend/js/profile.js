/**
 * LintIQ — profile.js
 * Loads real user profile stats, 53x7 GitHub-style Debugging Activity Heatmap,
 * Recent Patch Activity Feed, and Chart.js telemetry/difficulty charts.
 * Depends on: shared.js (API, supabaseClient, currentUser, currentSession, initAuth, escapeHtml, getDisplayUsername, getInitials)
 */

let activityChartInstance = null;
let difficultyChartInstance = null;
let cachedSolveDates = [];
let selectedHeatmapYear = "last365";
let activeShareUsername = "";

const HEATMAP_COLORS = [
  "#161b22", // 0 solves
  "#0e4429", // 1 solve
  "#006d32", // 2 solves
  "#26a641", // 3 solves
  "#39d353", // 4+ solves
];

function toLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getHeatmapColor(count) {
  if (!count || count <= 0) return HEATMAP_COLORS[0];
  if (count === 1) return HEATMAP_COLORS[1];
  if (count === 2) return HEATMAP_COLORS[2];
  if (count === 3) return HEATMAP_COLORS[3];
  return HEATMAP_COLORS[4];
}

function buildLocalDayCounts(solveDates) {
  const counts = {};
  (solveDates || []).forEach(ts => {
    if (!ts) return;
    const dt = new Date(ts);
    if (Number.isNaN(dt.getTime())) return;
    const key = toLocalDateKey(dt);
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function computeLocalStreaks(dayCounts) {
  const activeKeys = Object.keys(dayCounts).filter(k => dayCounts[k] > 0).sort();
  const totalActiveDays = activeKeys.length;

  let maxStreak = 0;
  let run = 0;
  let prevMs = null;
  activeKeys.forEach(k => {
    const [y, m, d] = k.split("-").map(Number);
    const ms = new Date(y, m - 1, d).getTime();
    if (prevMs !== null && Math.round((ms - prevMs) / 86400000) === 1) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > maxStreak) maxStreak = run;
    prevMs = ms;
  });

  let currentStreak = 0;
  if (activeKeys.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    let cursor = dayCounts[toLocalDateKey(today)] > 0 ? today : yesterday;
    while (dayCounts[toLocalDateKey(cursor)] > 0) {
      currentStreak += 1;
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  return { totalActiveDays, currentStreak, maxStreak };
}

function populateHeatmapYearOptions(solveDates) {
  const selectEl = document.getElementById("heatmap-year-select");
  if (!selectEl) return;

  const currentYear = new Date().getFullYear();
  const years = new Set([currentYear, currentYear - 1]);
  (solveDates || []).forEach(ts => {
    const dt = new Date(ts);
    if (!Number.isNaN(dt.getTime())) years.add(dt.getFullYear());
  });

  const sortedYears = Array.from(years).sort((a, b) => b - a);
  const prevVal = selectedHeatmapYear;

  selectEl.innerHTML = `<option value="last365">Last 365 Days</option>` +
    sortedYears.map(y => `<option value="${y}">${y}</option>`).join("");

  if (prevVal && (prevVal === "last365" || sortedYears.includes(Number(prevVal)))) {
    selectEl.value = prevVal;
  } else {
    selectedHeatmapYear = "last365";
    selectEl.value = "last365";
  }
}

function renderActivityHeatmap(solveDates, yearSelection = "last365", backendStats = null) {
  const gridEl = document.getElementById("heatmap-grid");
  const monthsEl = document.getElementById("heatmap-months");
  const headlineEl = document.getElementById("heatmap-headline");
  const activeDaysEl = document.getElementById("heatmap-active-days");
  const maxStreakEl = document.getElementById("heatmap-max-streak");
  const currStreakEl = document.getElementById("heatmap-current-streak");
  if (!gridEl || !monthsEl) return;

  const dayCounts = buildLocalDayCounts(solveDates);
  const localStreaks = computeLocalStreaks(dayCounts);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let rangeStart;
  let rangeEnd;
  if (yearSelection === "last365") {
    rangeEnd = new Date(today);
    rangeStart = new Date(today);
    rangeStart.setDate(rangeEnd.getDate() - 364);
  } else {
    const yr = parseInt(yearSelection, 10) || today.getFullYear();
    rangeStart = new Date(yr, 0, 1);
    rangeEnd = new Date(yr, 11, 31);
  }

  // Align grid columns Sunday -> Saturday
  const gridStart = new Date(rangeStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());

  const gridEnd = new Date(rangeEnd);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const totalDaysInGrid = Math.round((gridEnd - gridStart) / 86400000) + 1;
  const totalWeeks = Math.ceil(totalDaysInGrid / 7);

  let rangeSolves = 0;
  let rangeActiveDays = 0;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthMarkers = new Array(totalWeeks).fill("");
  let lastLabeledCol = -3;

  const cellsHtml = [];
  const cursor = new Date(gridStart);

  for (let weekIdx = 0; weekIdx < totalWeeks; weekIdx++) {
    for (let dow = 0; dow < 7; dow++) {
      const inRange = cursor >= rangeStart && cursor <= rangeEnd;
      if (inRange) {
        const key = toLocalDateKey(cursor);
        const count = dayCounts[key] || 0;
        rangeSolves += count;
        if (count > 0) rangeActiveDays += 1;

        const isFirstOfMonth = cursor.getDate() === 1;
        const isFirstVisibleDay = cursor.getTime() === rangeStart.getTime();
        if ((isFirstOfMonth || isFirstVisibleDay) && weekIdx - lastLabeledCol >= 2) {
          monthMarkers[weekIdx] = monthNames[cursor.getMonth()];
          lastLabeledCol = weekIdx;
        }

        const formattedDate = cursor.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const color = getHeatmapColor(count);
        cellsHtml.push(
          `<button type="button" data-date-label="${escapeHtml(formattedDate)}" data-count="${count}" ` +
          `class="heatmap-cell w-[11px] h-[11px] sm:w-3 sm:h-3 rounded-[2px] border border-white/5 transition-transform hover:scale-125 focus:outline-none" ` +
          `style="background-color: ${color};" aria-label="${count} bugs solved on ${escapeHtml(formattedDate)}"></button>`
        );
      } else {
        cellsHtml.push(`<span class="w-[11px] h-[11px] sm:w-3 sm:h-3 inline-block"></span>`);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  monthsEl.innerHTML = monthMarkers
    .map(label => `<span class="w-[11px] sm:w-3 inline-block overflow-visible whitespace-nowrap">${label}</span>`)
    .join("");
  gridEl.innerHTML = cellsHtml.join("");

  const periodText = yearSelection === "last365" ? "in the last year" : `in ${yearSelection}`;
  if (headlineEl) {
    headlineEl.textContent = `${rangeSolves} ${rangeSolves === 1 ? "bug" : "bugs"} solved ${periodText}`;
  }

  const displayActiveDays = yearSelection === "last365"
    ? (solveDates.length > 0 ? Math.max(rangeActiveDays, localStreaks.totalActiveDays) : 0)
    : rangeActiveDays;
  const displayMaxStreak = solveDates.length > 0 || Number(backendStats?.max_streak || 0) > 0
    ? Math.max(localStreaks.maxStreak, Number(backendStats?.max_streak || 0))
    : 0;
  const displayCurrStreak = (backendStats && backendStats.current_streak !== undefined && backendStats.current_streak !== null)
    ? Number(backendStats.current_streak)
    : (solveDates.length > 0 ? localStreaks.currentStreak : 0);

  if (activeDaysEl) activeDaysEl.textContent = String(displayActiveDays);
  if (maxStreakEl) maxStreakEl.textContent = String(displayMaxStreak);
  if (currStreakEl) currStreakEl.textContent = String(displayCurrStreak);
}

function bindHeatmapTooltip() {
  const gridEl = document.getElementById("heatmap-grid");
  const tooltipEl = document.getElementById("heatmap-tooltip");
  if (!gridEl || !tooltipEl || gridEl.dataset.tooltipBound) return;
  gridEl.dataset.tooltipBound = "1";

  const showForCell = (cell) => {
    const count = parseInt(cell.getAttribute("data-count") || "0", 10);
    const dateLabel = cell.getAttribute("data-date-label") || "";
    tooltipEl.textContent = count > 0
      ? `${count} ${count === 1 ? "bug" : "bugs"} solved on ${dateLabel}`
      : `No bugs solved on ${dateLabel}`;
    tooltipEl.classList.remove("hidden");

    const rect = cell.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, rect.left + rect.width / 2 - tipRect.width / 2));
    const top = Math.max(8, rect.top - tipRect.height - 8);
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  };

  gridEl.addEventListener("mouseover", (e) => {
    const cell = e.target.closest(".heatmap-cell");
    if (cell) showForCell(cell);
  });
  gridEl.addEventListener("mouseout", (e) => {
    if (e.target.closest(".heatmap-cell")) {
      tooltipEl.classList.add("hidden");
    }
  });
}

function onHeatmapYearChange(val) {
  selectedHeatmapYear = val || "last365";
  renderActivityHeatmap(cachedSolveDates, selectedHeatmapYear);
}
window.onHeatmapYearChange = onHeatmapYearChange;

function renderActivityChart(solveDates) {
  const canvas = document.getElementById("prof-activity-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const dayCounts = buildLocalDayCounts(solveDates);
  const labels = [];
  const counts = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toLocalDateKey(d);
    labels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
    counts.push(Number(dayCounts[key] || 0));
  }

  if (activityChartInstance) activityChartInstance.destroy();
  activityChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Bugs Solved",
        data: counts,
        backgroundColor: "rgba(16, 185, 129, 0.55)",
        borderColor: "#10b981",
        borderWidth: 1.5,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#94a3b8", font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { stepSize: 1, color: "#94a3b8", font: { size: 11 } }, grid: { color: "rgba(148, 163, 184, 0.1)" } }
      }
    }
  });
}

function renderDifficultyChart(solvedIds, catalogMap) {
  const canvas = document.getElementById("prof-difficulty-chart");
  if (!canvas || typeof Chart === "undefined") return;

  const counts = { Easy: 0, Medium: 0, Hard: 0 };
  solvedIds.forEach(id => {
    const prob = catalogMap.get(Number(id));
    const diff = prob?.difficulty || "Medium";
    if (counts[diff] !== undefined) counts[diff]++;
    else counts.Medium++;
  });

  if (difficultyChartInstance) difficultyChartInstance.destroy();
  difficultyChartInstance = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["Easy", "Medium", "Hard"],
      datasets: [{
        data: [counts.Easy, counts.Medium, counts.Hard],
        backgroundColor: ["rgba(16, 185, 129, 0.75)", "rgba(245, 158, 11, 0.75)", "rgba(244, 63, 94, 0.75)"],
        borderColor: ["#10b981", "#f59e0b", "#f43f5e"],
        borderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#cbd5e1", font: { size: 11 }, boxWidth: 12 }
        }
      }
    }
  });
}

function renderRecentPatchesFeed(recentSolves, catalogMap, isSignedIn) {
  const patchesEl = document.getElementById("prof-recent-patches");
  if (!patchesEl) return;

  if (!Array.isArray(recentSolves) || recentSolves.length === 0) {
    const signInHint = !isSignedIn
      ? `<button type="button" onclick="openAuthModal()" class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-hover border border-surface-border text-gray-200 font-semibold transition cursor-pointer">Sign In</button>`
      : "";
    patchesEl.innerHTML = `
      <div class="py-10 px-4 text-center space-y-3 bg-surface-container/30 border border-surface-border/60 rounded-lg">
        <div class="text-sm font-semibold text-white">No verified patches submitted yet</div>
        <p class="text-xs text-gray-400 max-w-md mx-auto">Solve a bug in the Workspace to light up your activity heatmap and track your streak.</p>
        <div class="flex items-center justify-center gap-2 pt-1">
          ${signInHint}
          <a href="problem-directory.html" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-black font-semibold transition">
            <span>Solve Your First Bug →</span>
          </a>
        </div>
      </div>
    `;
    return;
  }

  patchesEl.innerHTML = recentSolves.map(row => {
    const pid = Number(row.problem_id);
    const prob = catalogMap.get(pid);
    const title = row.title || prob?.title || `Challenge #${pid}`;
    const diff = row.difficulty || prob?.difficulty || "";
    const cat = row.category || prob?.category || "";
    const diffClass = diff === "Easy"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
      : diff === "Hard"
        ? "bg-rose-500/10 text-rose-400 border-rose-500/25"
        : "bg-amber-500/10 text-amber-400 border-amber-500/25";

    const ts = row.solved_at || row.created_at;
    const when = ts
      ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";
    const gradeLabel = row.best_grade || row.patch_grade || "";
    const grade = gradeLabel
      ? `<span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono text-[10px]">${escapeHtml(gradeLabel)}</span>`
      : "";

    return `
      <a href="index.html?id=${encodeURIComponent(pid)}" class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-surface-container/60 border border-surface-border hover:border-emerald-500/40 transition">
        <div class="flex items-center gap-2.5 flex-wrap min-w-0">
          <span class="text-emerald-400 font-mono font-bold shrink-0">#${escapeHtml(pid)}</span>
          <span class="font-semibold text-white truncate">${escapeHtml(title)}</span>
          ${diff ? `<span class="text-[10px] font-mono px-1.5 py-0.5 rounded border ${diffClass}">${escapeHtml(diff)}</span>` : ""}
          ${cat ? `<span class="text-[10px] font-mono text-sky-400">${escapeHtml(cat)}</span>` : ""}
          ${grade}
        </div>
        <span class="text-[11px] text-gray-500 font-mono shrink-0">${escapeHtml(when)}</span>
      </a>
    `;
  }).join("");
}

function computeClientRankTier(scoreVal) {
  if (scoreVal >= 5000) return "Principal Auditor";
  if (scoreVal >= 2500) return "Staff Bug Hunter";
  if (scoreVal >= 1000) return "Bug Hunter III";
  if (scoreVal >= 300) return "Bug Hunter II";
  return "Bug Hunter I";
}

async function copyTextWithFallback(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

async function copyPublicProfileLink() {
  if (!activeShareUsername) return;
  const isLocal = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  const baseUrl = isLocal ? window.location.origin : "https://thelintiq.com";
  const url = `${baseUrl}/profile.html?u=${encodeURIComponent(activeShareUsername)}`;
  try {
    await copyTextWithFallback(url);
    if (typeof showToast === "function") showToast("Copied!", "success");
  } catch (_) {
    if (typeof showToast === "function") showToast("Could not copy link.", "error");
  }
}

async function copyGitHubBadgeMarkdown() {
  if (!activeShareUsername) return;
  const encodedUser = encodeURIComponent(activeShareUsername);
  const md = `[![LintIQ Profile](https://lintiq.onrender.com/badge/${encodedUser}.svg)](https://thelintiq.com/profile.html?u=${encodedUser})`;
  try {
    await copyTextWithFallback(md);
    if (typeof showToast === "function") showToast("Badge Markdown Copied!", "success");
  } catch (_) {
    if (typeof showToast === "function") showToast("Could not copy badge markdown.", "error");
  }
}

window.copyPublicProfileLink = copyPublicProfileLink;
window.copyGitHubBadgeMarkdown = copyGitHubBadgeMarkdown;

async function loadPublicProfileMode(publicUsername, catalogMap) {
  const notFoundEl = document.getElementById("prof-not-found");
  const contentWrapper = document.getElementById("prof-content-wrapper");
  const nameEl = document.getElementById("prof-name");
  const bioEl = document.getElementById("prof-bio");
  const avatarBox = document.getElementById("prof-avatar-box");
  const tierBadge = document.getElementById("prof-tier-badge");
  const publicBadge = document.getElementById("prof-public-badge");
  const shareActions = document.getElementById("prof-share-actions");
  const scoreEl = document.getElementById("prof-score");
  const solvesEl = document.getElementById("prof-solves");
  const streakEl = document.getElementById("prof-streak");
  const langEl = document.getElementById("prof-lang");
  const joinedEl = document.getElementById("prof-joined");

  shareActions?.classList.add("hidden");
  publicBadge?.classList.remove("hidden");

  try {
    const res = await fetch(`${API}/public-profile/${encodeURIComponent(publicUsername)}`);
    if (res.status === 404) {
      contentWrapper?.classList.add("hidden");
      notFoundEl?.classList.remove("hidden");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    notFoundEl?.classList.add("hidden");
    contentWrapper?.classList.remove("hidden");

    const uname = data.username || publicUsername;
    activeShareUsername = uname;
    document.title = `${uname} — LintIQ Public Profile`;

    if (nameEl) nameEl.textContent = uname;
    if (avatarBox) avatarBox.textContent = getInitials(uname);
    if (tierBadge) tierBadge.textContent = `★ ${data.tier || computeClientRankTier(data.score || 0)}`;
    if (bioEl) bioEl.textContent = `Public LintIQ Developer Profile • ${Number(data.total_active_days || 0)} active debugging days`;

    const unifiedStreak = Number(data.current_streak ?? data.streak ?? 0);
    if (scoreEl) scoreEl.textContent = Number(data.score || 0).toLocaleString();
    if (solvesEl) solvesEl.textContent = String(Number(data.solves || 0));
    if (streakEl) streakEl.textContent = String(unifiedStreak);
    if (langEl) langEl.textContent = "Python";
    if (joinedEl) joinedEl.textContent = "Public";

    cachedSolveDates = Array.isArray(data.solve_dates) ? data.solve_dates : [];
    const recentSolves = Array.isArray(data.recent_solves) ? data.recent_solves : [];
    const solvedIdSet = new Set(recentSolves.map(r => Number(r.problem_id)).filter(Number.isFinite));

    populateHeatmapYearOptions(cachedSolveDates);
    renderActivityHeatmap(cachedSolveDates, selectedHeatmapYear, {
      total_active_days: data.total_active_days || 0,
      current_streak: unifiedStreak,
      max_streak: data.max_streak || unifiedStreak,
    });
    renderActivityChart(cachedSolveDates);
    renderDifficultyChart(solvedIdSet, catalogMap);
    renderRecentPatchesFeed(recentSolves, catalogMap, true);
  } catch (err) {
    console.error("Failed to load public profile:", err);
    contentWrapper?.classList.add("hidden");
    notFoundEl?.classList.remove("hidden");
  }
}

async function loadProfilePage() {
  const notFoundEl = document.getElementById("prof-not-found");
  const contentWrapper = document.getElementById("prof-content-wrapper");
  const nameEl = document.getElementById("prof-name");
  const bioEl = document.getElementById("prof-bio");
  const avatarBox = document.getElementById("prof-avatar-box");
  const tierBadge = document.getElementById("prof-tier-badge");
  const publicBadge = document.getElementById("prof-public-badge");
  const shareActions = document.getElementById("prof-share-actions");
  const scoreEl = document.getElementById("prof-score");
  const solvesEl = document.getElementById("prof-solves");
  const streakEl = document.getElementById("prof-streak");
  const langEl = document.getElementById("prof-lang");
  const joinedEl = document.getElementById("prof-joined");
  const catalogTotalEl = document.getElementById("prof-catalog-total");

  bindHeatmapTooltip();

  // Load problem catalog metadata for titles & difficulty breakdown
  const catalogMap = new Map();
  try {
    const headers = {};
    if (currentSession?.access_token) {
      headers["Authorization"] = `Bearer ${currentSession.access_token}`;
    }
    const catRes = await fetch(`${API}/problems?category=All&difficulty=All&limit=5000`, { headers });
    if (catRes.ok) {
      const catData = await catRes.json();
      (catData.problems || []).forEach(p => catalogMap.set(Number(p.id), p));
      if (catalogTotalEl) catalogTotalEl.textContent = `${catalogMap.size.toLocaleString()} Challenges`;
    }
  } catch (err) {
    console.warn("Catalog lookup fallback:", err);
  }

  const rawPublicUsername = new URLSearchParams(window.location.search).get("u") || "";
  const publicUsername = rawPublicUsername.replace(/[\x00-\x1f\x7f<>\"'`;/\\]/g, "").trim().slice(0, 64);
  if (publicUsername) {
    await loadPublicProfileMode(publicUsername, catalogMap);
    return;
  }

  notFoundEl?.classList.add("hidden");
  contentWrapper?.classList.remove("hidden");
  publicBadge?.classList.add("hidden");

  const uid = currentUser?.id || "guest";
  let userSettingsProfile = {};
  try {
    userSettingsProfile = JSON.parse(localStorage.getItem(`lintiq_user_profile_${uid}`) || "{}") || {};
  } catch (_) {}

  let localProfile = {};
  try {
    localProfile = JSON.parse(localStorage.getItem("lintiq_profile_v1") || "{}") || {};
  } catch (_) {}
  localProfile = {
    displayName: userSettingsProfile.full_name || localProfile.displayName,
    bio: userSettingsProfile.bio || localProfile.bio,
  };

  let editorPrefs = {};
  try {
    editorPrefs = JSON.parse(localStorage.getItem("lintiq_editor_prefs_v1") || "{}") || {};
  } catch (_) {}

  let score = parseInt(localStorage.getItem("lintiq_score") || "0", 10);
  let streak = typeof getEffectiveLocalStreak === "function" ? getEffectiveLocalStreak() : 0;
  let solves = parseInt(localStorage.getItem("lintiq_solves") || "0", 10);

  const langMap = { python: "Python", cpp: "C++20", javascript: "JavaScript" };
  const activeLang = userSettingsProfile.language || editorPrefs.defaultLanguage;
  if (langEl) langEl.textContent = langMap[activeLang] || "Python";

  const solvedIdSet = new Set();
  try {
    const localSolvedMap = JSON.parse(localStorage.getItem(`lintiq_solved_map_${uid}`) || "{}") || {};
    Object.keys(localSolvedMap).forEach(k => {
      const n = Number(k);
      if (Number.isFinite(n)) solvedIdSet.add(n);
    });
  } catch (_) {}

  if (!currentUser) {
    activeShareUsername = "";
    shareActions?.classList.add("hidden");
    const guestName = localProfile.displayName || "Guest Engineer";
    if (nameEl) nameEl.textContent = guestName;
    if (avatarBox) avatarBox.textContent = getInitials(guestName);
    if (tierBadge) tierBadge.textContent = `★ ${computeClientRankTier(score)}`;
    if (bioEl) bioEl.textContent = localProfile.bio || "Sign in to sync your Arcade Score, streak, and solve history across devices.";
    if (scoreEl) scoreEl.textContent = score.toLocaleString();
    if (solvesEl) solvesEl.textContent = String(Math.max(solves, solvedIdSet.size));
    if (streakEl) streakEl.textContent = String(streak);
    if (joinedEl) joinedEl.textContent = "Local";

    cachedSolveDates = [];
    populateHeatmapYearOptions(cachedSolveDates);
    renderActivityHeatmap(cachedSolveDates, selectedHeatmapYear);
    renderActivityChart(cachedSolveDates);
    renderDifficultyChart(solvedIdSet, catalogMap);
    renderRecentPatchesFeed([], catalogMap, false);
    return;
  }

  const displayName = localProfile.displayName || getDisplayUsername(currentUser);
  activeShareUsername = getDisplayUsername(currentUser);
  shareActions?.classList.remove("hidden");
  if (nameEl) nameEl.textContent = displayName;
  if (avatarBox) avatarBox.textContent = getInitials(displayName);
  if (bioEl) bioEl.textContent = localProfile.bio || currentUser.email || "Verified LintIQ Bug Hunter";

  if (joinedEl && currentUser.created_at) {
    const dt = new Date(currentUser.created_at);
    joinedEl.textContent = dt.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  let recentSolves = [];
  let backendActivityStats = null;
  let hasAuthoritativeStreak = false;
  cachedSolveDates = [];

  try {
    // 1. Fetch authoritative profile + solve_dates + recent_solves from backend API
    if (currentSession?.access_token) {
      const res = await fetch(`${API}/profile/${encodeURIComponent(currentUser.id)}`, {
        headers: { Authorization: `Bearer ${currentSession.access_token}` }
      });
      if (res.ok) {
        const data = await res.json();
        score = Math.max(score, data.score || 0);
        streak = Number(data.current_streak ?? data.streak ?? 0);
        hasAuthoritativeStreak = true;
        solves = Math.max(solves, data.solves || 0);
        if (Array.isArray(data.solve_dates)) {
          cachedSolveDates = data.solve_dates;
        }
        if (Array.isArray(data.recent_solves)) {
          recentSolves = data.recent_solves;
        }
        backendActivityStats = {
          total_active_days: data.total_active_days || 0,
          current_streak: streak,
          max_streak: Math.max(data.max_streak || 0, streak),
        };
      }
    }

    // 2. Also query Supabase user_profiles for score/solves (never overwrite IST streak with stale value)
    const { data: supaProfile } = await supabaseClient
      .from("user_profiles")
      .select("score, streak, solves, tier")
      .eq("id", currentUser.id)
      .maybeSingle();

    if (supaProfile) {
      score = Math.max(score, supaProfile.score || 0);
      solves = Math.max(solves, supaProfile.solves || 0);
    }

    // 3. Fallback / supplement from direct Supabase user_solves (uses solved_at, best_grade, best_points)
    if (cachedSolveDates.length === 0 || recentSolves.length === 0) {
      const { data: supaSolves, error: solvesErr } = await supabaseClient
        .from("user_solves")
        .select("problem_id, best_points, best_grade, solved_at")
        .eq("user_id", currentUser.id)
        .order("solved_at", { ascending: false })
        .limit(1000);

      if (!solvesErr && Array.isArray(supaSolves)) {
        if (recentSolves.length === 0) {
          recentSolves = supaSolves.slice(0, 20);
        }
        if (cachedSolveDates.length === 0) {
          cachedSolveDates = supaSolves.map(r => r.solved_at).filter(Boolean);
        }
      }
    }

    if (!hasAuthoritativeStreak && typeof computeIstStreakFromSolveDates === "function") {
      const istFallback = computeIstStreakFromSolveDates(cachedSolveDates);
      streak = istFallback.currentStreak;
      backendActivityStats = {
        total_active_days: backendActivityStats?.total_active_days || 0,
        current_streak: streak,
        max_streak: Math.max(backendActivityStats?.max_streak || 0, istFallback.maxStreak, streak),
      };
    } else if (backendActivityStats) {
      backendActivityStats.current_streak = streak;
      backendActivityStats.max_streak = Math.max(backendActivityStats.max_streak || 0, streak);
    } else {
      backendActivityStats = { current_streak: streak, max_streak: streak };
    }

    recentSolves.forEach(r => {
      const n = Number(r.problem_id);
      if (Number.isFinite(n)) solvedIdSet.add(n);
    });
  } catch (err) {
    console.warn("Profile load fallback:", err);
  }

  populateHeatmapYearOptions(cachedSolveDates);
  renderActivityHeatmap(cachedSolveDates, selectedHeatmapYear, backendActivityStats);
  renderActivityChart(cachedSolveDates);
  renderDifficultyChart(solvedIdSet, catalogMap);
  renderRecentPatchesFeed(recentSolves, catalogMap, true);

  if (tierBadge) tierBadge.textContent = `★ ${computeClientRankTier(score)}`;
  if (scoreEl) scoreEl.textContent = score.toLocaleString();
  if (solvesEl) solvesEl.textContent = String(Math.max(solves, solvedIdSet.size));
  if (streakEl) streakEl.textContent = String(streak);
}

window.loadProfilePage = loadProfilePage;

window.addEventListener("DOMContentLoaded", async () => {
  await initAuth();
  await loadProfilePage();
  supabaseClient.auth.onAuthStateChange(() => {
    loadProfilePage();
  });
});
