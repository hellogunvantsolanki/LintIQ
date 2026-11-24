/**
 * LintIQ — navbar.js
 * Injects the shared top navigation bar + auth section into every page.
 *
 * Usage: Add <nav id="lintiq-navbar" data-page="workspace|directory|leaderboard|profile"></nav>
 *        in the <body>, then load this script. It reads data-page to highlight the active tab.
 *
 * Depends on: shared.js (API, supabaseClient, openAuthModal, logout, getDisplayUsername, getInitials)
 */
(function () {
  const navContainer = document.getElementById("lintiq-navbar");
  if (!navContainer) return;

  const page = navContainer.getAttribute("data-page") || "workspace";
  const settingsSubPage = document.body.getAttribute("data-settings-page") || "";

  function settingsItemClass(subKey) {
    const isActive = page === "settings" && settingsSubPage === subKey;
    return isActive
      ? "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/25 transition text-left"
      : "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left";
  }

  // Helper to build pill classes
  function pill(isActive) {
    return isActive
      ? "px-3 py-1 rounded-md font-semibold bg-accent text-black shadow-sm whitespace-nowrap shrink-0"
      : "px-3 py-1 rounded-md font-medium text-gray-300 hover:text-white hover:bg-surface-border transition whitespace-nowrap shrink-0";
  }

  function navActionClass(isActive) {
    return isActive
      ? "px-2.5 py-1 bg-accent text-black border border-accent font-semibold shadow-sm rounded-md flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
      : "px-2.5 py-1 bg-surface-container hover:bg-surface-hover border border-surface-border text-gray-300 hover:text-white font-medium rounded-md flex items-center gap-1.5 transition whitespace-nowrap shrink-0";
  }

  const settingsBtnClass = page === "settings"
    ? "p-1.5 sm:px-2.5 sm:py-1 bg-emerald-500/15 hover:bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 font-semibold rounded-md flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap shrink-0"
    : "p-1.5 sm:px-2.5 sm:py-1 bg-surface-container hover:bg-surface-hover border border-surface-border text-gray-300 hover:text-white rounded-md flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap shrink-0";

  // For workspace page, the brand links to problem-directory; for others, it links to directory too
  const brandHref = "problem-directory.html";

  if (!document.getElementById("lintiq-navbar-responsive-style")) {
    const navStyle = document.createElement("style");
    navStyle.id = "lintiq-navbar-responsive-style";
    navStyle.textContent = `
      #user-display-name {
        max-width: 110px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: inline-block;
      }
      #btn-signout {
        white-space: nowrap;
        flex-shrink: 0;
      }
      @media (max-width: 1440px) {
        #lintiq-top-header {
          padding-left: 0.6rem;
          padding-right: 0.6rem;
          gap: 0.3rem;
        }
        #lintiq-top-header .lintiq-nav-left,
        #lintiq-top-header .lintiq-nav-center,
        #lintiq-top-header .lintiq-nav-right,
        #lintiq-top-header nav {
          gap: 0.3rem;
        }
        #lintiq-top-header .lintiq-nav-pill,
        #lintiq-top-header .lintiq-nav-action {
          padding-left: 0.45rem;
          padding-right: 0.45rem;
          gap: 0.3rem;
        }
        #lintiq-top-header #lintiq-streak-pill,
        #lintiq-top-header #timer-hud,
        #lintiq-top-header #btn-hint,
        #lintiq-top-header #open-settings-btn {
          padding-left: 0.4rem;
          padding-right: 0.4rem;
        }
        #lintiq-top-header #btn-prev-problem,
        #lintiq-top-header #btn-next-problem {
          padding-left: 0.35rem;
          padding-right: 0.35rem;
        }
        #lintiq-top-header #btn-drawer-toggle {
          padding-left: 0.4rem;
          padding-right: 0.4rem;
          gap: 0.25rem;
        }
        #lintiq-top-header #auth-section {
          padding-left: 0.4rem;
          gap: 0.35rem;
        }
        #lintiq-top-header #user-profile {
          gap: 0.35rem;
        }
        #user-display-name {
          max-width: 88px;
        }
      }
    `;
    document.head.appendChild(navStyle);
  }

  navContainer.outerHTML = `
  <header id="lintiq-top-header" class="h-12 bg-surface border-b border-surface-border px-3 sm:px-4 flex items-center justify-between gap-2 shrink-0 ${page === 'workspace' ? 'relative z-40' : 'sticky top-0 z-40'} select-none">
    <!-- Left: Brand + Page Tabs -->
    <div class="lintiq-nav-left flex items-center gap-2 sm:gap-2.5 shrink-0">
      <a href="${brandHref}" class="flex items-center gap-2 text-white font-bold tracking-tight shrink-0" title="Back to Problem Directory">
        <span class="w-2.5 h-2.5 rounded-full bg-accent inline-block animate-pulse"></span>
        <span class="text-base sm:text-lg">Lint<span class="text-accent">IQ</span></span>
      </a>
      <span class="hidden ${page === 'workspace' ? '2xl' : 'lg'}:inline-block px-2 py-0.5 text-[10px] font-semibold bg-surface-border text-emerald-400 rounded-md tracking-wider font-mono shrink-0">
        ARCADE V1.6
      </span>

      <div class="flex items-center gap-1 ml-1 text-xs shrink-0">
        ${page === 'workspace' ? `
          <a href="problem-directory.html"
            class="lintiq-nav-pill px-2.5 py-1 rounded-md font-medium bg-surface-container hover:bg-surface-hover border border-surface-border hover:border-accent/50 text-gray-200 hover:text-emerald-400 transition flex items-center gap-1 whitespace-nowrap"
            title="Back to Full Problem List">
            <span>←</span><span class="hidden sm:inline">Problem List</span>
          </a>
          <a href="index.html" class="lintiq-nav-pill hidden md:inline-block ${pill(true)}">Workspace</a>
        ` : `
          <a href="problem-directory.html" class="lintiq-nav-pill ${pill(page === 'directory')}">Problem List</a>
          <a href="index.html" class="lintiq-nav-pill ${pill(false)}">Workspace</a>
        `}
      </div>

      ${page === 'workspace' ? `
        <!-- Segmented Prev / Problem Sequence Drawer / Next -->
        <div id="seq-nav-pill" class="bg-surface-container border border-surface-border rounded-lg flex items-center shrink-0 divide-x divide-surface-border overflow-hidden text-xs text-gray-300">
          <button id="btn-prev-problem" type="button" onclick="loadPrevProblem()"
            class="px-2 py-1 hover:bg-surface-hover hover:text-white transition cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-300"
            title="Previous Problem" aria-label="Previous Problem">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button id="btn-drawer-toggle" type="button" onclick="openProblemListDrawer()"
            class="px-2.5 py-1 hover:bg-surface-hover hover:text-emerald-400 transition flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            title="Quick Problem Switcher Drawer" aria-label="Open Problem Sequence Drawer">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span id="seq-progress" class="text-[11px] font-mono font-medium text-gray-200 whitespace-nowrap">0 / 0</span>
          </button>
          <button id="btn-next-problem" type="button" onclick="loadNextProblem()"
            class="px-2 py-1 hover:bg-surface-hover hover:text-white transition cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-300"
            title="Next Problem" aria-label="Next Problem">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      ` : ''}
    </div>

    ${page === 'workspace' ? `
      <!-- Center: Streak & Timer HUD (workspace only) -->
      <div class="lintiq-nav-center hidden lg:flex items-center gap-2 text-xs font-mono shrink-0">
        <div id="lintiq-streak-pill" class="flex items-center gap-1.5 bg-surface-container border border-surface-border px-2.5 py-1 rounded-md text-amber-400 font-medium whitespace-nowrap">
          <span>⚡ Streak:</span>
          <span id="streak-count" class="text-white font-bold">0</span>
        </div>
        <div id="timer-hud" class="flex items-center gap-1.5 bg-surface-container border border-surface-border px-2.5 py-1 rounded-md text-emerald-400 whitespace-nowrap">
          <span id="timer-display" class="font-bold">00:00</span>
          <span id="timer-status" class="text-[10px] uppercase tracking-wider text-gray-400">READY</span>
        </div>
      </div>
    ` : ''}

    <!-- Right: Nav Links, Streak (non-workspace), Actions & Auth -->
    <div class="lintiq-nav-right flex items-center gap-1.5 sm:gap-2 text-xs shrink-0">
      ${page === 'directory' ? `
        <div class="hidden sm:flex items-center gap-1.5 bg-surface-container border border-surface-border px-2.5 py-1 rounded-md text-amber-400 font-mono font-medium">
          <span>⚡ Streak:</span>
          <span id="dir-streak" class="text-white font-bold">0</span>
        </div>
      ` : ''}

      <nav class="hidden ${page === 'workspace' ? 'xl' : 'md'}:flex items-center gap-1.5 shrink-0">
        <a id="nav-leaderboard-link" href="leaderboard.html" class="lintiq-nav-action ${navActionClass(page === 'leaderboard')}">
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3" />
          </svg>
          <span>Leaderboard</span>
        </a>
        <a id="nav-profile-link" href="profile.html" class="lintiq-nav-action ${navActionClass(page === 'profile')}">
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM4 20a8 8 0 0116 0" />
          </svg>
          <span>Profile Stats</span>
        </a>
      </nav>

      ${page === 'workspace' ? `
        <button id="btn-hint" onclick="handleHintClick()"
          class="flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 text-amber-300 px-2.5 py-1 rounded-md hover:bg-amber-500/20 transition whitespace-nowrap cursor-pointer" title="Reveal AI Hint">
          <span>💡</span><span class="hidden sm:inline">AI Hint</span>
        </button>
      ` : ''}

      ${page === 'directory' ? `
        <a href="index.html?ai=1" class="flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-2.5 py-1 rounded-md hover:bg-emerald-500/20 transition font-medium whitespace-nowrap">
          <span>✨</span><span class="hidden sm:inline">Instant AI Bug</span>
        </a>
      ` : ''}

      <!-- Settings Floating Popover Dropdown (ALL PAGES) -->
      <div class="relative shrink-0" id="settings-dropdown-wrapper">
        <button id="open-settings-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="settings-popover-menu"
          class="${settingsBtnClass}"
          title="Settings & Control Center">
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317a1.724 1.724 0 013.35 0 1.724 1.724 0 002.573 1.066 1.724 1.724 0 012.37 2.37 1.724 1.724 0 001.065 2.572 1.724 1.724 0 010 3.35 1.724 1.724 0 00-1.066 2.573 1.724 1.724 0 01-2.37 2.37 1.724 1.724 0 00-2.572 1.065 1.724 1.724 0 01-3.35 0 1.724 1.724 0 00-2.573-1.066 1.724 1.724 0 01-2.37-2.37 1.724 1.724 0 00-1.065-2.572 1.724 1.724 0 010-3.35 1.724 1.724 0 001.066-2.573 1.724 1.724 0 012.37-2.37c.996.608 2.296.07 2.572-1.065z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span class="hidden sm:inline">Settings</span>
        </button>

        <div id="settings-popover-menu" role="menu"
          class="hidden absolute right-0 mt-2 w-56 bg-[#141822] border border-surface-border rounded-xl py-2 px-1.5 shadow-2xl shadow-black/80 z-50 select-none">
          <div class="${page === 'workspace' ? 'xl:hidden' : 'md:hidden'}">
            <a href="problem-directory.html" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-emerald-400 hover:bg-surface-hover transition text-left">
              <span>📋</span><span>Problem List</span>
            </a>
            <a href="leaderboard.html" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left">
              <span>🏆</span><span>Leaderboard</span>
            </a>
            <a href="profile.html" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left">
              <span>📈</span><span>Profile Stats</span>
            </a>
            <div class="my-1 border-t border-surface-border"></div>
          </div>

          <a href="settings-profile.html" class="${settingsItemClass('profile')}">
            <span>👤</span><span>Profile & Bio</span>
          </a>
          <a href="settings-editor.html" class="${settingsItemClass('editor')}">
            <span>🖥️</span><span>Editor Settings</span>
          </a>
          <a href="settings-dashboard.html" class="${settingsItemClass('dashboard')}">
            <span>📊</span><span>Dashboard & Graph</span>
          </a>
          <button type="button" onclick="if (typeof closeSettingsDropdown === 'function') closeSettingsDropdown(); if (typeof exportLintIQData === 'function') exportLintIQData();" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left cursor-pointer">
            <span>⬇</span><span>Export Stats (JSON)</span>
          </button>

          <div id="settings-logout-divider" class="hidden my-1.5 border-t border-surface-border"></div>
          <button id="settings-logout-btn" type="button" onclick="if (typeof closeSettingsDropdown === 'function') closeSettingsDropdown(); if (typeof logout === 'function') logout();"
            class="hidden w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 transition text-left cursor-pointer">
            <span>↪</span><span>Logout</span>
          </button>
        </div>
      </div>

      <!-- Auth Section (Dynamic Sign In / User Profile) -->
      <div id="auth-section" class="flex items-center gap-2 border-l border-surface-border pl-2 shrink-0">
        <button id="btn-login" onclick="openAuthModal()" class="px-3 py-1 bg-accent hover:bg-accent-hover text-black font-semibold text-xs rounded-md transition whitespace-nowrap cursor-pointer">
          Sign In
        </button>

        <div id="user-profile" class="hidden flex items-center gap-2 shrink-0 min-w-0">
          <a href="profile.html" class="flex items-center gap-1.5 hover:opacity-85 transition min-w-0" title="View Profile Stats">
            <span id="user-display-name" class="hidden sm:inline-block text-[11px] font-medium text-gray-200 max-w-[110px] truncate whitespace-nowrap overflow-hidden"></span>
            <span id="header-user-avatar" class="w-7 h-7 rounded-full bg-accent/20 border border-accent flex items-center justify-center text-accent text-[11px] font-bold shrink-0">LQ</span>
          </a>
          <button id="btn-signout" onclick="logout()" class="text-[11px] text-gray-400 hover:text-rose-400 transition whitespace-nowrap shrink-0 cursor-pointer" title="Sign Out">
            Sign Out
          </button>
        </div>
      </div>
    </div>
  </header>
  `;

  const settingsBtn = document.getElementById("open-settings-btn");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", (event) => {
      if (typeof window.toggleSettingsDropdown === "function") {
        window.toggleSettingsDropdown(event);
        return;
      }
      if (event) event.stopPropagation();
      const menu = document.getElementById("settings-popover-menu");
      if (!menu) return;
      const isOpen = !menu.classList.toggle("hidden");
      settingsBtn.setAttribute("aria-expanded", String(isOpen));
    });
  }
})();
