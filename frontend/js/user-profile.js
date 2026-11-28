/**
 * LintIQ — user-profile.js
 * Read-only Codeforces-style Public Engineer Profile controller.
 * Fetches GET /api/users/{user_id}/public-profile and renders stats, difficulty/category
 * breakdown, 12-week rolling matrix, and searchable/paginated solved challenges.
 * Depends on: shared.js (API, supabaseClient, currentUser, currentSession, initAuth, escapeHtml, getInitials)
 */

const HEATMAP_PALETTE = [
  "#161b22",
  "#0e4429",
  "#006d32",
  "#26a641",
  "#39d353",
];

let dossierData = null;
let filteredChallenges = [];
let viewerSolvedIds = new Set();
let viewerRankInfo = null;
let upCurrentPage = 1;
const UP_PAGE_SIZE = 10;

function getHeatmapCellColor(count) {
  if (!count || count <= 0) return HEATMAP_PALETTE[0];
  if (count === 1) return HEATMAP_PALETTE[1];
  if (count === 2) return HEATMAP_PALETTE[2];
  if (count === 3) return HEATMAP_PALETTE[3];
  return HEATMAP_PALETTE[4];
}

function formatRelativeOrDate(rawTs) {
  if (!rawTs) return "Verified";
  const dt = new Date(rawTs);
  if (Number.isNaN(dt.getTime())) return String(rawTs).slice(0, 10);
  const diffSec = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatMemberSince(rawTs) {
  if (!rawTs) return "";
  const dt = new Date(rawTs);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function showProfileError(code, title, desc) {
  document.getElementById("up-loading")?.classList.add("hidden");
  document.getElementById("up-content")?.classList.add("hidden");
  const errEl = document.getElementById("up-error");
  if (errEl) errEl.classList.remove("hidden");
  const cEl = document.getElementById("up-error-code");
  const tEl = document.getElementById("up-error-title");
  const dEl = document.getElementById("up-error-desc");
  if (cEl) cEl.textContent = String(code || "404");
  if (tEl) tEl.textContent = title || "Engineer profile not found";
  if (dEl) dEl.textContent = desc || "No public dossier matches that user identifier.";
}

async function loadViewerContext() {
  viewerSolvedIds = new Set();
  viewerRankInfo = null;

  if (!currentUser?.id) return;

  // Local solved cache first
  try {
    const localMap = JSON.parse(localStorage.getItem(`lintiq_solved_map_${currentUser.id}`) || "{}") || {};
    Object.keys(localMap).forEach(k => {
      const n = Number(k);
      if (Number.isFinite(n)) viewerSolvedIds.add(n);
    });
  } catch (_) {}

  // Cloud solved IDs + viewer rank in parallel
  try {
    const tasks = [];
    if (currentSession?.access_token) {
      tasks.push(
        fetch(`${API}/profile/${encodeURIComponent(currentUser.id)}`, {
          headers: { Authorization: `Bearer ${currentSession.access_token}` },
        })
          .then(r => (r.ok ? r.json() : null))
          .then(prof => {
            if (prof && Array.isArray(prof.recent_solves)) {
              prof.recent_solves.forEach(s => {
                const n = Number(s.problem_id);
                if (Number.isFinite(n)) viewerSolvedIds.add(n);
              });
            }
          })
          .catch(() => {})
      );
    }

    tasks.push(
      supabaseClient
        .from("user_solves")
        .select("problem_id")
        .eq("user_id", currentUser.id)
        .then(({ data }) => {
          if (Array.isArray(data)) {
            data.forEach(r => {
              const n = Number(r.problem_id);
              if (Number.isFinite(n)) viewerSolvedIds.add(n);
            });
          }
        })
        .catch(() => {})
    );

    tasks.push(
      supabaseClient
        .from("user_profiles")
        .select("id,username,score")
        .order("score", { ascending: false })
        .limit(500)
        .then(({ data }) => {
          if (!Array.isArray(data)) return;
          const clean = data.filter(
            p => p.id && !String(p.id).startsWith("mock_") && !String(p.id).startsWith("test_")
          );
          const idx = clean.findIndex(p => p.id === currentUser.id);
          if (idx !== -1) {
            const vName = getDisplayUsername(currentUser);
            viewerRankInfo = {
              rank: idx + 1,
              initials: getInitials(vName),
              id: currentUser.id,
            };
          }
        })
        .catch(() => {})
    );

    await Promise.allSettled(tasks);
  } catch (_) {}
}

function renderHeroSection(profile) {
  const displayName = profile.display_name || "Engineer";
  const initials = profile.initials || getInitials(displayName);
  const rankNum = Number(profile.rank || 1);
  const scoreNum = Number(profile.score || 0);
  const currStreak = Number(profile.current_streak || 0);
  const bestStreak = Number(profile.best_streak || 0);
  const solvedCount = Number(profile.solved_count || 0);
  const totalProblems = Math.max(1, Number(profile.total_problems || 0));
  const pct = ((solvedCount / totalProblems) * 100).toFixed(1);

  document.title = `LintIQ – ${displayName} Public Profile`;

  const avatarEl = document.getElementById("up-avatar-box");
  const rankBadgeEl = document.getElementById("up-rank-badge");
  const nameEl = document.getElementById("up-display-name");
  const rankPillEl = document.getElementById("up-rank-pill");
  const metaRowEl = document.getElementById("up-meta-row");
  const deltaRowEl = document.getElementById("up-delta-row");

  if (avatarEl) avatarEl.textContent = initials;
  if (rankBadgeEl) rankBadgeEl.textContent = `#${rankNum}`;
  if (nameEl) nameEl.textContent = displayName;
  if (rankPillEl) {
    rankPillEl.textContent = `#${rankNum} Global · ${profile.tier || "Bug Hunter I"}`;
  }

  if (metaRowEl) {
    const metaParts = [];
    metaParts.push(`<span class="text-emerald-400">${escapeHtml(profile.tier || "Bug Hunter I")}</span>`);
    const memberLabel = formatMemberSince(profile.member_since);
    if (memberLabel) {
      metaParts.push(`<span class="text-gray-600">•</span><span>Active since ${escapeHtml(memberLabel)}</span>`);
    }
    if (profile.total_ranked) {
      metaParts.push(`<span class="text-gray-600">•</span><span>Top ${Math.max(1, Math.round((rankNum / Math.max(1, Number(profile.total_ranked))) * 100))}% of ${Number(profile.total_ranked).toLocaleString()} engineers</span>`);
    }
    metaRowEl.innerHTML = metaParts.join(" ");
  }

  if (deltaRowEl) {
    if (viewerRankInfo) {
      const targetUserParam = new URLSearchParams(window.location.search).get("user") || "";
      const isSelf = currentUser?.id && (viewerRankInfo.id === targetUserParam || displayName.toLowerCase() === getDisplayUsername(currentUser).toLowerCase());
      let deltaHtml = "";
      if (isSelf) {
        deltaHtml = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300 tabular-nums">Your Public Profile (#${rankNum})</span>`;
      } else {
        const diff = viewerRankInfo.rank - rankNum;
        if (diff > 0) {
          deltaHtml = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300 tabular-nums">${diff.toLocaleString()} ${diff === 1 ? "Rank" : "Ranks"} ahead of you (${escapeHtml(viewerRankInfo.initials)}: #${viewerRankInfo.rank.toLocaleString()})</span>`;
        } else if (diff < 0) {
          deltaHtml = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300 tabular-nums">You are ${Math.abs(diff).toLocaleString()} ${Math.abs(diff) === 1 ? "Rank" : "Ranks"} ahead (${escapeHtml(viewerRankInfo.initials)}: #${viewerRankInfo.rank.toLocaleString()})</span>`;
        } else {
          deltaHtml = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-sky-500/10 border border-sky-500/25 text-xs text-sky-300 tabular-nums">Tied with you (#${rankNum})</span>`;
        }
      }
      deltaRowEl.innerHTML = deltaHtml;
      deltaRowEl.classList.remove("hidden");
    } else {
      deltaRowEl.classList.add("hidden");
      deltaRowEl.innerHTML = "";
    }
  }

  const scoreEl = document.getElementById("up-stat-score");
  const tierEl = document.getElementById("up-stat-tier");
  const streakEl = document.getElementById("up-stat-streak");
  const streakUnitEl = document.getElementById("up-stat-streak-unit");
  const bestStreakEl = document.getElementById("up-stat-best-streak");
  const solvedEl = document.getElementById("up-stat-solved");
  const totalEl = document.getElementById("up-stat-total");
  const pctEl = document.getElementById("up-stat-pct");

  if (scoreEl) scoreEl.textContent = scoreNum.toLocaleString();
  if (tierEl) tierEl.textContent = profile.tier || "Bug Hunter I";
  if (streakEl) streakEl.textContent = String(currStreak);
  if (streakUnitEl) streakUnitEl.textContent = currStreak === 1 ? "day" : "days";
  if (bestStreakEl) bestStreakEl.textContent = `Best record: ${bestStreak} ${bestStreak === 1 ? "day" : "days"}`;
  if (solvedEl) solvedEl.textContent = solvedCount.toLocaleString();
  if (totalEl) totalEl.textContent = `/ ${Number(profile.total_problems || 0).toLocaleString()}`;
  if (pctEl) pctEl.textContent = `${pct}% catalog completion`;
}

function renderBreakdownSection(breakdown, solvedCount) {
  const diff = breakdown?.difficulty || {};
  const setBar = (tierKey, textId, barId) => {
    const entry = diff[tierKey] || { solved: 0, total: 0 };
    const solved = Number(entry.solved || 0);
    const total = Number(entry.total || 0);
    const pct = total > 0 ? Math.min(100, (solved / total) * 100) : 0;
    const txtEl = document.getElementById(textId);
    const barEl = document.getElementById(barId);
    if (txtEl) txtEl.textContent = `${solved} / ${total.toLocaleString()} (${pct.toFixed(1)}%)`;
    if (barEl) barEl.style.width = `${pct.toFixed(1)}%`;
  };

  const patchesBadge = document.getElementById("up-total-patches-badge");
  if (patchesBadge) patchesBadge.textContent = `${Number(solvedCount || 0).toLocaleString()} Patches Total`;

  setBar("Easy", "up-diff-easy-text", "up-diff-easy-bar");
  setBar("Medium", "up-diff-med-text", "up-diff-med-bar");
  setBar("Hard", "up-diff-hard-text", "up-diff-hard-bar");

  const pillsEl = document.getElementById("up-specialization-pills");
  if (pillsEl) {
    const cats = Array.isArray(breakdown?.categories) ? breakdown.categories : [];
    const tags = Array.isArray(breakdown?.tags) ? breakdown.tags : [];
    if (cats.length === 0 && tags.length === 0) {
      pillsEl.innerHTML = `<span class="text-xs text-gray-500">No verified bug fixes recorded yet.</span>`;
      return;
    }

    const catPills = cats.map(c =>
      `<span class="px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-zinc-200 flex items-center gap-1.5 tabular-nums">
        <span>${escapeHtml(c.name)}</span>
        <span class="text-emerald-400 font-semibold">${Number(c.count || 0)}</span>
      </span>`
    );
    const tagPills = tags.slice(0, 4).map(t =>
      `<span class="px-2 py-1 rounded-md bg-sky-500/10 border border-sky-500/20 text-sky-300 text-xs tabular-nums">
        ${escapeHtml(String(t.name || "").replace(/^#+/, ""))} <span class="opacity-75">${Number(t.count || 0)}</span>
      </span>`
    );
    pillsEl.innerHTML = catPills.concat(tagPills).join("");
  }
}

function renderRollingHeatmap(activity, profile) {
  const gridEl = document.getElementById("up-heatmap-grid");
  const momentumEl = document.getElementById("up-momentum-label");
  const summaryEl = document.getElementById("up-heatmap-summary");
  const bestEl = document.getElementById("up-matrix-best-streak");
  const velEl = document.getElementById("up-matrix-velocity");

  const days = Array.isArray(activity?.days) ? activity.days : [];
  const totalSolves = Number(activity?.total_solves || 0);
  const velocity = Number(activity?.velocity_per_week || 0);
  const bestStreak = Number(profile?.best_streak || 0);

  if (momentumEl) {
    momentumEl.textContent = totalSolves > 0
      ? `${totalSolves} ${totalSolves === 1 ? "solve" : "solves"} / 12w`
      : "No recent activity";
  }
  if (summaryEl) {
    summaryEl.textContent = `${totalSolves} ${totalSolves === 1 ? "patch" : "patches"} verified in last ${days.length || 84} days`;
  }
  if (bestEl) bestEl.textContent = `${bestStreak} ${bestStreak === 1 ? "day" : "days"}`;
  if (velEl) velEl.textContent = `${velocity.toFixed(1)} bugs/wk`;

  if (!gridEl) return;
  if (days.length === 0) {
    gridEl.innerHTML = `<div class="text-xs text-gray-500 font-mono py-4">No activity telemetry available.</div>`;
    return;
  }

  gridEl.innerHTML = days.map(day => {
    const cnt = Number(day.count || 0);
    const color = getHeatmapCellColor(cnt);
    const labelDt = new Date(`${day.date}T00:00:00`);
    const formatted = Number.isNaN(labelDt.getTime())
      ? String(day.date)
      : labelDt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `<button type="button" data-date-label="${escapeHtml(formatted)}" data-count="${cnt}"
      class="heatmap-cell w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-[3px] border border-white/5 transition-transform hover:scale-125 focus:outline-none"
      style="background-color: ${color};" aria-label="${cnt} bugs solved on ${escapeHtml(formatted)}"></button>`;
  }).join("");

  bindMatrixTooltip();
}

function bindMatrixTooltip() {
  const gridEl = document.getElementById("up-heatmap-grid");
  const tooltipEl = document.getElementById("heatmap-tooltip");
  if (!gridEl || !tooltipEl || gridEl.dataset.tooltipBound) return;
  gridEl.dataset.tooltipBound = "1";

  gridEl.addEventListener("mouseover", (e) => {
    const cell = e.target.closest(".heatmap-cell");
    if (!cell) return;
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
  });

  gridEl.addEventListener("mouseout", (e) => {
    if (e.target.closest(".heatmap-cell")) {
      tooltipEl.classList.add("hidden");
    }
  });
}

function populateCategoryFilter(challenges) {
  const selectEl = document.getElementById("up-cat-filter");
  if (!selectEl) return;
  const categories = Array.from(
    new Set((challenges || []).map(c => String(c.category || "").trim()).filter(Boolean))
  ).sort();
  selectEl.innerHTML = `<option value="All">All Categories</option>` +
    categories.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join("");
}

function handlePublicSolvedFilter() {
  upCurrentPage = 1;
  applySolvedFiltersAndRender();
}

function changePublicSolvedPage(page) {
  const totalPages = Math.max(1, Math.ceil(filteredChallenges.length / UP_PAGE_SIZE));
  upCurrentPage = Math.max(1, Math.min(totalPages, Number(page) || 1));
  renderSolvedTablePage();
}

function applySolvedFiltersAndRender() {
  const challenges = Array.isArray(dossierData?.solved_challenges) ? dossierData.solved_challenges : [];
  const searchVal = (document.getElementById("up-search")?.value || "").trim().toLowerCase();
  const diffVal = document.getElementById("up-diff-filter")?.value || "All";
  const catVal = document.getElementById("up-cat-filter")?.value || "All";

  filteredChallenges = challenges.filter(ch => {
    if (diffVal !== "All" && String(ch.difficulty || "").toLowerCase() !== diffVal.toLowerCase()) return false;
    if (catVal !== "All" && String(ch.category || "").toLowerCase() !== catVal.toLowerCase()) return false;
    if (searchVal) {
      const hay = `#${ch.id} ${ch.title || ""} ${ch.category || ""} ${ch.difficulty || ""}`.toLowerCase();
      if (!hay.includes(searchVal)) return false;
    }
    return true;
  });

  renderSolvedTablePage();
}

function renderSolvedTablePage() {
  const tbody = document.getElementById("up-solved-rows");
  const rangeEl = document.getElementById("up-page-range");
  const pagEl = document.getElementById("up-pagination");
  const countBadge = document.getElementById("up-solved-table-count");
  const statusHeader = document.getElementById("up-viewer-status-col");

  const allTotal = (dossierData?.solved_challenges || []).length;
  if (countBadge) countBadge.textContent = String(allTotal);
  if (statusHeader) {
    statusHeader.textContent = currentUser?.id
      ? `Your Status (${getInitials(getDisplayUsername(currentUser))})`
      : "Your Status";
  }

  const total = filteredChallenges.length;
  const totalPages = Math.max(1, Math.ceil(total / UP_PAGE_SIZE));
  if (upCurrentPage > totalPages) upCurrentPage = totalPages;

  if (!tbody) return;
  if (total === 0) {
    const emptyMsg = allTotal === 0
      ? "This engineer hasn't solved any verified challenges yet."
      : "No solved challenges match the active search or filter criteria.";
    tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-gray-400 font-mono">${escapeHtml(emptyMsg)}</td></tr>`;
    if (rangeEl) rangeEl.textContent = "Showing 0–0 of 0 solved verified challenges";
    if (pagEl) pagEl.innerHTML = "";
    return;
  }

  const startIdx = (upCurrentPage - 1) * UP_PAGE_SIZE;
  const endIdx = Math.min(total, startIdx + UP_PAGE_SIZE);
  const slice = filteredChallenges.slice(startIdx, endIdx);

  const diffClassMap = {
    "very easy": "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    easy: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    medium: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    hard: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  };

  tbody.innerHTML = slice.map(ch => {
    const pid = Number(ch.id);
    const diffNorm = String(ch.difficulty || "Medium");
    const diffStyle = diffClassMap[diffNorm.toLowerCase()] || diffClassMap.medium;
    const isViewerSolved = viewerSolvedIds.has(pid);
    const statusHtml = isViewerSolved
      ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 text-xs font-medium whitespace-nowrap">✓ Solved</span>`
      : `<a href="index.html?id=${encodeURIComponent(pid)}" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-zinc-100 text-xs font-medium transition whitespace-nowrap">Try Bug →</a>`;

    return `
      <tr class="hover:bg-white/[0.03] transition">
        <td class="py-3.5 px-4 tabular-nums text-zinc-400">${pid}</td>
        <td class="py-3.5 px-4">
          <a href="index.html?id=${encodeURIComponent(pid)}" class="font-medium text-zinc-100 hover:text-emerald-400 transition">
            ${escapeHtml(ch.title || `Challenge ${pid}`)}
          </a>
        </td>
        <td class="py-3.5 px-4">
          <span class="px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.07] text-xs text-sky-300 whitespace-nowrap">
            ${escapeHtml(ch.category || "General")}
          </span>
        </td>
        <td class="py-3.5 px-4">
          <span class="px-2 py-0.5 rounded border text-xs font-medium whitespace-nowrap ${diffStyle}">
            ${escapeHtml(diffNorm)}
          </span>
        </td>
        <td class="py-3.5 px-4 tabular-nums text-zinc-400 whitespace-nowrap">${escapeHtml(formatRelativeOrDate(ch.solved_at))}</td>
        <td class="py-3.5 px-4 text-right">${statusHtml}</td>
      </tr>
    `;
  }).join("");

  if (rangeEl) {
    rangeEl.textContent = `Showing ${startIdx + 1}–${endIdx} of ${total} solved verified challenges`;
  }

  if (pagEl) {
    if (totalPages <= 1) {
      pagEl.innerHTML = "";
      return;
    }
    const btns = [];
    btns.push(
      `<button type="button" onclick="changePublicSolvedPage(${upCurrentPage - 1})" ${upCurrentPage <= 1 ? "disabled" : ""} class="px-2.5 py-1 rounded bg-surface border border-surface-border text-gray-300 hover:text-white disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed">Previous</button>`
    );
    const maxButtons = 5;
    let pStart = Math.max(1, upCurrentPage - 2);
    let pEnd = Math.min(totalPages, pStart + maxButtons - 1);
    if (pEnd - pStart + 1 < maxButtons) pStart = Math.max(1, pEnd - maxButtons + 1);
    for (let p = pStart; p <= pEnd; p++) {
      const cls = p === upCurrentPage
        ? "bg-accent text-black font-bold border-accent"
        : "bg-surface border-surface-border text-gray-300 hover:text-white";
      btns.push(
        `<button type="button" onclick="changePublicSolvedPage(${p})" class="px-2.5 py-1 rounded border cursor-pointer ${cls}">${p}</button>`
      );
    }
    btns.push(
      `<button type="button" onclick="changePublicSolvedPage(${upCurrentPage + 1})" ${upCurrentPage >= totalPages ? "disabled" : ""} class="px-2.5 py-1 rounded bg-surface border border-surface-border text-gray-300 hover:text-white disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed">Next</button>`
    );
    pagEl.innerHTML = btns.join("");
  }
}

async function loadPublicUserDossier() {
  const params = new URLSearchParams(window.location.search);
  const userParam = (params.get("user") || "").trim();

  if (!userParam) {
    showProfileError(
      "404",
      "No engineer selected",
      "Choose an engineer from the Global Leaderboard to view their verified public telemetry."
    );
    return;
  }

  try {
    const res = await fetch(`${API}/api/users/${encodeURIComponent(userParam)}/public-profile`);
    if (res.status === 404) {
      showProfileError(
        "404",
        "Engineer profile not found",
        "We could not find a public LintIQ profile matching that user ID or handle."
      );
      return;
    }
    if (!res.ok) {
      showProfileError(
        String(res.status),
        "Unable to load public dossier",
        "The telemetry service is temporarily unavailable. Please return to the leaderboard and retry."
      );
      return;
    }

    const payload = await res.json();
    if (!payload || !payload.profile) {
      showProfileError("404", "Engineer profile not found", "Invalid telemetry payload received.");
      return;
    }

    dossierData = payload;
    await loadViewerContext();

    document.getElementById("up-loading")?.classList.add("hidden");
    document.getElementById("up-error")?.classList.add("hidden");
    document.getElementById("up-content")?.classList.remove("hidden");

    renderHeroSection(payload.profile);
    renderBreakdownSection(payload.breakdown, payload.profile.solved_count);
    renderRollingHeatmap(payload.activity, payload.profile);
    populateCategoryFilter(payload.solved_challenges || []);
    applySolvedFiltersAndRender();
  } catch (err) {
    console.warn("Public dossier load failed:", err);
    showProfileError(
      "503",
      "Telemetry connection error",
      "Could not reach the LintIQ backend right now. Please try again in a moment."
    );
  }
}

window.handlePublicSolvedFilter = handlePublicSolvedFilter;
window.changePublicSolvedPage = changePublicSolvedPage;

window.addEventListener("DOMContentLoaded", async () => {
  await initAuth();
  await loadPublicUserDossier();
  supabaseClient.auth.onAuthStateChange(async () => {
    if (dossierData) {
      await loadViewerContext();
      renderHeroSection(dossierData.profile);
      renderSolvedTablePage();
    }
  });
});
