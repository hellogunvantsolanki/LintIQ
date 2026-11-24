/**
 * LintIQ — problem-drawer.js
 * Injects the slide-over Problem Sequence Drawer into the workspace (index.html).
 *
 * Usage: Add <div id="lintiq-problem-drawer"></div> in index.html <body>, then load this script.
 * Depends on: workspace.js (closeProblemListDrawer, filterDrawerList, selectCategory, selectDifficulty, jumpToProblemById)
 */
(function () {
  const slot = document.getElementById("lintiq-problem-drawer");
  if (!slot) return;

  slot.outerHTML = `
  <!-- Hidden fallback container so workspace.js inline sequence updates never error -->
  <div id="problem-sequence-list" class="hidden"></div>

  <!-- SLIDE-OVER PROBLEM SEQUENCE DRAWER -->
  <div id="problem-list-drawer" class="hidden fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Problem Sequence Drawer">
    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeProblemListDrawer()"></div>
    <aside class="relative ml-auto w-full max-w-md h-full bg-[#0d1117] border-l border-surface-border flex flex-col shadow-2xl">
      <!-- Drawer Header -->
      <div class="px-5 py-4 border-b border-surface-border bg-surface flex items-center justify-between gap-3 shrink-0">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-sm font-bold text-white">
            <svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span>Problem Sequence</span>
          </div>
          <span id="drawer-count" class="block text-[11px] font-mono text-gray-400 mt-0.5">Loading...</span>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <a href="problem-directory.html" class="text-[11px] font-mono text-emerald-400 hover:underline whitespace-nowrap">Full List →</a>
          <button type="button" onclick="closeProblemListDrawer()" class="text-gray-400 hover:text-white text-base px-2 py-0.5 rounded hover:bg-surface-hover transition cursor-pointer" aria-label="Close Drawer">✕</button>
        </div>
      </div>

      <!-- Track Filter Pills & Search / Difficulty Bar -->
      <div class="px-4 py-3 border-b border-surface-border/70 bg-surface-container/50 space-y-2.5 shrink-0">
        <div id="category-bar" class="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button type="button" onclick="selectCategory('All')" data-cat="All" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-semibold transition bg-emerald-500 text-black whitespace-nowrap shrink-0 cursor-pointer">All Tracks</button>
          <button type="button" onclick="selectCategory('Algorithms')" data-cat="Algorithms" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-surface-container border border-surface-border text-gray-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer">Algorithms</button>
          <button type="button" onclick="selectCategory('Data Structures')" data-cat="Data Structures" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-surface-container border border-surface-border text-gray-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer">Data Structures</button>
          <button type="button" onclick="selectCategory('Off-by-One')" data-cat="Off-by-One" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-surface-container border border-surface-border text-gray-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer">Off-by-One</button>
          <button type="button" onclick="selectCategory('Edge Cases')" data-cat="Edge Cases" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-surface-container border border-surface-border text-gray-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer">Edge Cases</button>
          <button type="button" onclick="selectCategory('Type Coercion')" data-cat="Type Coercion" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-surface-container border border-surface-border text-gray-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer">Type Coercion</button>
          <button type="button" onclick="selectCategory('Memory & State')" data-cat="Memory & State" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-surface-container border border-surface-border text-gray-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer">Memory & State</button>
          <button type="button" onclick="selectCategory('Concurrency')" data-cat="Concurrency" class="cat-pill px-2.5 py-1 rounded-full text-[11px] font-medium transition bg-surface-container border border-surface-border text-gray-300 hover:text-white whitespace-nowrap shrink-0 cursor-pointer">Concurrency</button>
        </div>

        <div class="flex items-center gap-2">
          <input id="drawer-search-input" type="text" placeholder="Search by title, number, or ID..." oninput="filterDrawerList(this.value)" class="flex-1 px-3 py-1.5 bg-surface border border-surface-border rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none focus:border-accent font-mono" />
          <select id="difficulty-select" onchange="selectDifficulty(this.value)" class="bg-surface border border-surface-border text-gray-200 text-xs rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:border-accent cursor-pointer">
            <option value="All">All</option>
            <option value="Easy">Easy</option>
            <option value="Medium">Medium</option>
            <option value="Hard">Hard</option>
          </select>
        </div>
      </div>

      <!-- Scrollable Problem List -->
      <div id="problem-sequence-rows" class="flex-1 overflow-y-auto divide-y divide-surface-border/50">
        <!-- Populated by workspace.js -->
      </div>
    </aside>
  </div>
  `;
})();
