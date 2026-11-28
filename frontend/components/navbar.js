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
  const settingsSubPage =
    document.body.getAttribute("data-settings-page") || "";

  function settingsItemClass(subKey) {
    const isActive = page === "settings" && settingsSubPage === subKey;
    return isActive
      ? "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-white bg-white/[0.08] border border-white/[0.1] transition text-left"
      : "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-zinc-300 hover:bg-white/[0.05] hover:text-white transition text-left";
  }

  // Subtle Linear/Vercel pill & borderless link styles (reserve bright green strictly for primary CTAs)
  function pill(isActive) {
    return isActive
      ? "px-2.5 py-1 rounded-md text-[13px] font-medium bg-white/[0.08] text-white border border-white/[0.1] whitespace-nowrap shrink-0"
      : "px-2.5 py-1 rounded-md text-[13px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] transition whitespace-nowrap shrink-0";
  }

  function navActionClass(isActive) {
    return isActive
      ? "px-2.5 py-1 rounded-md text-[13px] font-medium bg-white/[0.08] text-white border border-white/[0.1] flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
      : "px-2.5 py-1 rounded-md text-[13px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] flex items-center gap-1.5 transition whitespace-nowrap shrink-0";
  }

  const settingsBtnClass =
    page === "settings"
      ? "p-1.5 sm:px-2.5 sm:py-1 rounded-md text-[13px] font-medium bg-white/[0.08] text-white border border-white/[0.1] flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap shrink-0"
      : "p-1.5 sm:px-2.5 sm:py-1 rounded-md text-[13px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] flex items-center gap-1.5 transition cursor-pointer whitespace-nowrap shrink-0";

  // Clicking the LintIQ logo always returns to mode-selector.html so users can switch modes anytime
  const brandHref = "mode-selector.html";
  const activeMode =
    typeof getActiveMode === "function"
      ? getActiveMode()
      : (() => {
          try {
            const p = new URLSearchParams(window.location.search).get("mode");
            if (p === "practice" || p === "interview") {
              sessionStorage.setItem("lintiq_mode", p);
              return p;
            }
            const s = sessionStorage.getItem("lintiq_mode");
            if (s === "practice" || s === "interview") return s;
          } catch (_) {}
          return "practice";
        })();
  const encodedMode = encodeURIComponent(activeMode);
  const directoryHref = `problem-directory.html?mode=${encodedMode}`;
  const workspaceHref = `index.html?mode=${encodedMode}`;

  if (!document.getElementById("lintiq-navbar-responsive-style")) {
    const navStyle = document.createElement("style");
    navStyle.id = "lintiq-navbar-responsive-style";
    navStyle.textContent = `
      html, body {
        max-width: 100%;
        overflow-x: clip;
      }
      #lintiq-top-header {
        max-width: 100%;
      }
      #lintiq-primary-nav {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        flex-shrink: 0;
      }
      #settings-mobile-nav-group {
        display: none;
      }
      #lintiq-top-header .lintiq-nav-pill,
      #lintiq-top-header .lintiq-nav-action,
      #lintiq-top-header #open-settings-btn {
        white-space: nowrap;
        flex-shrink: 0;
      }

      /* Standard Laptops (1081px - 1439px): keep Leaderboard & Profile Stats visible, tighten gaps */
      @media (max-width: 1439px) {
        #lintiq-top-header {
          padding-left: 0.625rem;
          padding-right: 0.625rem;
          gap: 0.3rem;
        }
        #lintiq-top-header .lintiq-nav-left,
        #lintiq-top-header .lintiq-nav-center,
        #lintiq-top-header .lintiq-nav-right,
        #lintiq-top-header #lintiq-primary-nav {
          gap: 0.3rem;
        }
        #lintiq-top-header .lintiq-nav-pill,
        #lintiq-top-header .lintiq-nav-action {
          padding-left: 0.45rem;
          padding-right: 0.45rem;
          gap: 0.25rem;
        }
        #lintiq-top-header #lintiq-streak-pill,
        #lintiq-top-header #timer-hud,
        #lintiq-top-header #open-settings-btn {
          padding-left: 0.42rem;
          padding-right: 0.42rem;
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
      }

      /* Compact center HUD labels slightly at 1081px - 1220px so Leaderboard & Profile Stats fit cleanly */
      @media (max-width: 1220px) {
        #lintiq-top-header .lintiq-nav-pill,
        #lintiq-top-header .lintiq-nav-action {
          padding-left: 0.38rem;
          padding-right: 0.38rem;
          font-size: 11px;
        }
        #lintiq-top-header #timer-status {
          display: none;
        }
      }

      /* Tablets & Narrow Viewports (<= 1080px): move Leaderboard & Profile Stats into Settings dropdown */
      @media (max-width: 1080px) {
        #lintiq-primary-nav {
          display: none !important;
        }
        #settings-mobile-nav-group {
          display: block;
        }
      }

      /* Mobile (<= 768px, down to 360px): compact single-row controls & viewport-anchored dropdown */
      @media (max-width: 768px) {
        #lintiq-top-header {
          padding-left: 0.5rem;
          padding-right: 0.5rem;
          gap: 0.25rem;
        }
        #lintiq-top-header .lintiq-nav-left,
        #lintiq-top-header .lintiq-nav-right {
          gap: 0.25rem;
        }
        #lintiq-top-header .lintiq-nav-workspace-tab {
          display: none !important;
        }
        #settings-dropdown-wrapper {
          position: static;
        }
        #settings-popover-menu {
          position: absolute;
          top: 100%;
          right: 8px;
          margin-top: 6px;
          width: min(14rem, calc(100vw - 16px));
          max-width: calc(100vw - 16px);
        }
      }

      @media (max-width: 480px) {
        #lintiq-top-header {
          padding-left: 0.4rem;
          padding-right: 0.4rem;
          gap: 0.2rem;
        }
        #lintiq-top-header .lintiq-brand-dot {
          width: 0.5rem;
          height: 0.5rem;
        }
        #lintiq-top-header .lintiq-brand-name {
          font-size: 0.9rem;
        }
        #lintiq-top-header .lintiq-nav-pill {
          padding: 0.22rem 0.4rem;
          font-size: 11px;
        }
        #lintiq-top-header #btn-prev-problem,
        #lintiq-top-header #btn-next-problem {
          padding: 0.22rem 0.25rem;
        }
        #lintiq-top-header #btn-drawer-toggle {
          padding: 0.22rem 0.35rem;
          gap: 0.2rem;
        }
        #lintiq-top-header #btn-drawer-toggle svg {
          display: none;
        }
        #lintiq-top-header #seq-progress {
          font-size: 10px;
        }
        #lintiq-top-header #btn-ai-bug,
        #lintiq-top-header #open-settings-btn {
          padding: 0.25rem 0.35rem;
        }
        #lintiq-top-header #auth-section {
          padding-left: 0.3rem;
          gap: 0.25rem;
        }
        #lintiq-top-header #user-profile {
          gap: 0.25rem;
        }
        #lintiq-top-header #header-user-avatar {
          width: 1.5rem;
          height: 1.5rem;
          font-size: 10px;
        }
        #lintiq-top-header #btn-login {
          padding: 0.25rem 0.5rem;
          font-size: 11px;
        }
      }
    `;
    document.head.appendChild(navStyle);
  }

  navContainer.outerHTML = `
  <header id="lintiq-top-header" class="h-12 bg-surface border-b border-white/[0.07] px-3 sm:px-5 flex items-center justify-between gap-2 shrink-0 ${page === "workspace" ? "relative z-40" : "sticky top-0 z-40"} select-none">
    <!-- Left: Brand + Page Tabs -->
    <div class="lintiq-nav-left flex items-center gap-2 sm:gap-3 shrink-0">
      <a href="${brandHref}" class="flex items-center gap-2 text-white font-semibold tracking-[-0.02em] shrink-0" title="Switch Practice / Interview Mode">
        <span class="lintiq-brand-dot w-2 h-2 rounded-full bg-accent inline-block"></span>
        <span class="lintiq-brand-name text-[15px] sm:text-base">Lint<span class="text-accent">IQ</span></span>
      </a>

      <div class="flex items-center gap-1 ml-0.5 sm:ml-1 shrink-0">
        ${
          page === "workspace"
            ? `
          <a href="${directoryHref}"
            class="lintiq-nav-pill px-2.5 py-1 rounded-md text-[13px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05] transition flex items-center gap-1 whitespace-nowrap"
            title="Back to Full Problem List">
            <span>←</span><span class="hidden sm:inline">Problem List</span>
          </a>
          <a href="${workspaceHref}" class="lintiq-nav-pill lintiq-nav-workspace-tab hidden md:inline-block ${pill(true)}">Workspace</a>
        `
            : `
          <a href="${directoryHref}" class="lintiq-nav-pill ${pill(page === "directory")}">Problem List</a>
          <a href="${workspaceHref}" class="lintiq-nav-pill lintiq-nav-workspace-tab hidden md:inline-block ${pill(false)}">Workspace</a>
        `
        }
      </div>

      ${
        page === "workspace"
          ? `
        <!-- Segmented Prev / Problem Sequence Drawer / Next -->
        <div id="seq-nav-pill" class="bg-white/[0.03] border border-white/[0.08] rounded-md flex items-center shrink-0 divide-x divide-white/[0.07] overflow-hidden text-xs text-zinc-300">
          <button id="btn-prev-problem" type="button" onclick="loadPrevProblem()"
            class="px-2 py-1 hover:bg-white/[0.06] hover:text-white transition cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-300"
            title="Previous Problem" aria-label="Previous Problem">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button id="btn-drawer-toggle" type="button" onclick="openProblemListDrawer()"
            class="px-2.5 py-1 hover:bg-white/[0.06] hover:text-white transition flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            title="Quick Problem Switcher Drawer" aria-label="Open Problem Sequence Drawer">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span id="seq-progress" class="text-xs font-medium text-zinc-200 tabular-nums whitespace-nowrap">0 / 0</span>
          </button>
          <button id="btn-next-problem" type="button" onclick="loadNextProblem()"
            class="px-2 py-1 hover:bg-white/[0.06] hover:text-white transition cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-300"
            title="Next Problem" aria-label="Next Problem">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      `
          : ""
      }
    </div>

    ${
      page === "workspace"
        ? `
      <!-- Center: Streak & Timer HUD (workspace only) -->
      <div class="lintiq-nav-center hidden lg:flex items-center gap-2 text-xs shrink-0">
        <div id="lintiq-streak-pill" class="flex items-center gap-1.5 bg-white/[0.03] border border-white/[0.07] px-2.5 py-1 rounded-md text-zinc-300 font-medium whitespace-nowrap">
          <span class="text-amber-400">⚡</span>
          <span>Streak</span>
          <span id="streak-count" class="text-white font-semibold tabular-nums">0</span>
        </div>
        <div id="timer-hud" class="flex items-center gap-1.5 bg-white/[0.03] border border-white/[0.07] px-2.5 py-1 rounded-md text-emerald-400 whitespace-nowrap">
          <span id="timer-display" class="font-semibold tabular-nums">00:00</span>
          <span id="timer-status" class="text-[11px] font-normal text-zinc-400">Ready</span>
        </div>
      </div>
    `
        : ""
    }

    <!-- Right: Nav Links, Streak (non-workspace), Actions & Auth -->
    <div class="lintiq-nav-right flex items-center gap-1.5 sm:gap-2 text-xs shrink-0">
      ${
        page === "directory"
          ? `
        <div class="hidden sm:flex items-center gap-1.5 bg-white/[0.03] border border-white/[0.07] px-2.5 py-1 rounded-md text-zinc-300 font-medium">
          <span class="text-amber-400">⚡</span>
          <span>Streak</span>
          <span id="dir-streak" class="text-white font-semibold tabular-nums">0</span>
        </div>
      `
          : ""
      }

      <nav id="lintiq-primary-nav">
        <a id="nav-leaderboard-link" href="leaderboard.html" class="lintiq-nav-action ${navActionClass(page === "leaderboard")}">
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3" />
          </svg>
          <span>Leaderboard</span>
        </a>
        <a id="nav-profile-link" href="profile.html" class="lintiq-nav-action ${navActionClass(page === "profile")}">
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM4 20a8 8 0 0116 0" />
          </svg>
          <span>Profile Stats</span>
        </a>
      </nav>

      ${
        page === "directory"
          ? `
        <a id="btn-ai-bug" href="index.html?mode=${encodedMode}&ai=1" class="flex items-center gap-1.5 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] text-zinc-200 px-2.5 py-1 rounded-md transition text-[13px] font-medium whitespace-nowrap" title="Generate Instant AI Bug">
          <span>✨</span><span class="hidden sm:inline">Instant AI Bug</span>
        </a>
      `
          : ""
      }

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
          <div id="settings-mobile-nav-group">
            <a href="${directoryHref}" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-emerald-400 hover:bg-surface-hover transition text-left">
              <span>📋</span><span>Problem List</span>
            </a>
            <a href="${workspaceHref}" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left md:hidden">
              <span>💻</span><span>Workspace</span>
            </a>
            <a href="leaderboard.html" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left">
              <span>🏆</span><span>Leaderboard</span>
            </a>
            <a href="profile.html" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left">
              <span>📈</span><span>Profile Stats</span>
            </a>
            <div class="my-1 border-t border-surface-border"></div>
          </div>

          <a href="settings-profile.html" class="${settingsItemClass("profile")}">
            <span>👤</span><span>Profile & Bio</span>
          </a>
          <a href="settings-editor.html" class="${settingsItemClass("editor")}">
            <span>🖥️</span><span>Editor Settings</span>
          </a>
          <a href="settings-dashboard.html" class="${settingsItemClass("dashboard")}">
            <span>📊</span><span>Dashboard & Graph</span>
          </a>
          <a href="mode-selector.html" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-surface-hover hover:text-white transition text-left">
            <span>⇄</span><span>Switch Mode</span>
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
      <div id="auth-section" class="flex items-center gap-2 border-l border-white/[0.08] pl-2.5 shrink-0">
        <button id="btn-login" onclick="openAuthModal()" class="px-3 py-1 bg-accent hover:bg-accent-hover text-black font-semibold text-xs rounded-md transition whitespace-nowrap cursor-pointer">
          Sign In
        </button>

        <div id="user-profile" class="hidden flex items-center shrink-0">
          <a href="profile.html" class="flex items-center hover:opacity-85 transition" title="Profile &amp; Settings" aria-label="Profile &amp; Settings">
            <span id="header-user-avatar" class="w-7 h-7 rounded-full bg-white/[0.08] border border-white/[0.14] flex items-center justify-center text-white text-xs font-semibold shrink-0">LQ</span>
          </a>
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

  // Keep navbar auth UI synced immediately on every page load and auth state change
  if (window.supabaseClient?.auth) {
    const syncNavbarAuth = (session) => {
      const user = session?.user || null;
      window.currentSession = session || null;
      window.currentUser = user;
      if (typeof window.updateAuthUI === "function") {
        window.updateAuthUI(user);
      }
    };
    window.supabaseClient.auth
      .getSession()
      .then(({ data }) => syncNavbarAuth(data?.session || null))
      .catch(() => {});
    window.supabaseClient.auth.onAuthStateChange((_event, session) => {
      syncNavbarAuth(session || null);
    });
  }
})();
