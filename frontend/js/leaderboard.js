/**
 * LintIQ — leaderboard.js
 * Fetches real global leaderboard rankings from Supabase user_profiles / backend API.
 * Depends on: shared.js (API, supabaseClient, currentUser, initAuth, escapeHtml, getInitials)
 */

async function loadLeaderboardPage() {
  const seasonInfo = document.getElementById("lb-season-info");
  const podiumEl = document.getElementById("lb-podium");
  const rowsEl = document.getElementById("lb-full-rows");
  const userRankBar = document.getElementById("lb-user-rank-bar");
  const refreshBtn = document.getElementById("lb-refresh-btn");

  if (refreshBtn) refreshBtn.textContent = "Refreshing...";
  if (seasonInfo) seasonInfo.textContent = "Syncing live rankings from LintIQ Arcade cloud...";

  let leaders = [];
  let fetchFailed = false;

  try {
    const { data: cloudLeaders, error } = await supabaseClient
      .from("user_profiles")
      .select("id, username, score, streak, solves")
      .order("score", { ascending: false })
      .limit(50);

    if (!error && Array.isArray(cloudLeaders) && cloudLeaders.length > 0) {
      leaders = cloudLeaders.filter(
        p => p.id && !String(p.id).startsWith("mock_") && !String(p.id).startsWith("test_")
      );
    }
    if (leaders.length === 0) {
      const res = await fetch(`${API}/leaderboard`);
      if (res.ok) {
        const data = await res.json();
        leaders = Array.isArray(data) ? data : (data.leaderboard || []);
      } else if (error) {
        fetchFailed = true;
      }
    }
  } catch (err) {
    fetchFailed = true;
    console.warn("Leaderboard fetch fallback:", err);
  }

  if (refreshBtn) refreshBtn.textContent = "Refresh";

  if (fetchFailed && leaders.length === 0) {
    if (seasonInfo) seasonInfo.textContent = "Could not reach leaderboard service. Check your connection and click Refresh.";
    if (podiumEl) {
      podiumEl.innerHTML = `<div class="md:col-span-3 py-10 text-center text-rose-400 font-mono bg-surface border border-rose-500/30 rounded-xl">Unable to load leaderboard right now. Click Refresh to retry.</div>`;
    }
    if (rowsEl) {
      rowsEl.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-rose-400 font-mono">Leaderboard request failed.</td></tr>`;
    }
    return;
  }

  if (!leaders || leaders.length === 0) {
    if (seasonInfo) seasonInfo.textContent = "No ranked engineers found yet. Solve a bug in the Workspace to claim #1!";
    if (podiumEl) {
      podiumEl.innerHTML = `<div class="md:col-span-3 py-10 text-center text-gray-400 font-mono bg-surface border border-surface-border rounded-xl">No leaderboard entries yet.</div>`;
    }
    if (rowsEl) {
      rowsEl.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-gray-400 font-mono">No rankings available yet.</td></tr>`;
    }
    return;
  }

  if (seasonInfo) {
    seasonInfo.textContent = `Showing top ${leaders.length} verified bug hunters ranked by Arcade Score.`;
  }

  // Render Logged-in User Rank Bar
  if (userRankBar) {
    if (currentUser?.id) {
      const myIdx = leaders.findIndex(p => p.id === currentUser.id);
      const myName = getDisplayUsername(currentUser);
      const myRank = myIdx !== -1 ? `#${myIdx + 1}` : "Unranked (Top 50+)";
      const myScore = myIdx !== -1 ? (leaders[myIdx].score || 0) : parseInt(localStorage.getItem("lintiq_score") || "0", 10);
      const myStreak = myIdx !== -1 ? (leaders[myIdx].streak || 0) : parseInt(localStorage.getItem("lintiq_streak") || "0", 10);
      const mySolves = myIdx !== -1 ? (leaders[myIdx].solves || 0) : parseInt(localStorage.getItem("lintiq_solves") || "0", 10);

      userRankBar.classList.remove("hidden");
      userRankBar.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-accent/20 border border-accent flex items-center justify-center text-accent font-bold text-sm font-mono">
            ${escapeHtml(getInitials(myName))}
          </div>
          <div>
            <div class="text-[10px] uppercase font-mono tracking-wider text-emerald-400">Your Standing</div>
            <div class="text-sm font-bold text-white">${escapeHtml(myName)} <span class="text-emerald-400 font-mono ml-1">${escapeHtml(myRank)}</span></div>
          </div>
        </div>
        <div class="flex items-center gap-6 text-xs font-mono">
          <div><span class="text-gray-500 block text-[10px]">SCORE</span><span class="text-emerald-400 font-bold">${Number(myScore).toLocaleString()} pts</span></div>
          <div><span class="text-gray-500 block text-[10px]">STREAK</span><span class="text-amber-400 font-bold">⚡ ${Number(myStreak)}</span></div>
          <div><span class="text-gray-500 block text-[10px]">SOLVED</span><span class="text-white font-bold">${Number(mySolves)} bugs</span></div>
        </div>
      `;
    } else {
      userRankBar.classList.add("hidden");
    }
  }

  // Render Top 3 Podium
  if (podiumEl) {
    const podiumColors = [
      { badge: "🥇 #1", border: "border-amber-400/50", glow: "shadow-amber-500/10", text: "text-amber-300" },
      { badge: "🥈 #2", border: "border-slate-300/40", glow: "shadow-slate-400/10", text: "text-slate-200" },
      { badge: "🥉 #3", border: "border-amber-700/50", glow: "shadow-amber-700/10", text: "text-amber-500" }
    ];

    podiumEl.innerHTML = leaders.slice(0, 3).map((player, idx) => {
      const style = podiumColors[idx];
      const name = player.username || "Engineer";
      const profileKey = player.id || name;
      const safeUserParam = encodeURIComponent(profileKey).replace(/'/g, "%27");
      const profileHref = `user-profile.html?user=${safeUserParam}`;
      const isMe = currentUser?.id && player.id === currentUser.id;
      return `
        <a href="${escapeHtml(profileHref)}" class="group bg-surface border ${style.border} hover:border-emerald-400/60 hover:-translate-y-0.5 rounded-xl p-5 shadow-xl ${style.glow} flex flex-col justify-between gap-3 transition cursor-pointer">
          <div class="flex items-center justify-between">
            <span class="text-xs font-mono font-bold ${style.text}">${style.badge}</span>
            <div class="flex items-center gap-1.5">
              ${isMe ? '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono uppercase">You</span>' : ''}
              <span class="text-[10px] font-mono text-gray-500 group-hover:text-emerald-400 transition">View Profile →</span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 rounded-full bg-surface-container border border-surface-border group-hover:border-emerald-500/50 flex items-center justify-center text-sm font-bold text-white font-mono transition shrink-0">
              ${escapeHtml(getInitials(name))}
            </div>
            <div class="min-w-0">
              <div class="text-base font-bold text-white group-hover:text-emerald-300 transition truncate">${escapeHtml(name)}</div>
              <div class="text-[11px] text-gray-400 font-mono">⚡ ${Number(player.streak || 0)} streak • ${Number(player.solves || 0)} solved</div>
            </div>
          </div>
          <div class="pt-3 border-t border-surface-border flex items-center justify-between text-xs font-mono">
            <span class="text-gray-500">ARCADE SCORE</span>
            <span class="text-emerald-400 font-bold text-sm">${Number(player.score || 0).toLocaleString()} pts</span>
          </div>
        </a>
      `;
    }).join("");
  }

  // Render Full Rankings Table
  if (rowsEl) {
    rowsEl.innerHTML = leaders.map((player, idx) => {
      const rank = idx + 1;
      const name = player.username || "Engineer";
      const profileKey = player.id || name;
      const safeUserParam = encodeURIComponent(profileKey).replace(/'/g, "%27");
      const profileHref = `user-profile.html?user=${safeUserParam}`;
      const isMe = currentUser?.id && player.id === currentUser.id;
      const rankBadge = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
      const rowBg = isMe ? "bg-emerald-500/10 hover:bg-emerald-500/15" : "hover:bg-surface-hover/70";

      return `
        <tr data-href="${escapeHtml(profileHref)}" onclick="window.location.href=this.getAttribute('data-href')" class="${rowBg} transition cursor-pointer group">
          <td class="py-3 px-4 font-mono font-bold text-gray-300">${rankBadge}</td>
          <td class="py-3 px-4">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-7 h-7 rounded-full bg-surface-container border border-surface-border group-hover:border-emerald-500/50 flex items-center justify-center text-[10px] font-bold text-gray-200 font-mono shrink-0 transition">
                ${escapeHtml(getInitials(name))}
              </span>
              <a href="${escapeHtml(profileHref)}" onclick="event.stopPropagation()" class="font-semibold text-white group-hover:text-emerald-300 transition truncate">${escapeHtml(name)}</a>
              ${isMe ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono uppercase shrink-0">You</span>' : ''}
            </div>
          </td>
          <td class="py-3 px-4 text-right font-mono font-bold text-emerald-400">${Number(player.score || 0).toLocaleString()}</td>
          <td class="py-3 px-4 text-center font-mono text-amber-400">⚡ ${Number(player.streak || 0)}</td>
          <td class="py-3 px-4 text-right font-mono text-gray-300">${Number(player.solves || 0)}</td>
        </tr>
      `;
    }).join("");
  }
}

window.loadLeaderboardPage = loadLeaderboardPage;

window.addEventListener("DOMContentLoaded", async () => {
  await initAuth();
  await loadLeaderboardPage();
  supabaseClient.auth.onAuthStateChange(() => {
    loadLeaderboardPage();
  });
});
