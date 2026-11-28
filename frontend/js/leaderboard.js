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
          <div class="w-10 h-10 rounded-full bg-white/[0.06] border border-white/[0.12] flex items-center justify-center text-white font-semibold text-sm">
            ${escapeHtml(getInitials(myName))}
          </div>
          <div>
            <div class="text-xs font-medium text-zinc-400">Your Standing</div>
            <div class="text-sm font-semibold text-white">${escapeHtml(myName)} <span class="text-emerald-400 tabular-nums ml-1">${escapeHtml(myRank)}</span></div>
          </div>
        </div>
        <div class="flex items-center gap-6 text-xs tabular-nums">
          <div><span class="text-zinc-400 block text-xs">Score</span><span class="text-emerald-400 font-semibold">${Number(myScore).toLocaleString()} pts</span></div>
          <div><span class="text-zinc-400 block text-xs">Streak</span><span class="text-amber-400 font-semibold">⚡ ${Number(myStreak)}</span></div>
          <div><span class="text-zinc-400 block text-xs">Solved</span><span class="text-white font-semibold">${Number(mySolves)} bugs</span></div>
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
        <a href="${escapeHtml(profileHref)}" class="group bg-surface border border-white/[0.08] hover:border-white/20 rounded-xl p-6 flex flex-col justify-between gap-4 transition cursor-pointer">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold tabular-nums ${style.text}">${style.badge}</span>
            <div class="flex items-center gap-1.5">
              ${isMe ? '<span class="text-[11px] px-2 py-0.5 rounded bg-white/[0.08] text-zinc-200 font-medium">You</span>' : ''}
              <span class="text-xs text-zinc-500 group-hover:text-zinc-300 transition">View Profile →</span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 rounded-full bg-white/[0.05] border border-white/[0.1] flex items-center justify-center text-sm font-semibold text-zinc-100 transition shrink-0">
              ${escapeHtml(getInitials(name))}
            </div>
            <div class="min-w-0">
              <div class="text-base font-semibold tracking-[-0.01em] text-white group-hover:text-emerald-300 transition truncate">${escapeHtml(name)}</div>
              <div class="text-xs text-zinc-400 tabular-nums mt-0.5">${Number(player.streak || 0)} streak · ${Number(player.solves || 0)} solved</div>
            </div>
          </div>
          <div class="pt-3.5 border-t border-white/[0.07] flex items-center justify-between text-xs tabular-nums">
            <span class="text-zinc-400">Score</span>
            <span class="text-emerald-400 font-semibold text-sm">${Number(player.score || 0).toLocaleString()} pts</span>
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
      const rowBg = isMe ? "bg-white/[0.04] hover:bg-white/[0.06]" : "hover:bg-white/[0.03]";

      return `
        <tr data-href="${escapeHtml(profileHref)}" onclick="window.location.href=this.getAttribute('data-href')" class="${rowBg} transition cursor-pointer group">
          <td class="py-3.5 px-4 font-medium tabular-nums text-zinc-400">${rankBadge}</td>
          <td class="py-3.5 px-4">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-7 h-7 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center text-[11px] font-medium text-zinc-200 shrink-0 transition">
                ${escapeHtml(getInitials(name))}
              </span>
              <a href="${escapeHtml(profileHref)}" onclick="event.stopPropagation()" class="font-medium text-zinc-100 group-hover:text-white transition truncate">${escapeHtml(name)}</a>
              ${isMe ? '<span class="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.08] text-zinc-200 font-medium shrink-0">You</span>' : ''}
            </div>
          </td>
          <td class="py-3.5 px-4 text-right font-semibold tabular-nums text-emerald-400">${Number(player.score || 0).toLocaleString()}</td>
          <td class="py-3.5 px-4 text-center tabular-nums text-amber-400">${Number(player.streak || 0)}</td>
          <td class="py-3.5 px-4 text-right tabular-nums text-zinc-300">${Number(player.solves || 0)}</td>
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
