/**
 * LintIQ — settings-modal.js
 * Injects the full 3-tab Settings / Control Center modal (Profile, Editor, Analytics)
 * and the Leaderboard modal into workspace (index.html).
 *
 * Usage: Add <div id="lintiq-settings-modal"></div> in index.html <body>, then load this script.
 * Depends on: shared.js, workspace.js, Chart.js
 */
(function () {
  const slot = document.getElementById("lintiq-settings-modal");
  if (!slot) return;

  slot.outerHTML = `
  <!-- SETTINGS, EDITOR PREFERENCES & ANALYTICS MODAL -->
  <div id="settings-modal" class="hidden fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="bg-surface border border-white/[0.08] w-full max-w-4xl max-h-[90dvh] overflow-y-auto rounded-xl shadow-2xl relative flex flex-col">

      <div class="px-6 pt-4 bg-surface-dim border-b border-white/[0.07] shrink-0">
        <div class="flex items-center justify-between pb-3">
          <div class="flex items-center gap-2">
            <h2 id="settings-title" class="text-base font-semibold tracking-[-0.02em] text-white">Settings</h2>
          </div>
          <button onclick="closeSettingsModal()" class="text-zinc-400 hover:text-white text-sm px-2 py-1 rounded cursor-pointer">✕</button>
        </div>

        <div class="flex items-center gap-2 text-xs overflow-x-auto">
          <button onclick="switchSettingsTab('profile')" id="tab-btn-profile" class="settings-tab-btn px-3 py-2 border-b-2 border-emerald-500 text-white font-medium transition whitespace-nowrap cursor-pointer">
            Profile &amp; Bio
          </button>
          <button onclick="switchSettingsTab('editor')" id="tab-btn-editor" class="settings-tab-btn px-3 py-2 border-b-2 border-transparent text-zinc-400 hover:text-zinc-200 transition whitespace-nowrap cursor-pointer">
            Editor &amp; Sandbox
          </button>
          <button onclick="switchSettingsTab('analytics')" id="tab-btn-analytics" class="settings-tab-btn px-3 py-2 border-b-2 border-transparent text-zinc-400 hover:text-zinc-200 transition whitespace-nowrap cursor-pointer">
            Dashboard &amp; Graph
          </button>
        </div>
      </div>

      <!-- TAB 1: Profile -->
      <div id="settings-panel-profile" class="settings-tab-panel p-5 sm:p-6 grid grid-cols-1 md:grid-cols-12 gap-5 sm:gap-6">
        <div class="md:col-span-5 bg-surface-dim border border-surface-border rounded-xl p-5 flex flex-col justify-between min-w-0">
          <div>
            <div class="flex items-center gap-3 pb-4 mb-4 border-b border-surface-border">
              <div id="profile-initials" class="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-500 to-sky-600 flex items-center justify-center font-bold text-base text-white shrink-0">LQ</div>
              <div class="min-w-0">
                <div id="profile-display-name" class="text-base font-bold text-white truncate">Guest Engineer</div>
                <div id="profile-display-role" class="text-xs text-gray-400 truncate">LintIQ Bug Hunter</div>
                <div id="profile-display-github" class="text-[11px] font-mono text-emerald-400 mt-0.5 truncate"></div>
              </div>
            </div>
            <div class="space-y-2.5 text-xs font-mono">
              <div class="flex justify-between py-1.5 border-b border-surface-border/70 gap-2"><span class="text-gray-400">Primary Stack</span><span id="summary-lang" class="text-gray-200 truncate">Python 3.11</span></div>
              <div class="flex justify-between py-1.5 border-b border-surface-border/70 gap-2"><span class="text-gray-400">Location</span><span id="summary-location" class="text-gray-200 truncate">India</span></div>
              <div class="flex justify-between py-1.5 border-b border-surface-border/70 gap-2"><span class="text-gray-400">Rank Tier</span><span class="text-amber-400 font-semibold">Bug Hunter II</span></div>
              <div class="flex justify-between py-1.5 gap-2"><span class="text-gray-400">Sandbox Timeout</span><span class="text-sky-400">3.5s Cloud Container</span></div>
            </div>
          </div>
          <div class="mt-4 pt-3 border-t border-surface-border text-[11px] font-mono text-gray-500">
            Synced with LintIQ Account & Local Storage
          </div>
        </div>

        <div class="md:col-span-7 bg-surface-dim border border-surface-border rounded-xl p-5 min-w-0">
          <h3 class="text-xs font-mono uppercase tracking-wider text-gray-400 mb-4">Edit Personal Details</h3>
          <form id="profile-form" onsubmit="saveUserProfile(event)" class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div><label class="block text-[11px] font-mono text-gray-400 mb-1">Full Name</label><input type="text" id="input-fullname" placeholder="Your full name" required class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white focus:outline-none focus:border-accent" /></div>
            <div><label class="block text-[11px] font-mono text-gray-400 mb-1">GitHub Username</label><input type="text" id="input-github" placeholder="github-username" class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white focus:outline-none focus:border-accent" /></div>
            <div><label class="block text-[11px] font-mono text-gray-400 mb-1">Email Address</label><input type="email" id="input-email" placeholder="you@example.com" class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white focus:outline-none focus:border-accent" /></div>
            <div><label class="block text-[11px] font-mono text-gray-400 mb-1">Location / University</label><input type="text" id="input-location" placeholder="India" class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white focus:outline-none focus:border-accent" /></div>
            <div class="sm:col-span-2"><label class="block text-[11px] font-mono text-gray-400 mb-1">Headline / Bio</label><input type="text" id="input-bio" placeholder="Full-Stack Developer | Python & FastAPI" class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white focus:outline-none focus:border-accent" /></div>
            <div><label class="block text-[11px] font-mono text-gray-400 mb-1">Portfolio / LinkedIn URL</label><input type="url" id="input-website" placeholder="https://github.com/username" class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white focus:outline-none focus:border-accent" /></div>
            <div><label class="block text-[11px] font-mono text-gray-400 mb-1">Preferred Runtime</label><select id="input-lang" class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white font-mono focus:outline-none focus:border-accent"><option value="python" selected>Python 3.11</option><option value="javascript">JavaScript (Node.js)</option><option value="cpp">C++20</option></select></div>
            <div class="sm:col-span-2 pt-2 flex items-center justify-between gap-2">
              <button type="submit" class="px-4 py-2 bg-accent hover:bg-accent-hover text-black text-xs font-semibold rounded-lg transition cursor-pointer">Save Personal Profile</button>
              <span id="profile-save-status" class="text-xs font-mono text-emerald-400"></span>
            </div>
          </form>
        </div>
      </div>

      <!-- TAB 2: Editor Preferences -->
      <div id="settings-panel-editor" class="settings-tab-panel hidden p-5 sm:p-6 grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6">
        <div class="bg-surface-dim border border-surface-border rounded-xl p-5 space-y-4">
          <h3 class="text-xs font-mono uppercase tracking-wider text-gray-400">Monaco Editor Configuration</h3>
          <div><div class="flex justify-between text-xs font-mono mb-1"><span class="text-gray-300">Font Size</span><span id="editor-fontsize-val" class="text-emerald-400">14px</span></div><input type="range" id="pref-fontsize" min="12" max="20" value="14" oninput="applyEditorPrefs()" class="w-full accent-emerald-500 cursor-pointer" /></div>
          <div><label class="block text-xs font-mono text-gray-300 mb-1">Indentation Size (Python Standard: 4)</label><select id="pref-tabsize" onchange="applyEditorPrefs()" class="w-full px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white font-mono"><option value="4" selected>4 Spaces (Recommended)</option><option value="2">2 Spaces</option></select></div>
          <label class="flex items-center justify-between p-2.5 bg-surface border border-surface-border rounded-lg cursor-pointer"><span class="text-xs text-gray-200">Show Code Minimap</span><input type="checkbox" id="pref-minimap" onchange="applyEditorPrefs()" class="accent-emerald-500 w-4 h-4" /></label>
          <label class="flex items-center justify-between p-2.5 bg-surface border border-surface-border rounded-lg cursor-pointer"><span class="text-xs text-gray-200">Word Wrap Long Lines</span><input type="checkbox" id="pref-wordwrap" checked onchange="applyEditorPrefs()" class="accent-emerald-500 w-4 h-4" /></label>
        </div>
        <div class="bg-surface-dim border border-surface-border rounded-xl p-5 flex flex-col justify-between">
          <div class="space-y-4">
            <h3 class="text-xs font-mono uppercase tracking-wider text-gray-400">Arcade & Sandbox Behavior</h3>
            <label class="flex items-center justify-between p-2.5 bg-surface border border-surface-border rounded-lg cursor-pointer gap-2"><div><div class="text-xs font-semibold text-gray-200">Auto-Start Timer on Keystroke</div><div class="text-[11px] text-gray-400">Starts challenge stopwatch immediately when editing</div></div><input type="checkbox" id="pref-autotimer" checked onchange="applyEditorPrefs()" class="accent-emerald-500 w-4 h-4 shrink-0" /></label>
            <label class="flex items-center justify-between p-2.5 bg-surface border border-surface-border rounded-lg cursor-pointer gap-2"><div><div class="text-xs font-semibold text-gray-200">Show AST Safety Warnings</div><div class="text-[11px] text-gray-400">Highlight blocked imports before submitting</div></div><input type="checkbox" id="pref-astwarn" checked onchange="applyEditorPrefs()" class="accent-emerald-500 w-4 h-4 shrink-0" /></label>
            <div class="p-3 bg-surface border border-surface-border rounded-lg text-xs font-mono space-y-1">
              <div class="text-gray-400 text-[11px] uppercase">Keyboard Shortcuts</div>
              <div class="flex justify-between text-gray-300"><span>Safe Test Run</span><kbd class="px-1.5 py-0.5 bg-surface-border rounded text-[10px]">Ctrl + '</kbd></div>
              <div class="flex justify-between text-gray-300"><span>Submit Patch</span><kbd class="px-1.5 py-0.5 bg-surface-border rounded text-[10px]">Ctrl + Enter</kbd></div>
              <div class="flex justify-between text-gray-300"><span>Format Code</span><kbd class="px-1.5 py-0.5 bg-surface-border rounded text-[10px]">Shift + Alt + F</kbd></div>
            </div>
          </div>
          <div class="pt-3 flex justify-end"><span id="editor-pref-status" class="text-xs font-mono text-emerald-400">Preferences applied live</span></div>
        </div>
      </div>

      <!-- TAB 3: Analytics -->
      <div id="settings-panel-analytics" class="settings-tab-panel hidden p-5 sm:p-6">
        <div id="analytics-logged-out" class="hidden py-14 px-6 text-center bg-surface-dim border border-surface-border rounded-xl">
          <div class="text-3xl mb-3">🔒</div>
          <h3 class="text-base font-bold text-white mb-1">Sign in to view your Dashboard</h3>
          <p class="text-xs text-gray-400 max-w-md mx-auto mb-5">Your 7-day bug-hunt telemetry, pass rate, runtime latency, and personal streak history are tracked per account.</p>
          <button onclick="closeSettingsModal(); openAuthModal();" class="px-4 py-2 bg-accent hover:bg-accent-hover text-black text-xs font-semibold rounded-lg transition cursor-pointer">Sign In / Register</button>
        </div>
        <div id="analytics-auth-content" class="space-y-5">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="bg-surface-dim border border-surface-border rounded-lg p-3"><div class="text-[11px] font-mono text-gray-400">Patches Solved</div><div id="stat-patches" class="text-lg font-bold text-emerald-400 mt-0.5">0</div></div>
            <div class="bg-surface-dim border border-surface-border rounded-lg p-3"><div class="text-[11px] font-mono text-gray-400">Avg Runtime</div><div id="stat-runtime" class="text-lg font-bold text-sky-400 mt-0.5">0 ms</div></div>
            <div class="bg-surface-dim border border-surface-border rounded-lg p-3"><div class="text-[11px] font-mono text-gray-400">Pass Rate</div><div id="stat-accuracy" class="text-lg font-bold text-amber-400 mt-0.5">0%</div></div>
            <div class="bg-surface-dim border border-surface-border rounded-lg p-3"><div class="text-[11px] font-mono text-gray-400">Best Streak</div><div id="stat-best-streak" class="text-lg font-bold text-purple-400 mt-0.5">0</div></div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-12 gap-5">
            <div class="md:col-span-8 bg-surface-dim border border-surface-border rounded-xl p-4 min-w-0">
              <div class="flex items-center justify-between mb-2 gap-2"><h3 class="text-xs font-mono uppercase tracking-wider text-gray-400">7-Day Bug-Hunt & Latency Graph</h3><span class="text-[11px] font-mono text-emerald-400 whitespace-nowrap">● Live Telemetry</span></div>
              <div class="relative h-56 w-full"><canvas id="lintiq-activity-chart"></canvas></div>
            </div>
            <div class="md:col-span-4 bg-surface-dim border border-surface-border rounded-xl p-4 flex flex-col justify-between min-w-0">
              <div><h3 class="text-xs font-mono uppercase tracking-wider text-gray-400 mb-3">Account Telemetry</h3><p class="text-xs text-gray-400 leading-relaxed">Stats update automatically each time you submit a patch while signed in as <span id="analytics-account-name" class="text-emerald-400 font-mono"></span>.</p></div>
              <div class="pt-4 mt-4 border-t border-surface-border flex flex-col gap-2">
                <button onclick="exportLintIQData()" class="w-full py-1.5 bg-surface-container hover:bg-surface-hover border border-surface-border text-xs font-mono text-gray-200 rounded-lg transition cursor-pointer">⬇ Export Profile & Stats (JSON)</button>
                <button onclick="resetLintIQMetrics()" class="w-full py-1.5 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-xs font-mono text-rose-400 rounded-lg transition cursor-pointer">↺ Reset Local Telemetry</button>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- GLOBAL LEADERBOARD MODAL (Compat for workspace.js) -->
  <div id="leaderboard-modal" class="hidden fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
    <div class="bg-surface border border-surface-border w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-xl p-5 sm:p-6 shadow-2xl relative">
      <div class="flex items-center justify-between pb-4 border-b border-surface-border">
        <div class="flex items-center gap-2"><span class="text-xl">🏆</span><h3 class="text-lg font-bold text-white tracking-wide">Global Cloud Leaderboard</h3></div>
        <button onclick="closeLeaderboardModal()" class="text-gray-400 hover:text-white text-sm px-2 py-1 rounded cursor-pointer">✕</button>
      </div>
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-left text-xs font-mono">
          <thead><tr class="text-gray-400 border-b border-surface-border"><th class="py-2 px-3">#</th><th class="py-2 px-3">Engineer</th><th class="py-2 px-3 text-right">Score</th><th class="py-2 px-3 text-center">Streak</th><th class="py-2 px-3 text-right">Solves</th></tr></thead>
          <tbody id="leaderboard-rows" class="divide-y divide-surface-border/60"><tr><td colspan="5" class="py-6 text-center text-gray-400">Loading top bug hunters...</td></tr></tbody>
        </table>
      </div>
      <div class="mt-5 pt-3 border-t border-surface-border flex justify-between items-center text-[11px] text-gray-400 gap-2">
        <span id="leaderboard-sync-status">☁️ Permanent Cloud Leaderboard</span>
        <div class="flex items-center gap-3">
          <a href="leaderboard.html" class="text-gray-300 hover:text-white font-mono">Full Page ↗</a>
          <button onclick="fetchLeaderboard()" class="text-emerald-400 hover:underline font-mono cursor-pointer">Refresh</button>
        </div>
      </div>
    </div>
  </div>
  `;
})();
