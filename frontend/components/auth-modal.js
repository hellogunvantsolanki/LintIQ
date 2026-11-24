/**
 * LintIQ — auth-modal.js
 * Injects the shared Sign-In / Magic Link authentication modal onto every page.
 *
 * Usage: Add <div id="lintiq-auth-modal"></div> in <body>, then load this script.
 * Depends on: shared.js (openAuthModal, closeAuthModal, loginWithOAuth, handleEmailAuth)
 */
(function () {
  const slot = document.getElementById("lintiq-auth-modal");
  if (!slot) return;

  slot.outerHTML = `
  <div id="auth-modal" class="hidden fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
    <div class="bg-surface border border-surface-border w-full max-w-sm rounded-xl p-6 shadow-2xl relative">
      <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-gray-400 hover:text-white text-sm cursor-pointer">✕</button>
      <h3 class="text-lg font-bold text-white mb-1">Enter the Bug Arcade</h3>
      <p class="text-xs text-gray-400 mb-5">Sign in to save streaks, claim score points, and climb the cloud leaderboard.</p>

      <div class="space-y-2 mb-4">
        <button onclick="loginWithOAuth('github')" class="w-full py-2 px-3 bg-surface-container hover:bg-surface-hover border border-surface-border text-xs font-semibold text-white rounded-lg flex items-center justify-center gap-2 transition cursor-pointer">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
          Continue with GitHub
        </button>

        <button onclick="loginWithOAuth('google')" class="w-full py-2 px-3 bg-surface-container hover:bg-surface-hover border border-surface-border text-xs font-semibold text-white rounded-lg flex items-center justify-center gap-2 transition cursor-pointer">
          <svg class="w-4 h-4" viewBox="0 0 24 24"><path fill="#EA4335" d="M12 5c1.6 0 3 .6 4.1 1.6l3.1-3.1C17.3 1.7 14.8 1 12 1 7.5 1 3.7 3.6 1.9 7.3l3.7 2.9C6.5 7.4 9 5 12 5z" /><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.7-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.7l3.7 2.9c2.2-2 3.7-5.1 3.7-8.8z" /><path fill="#FBBC05" d="M5.6 14.8c-.2-.7-.4-1.5-.4-2.8 0-1.3.2-2.1.4-2.8L1.9 6.3C.7 8.7 0 10.3 0 12s.7 3.3 1.9 5.7l3.7-2.9z" /><path fill="#34A853" d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3 0-5.5-2.4-6.4-5.2L1.9 16C3.7 19.7 7.5 23 12 23z" /></svg>
          Continue with Google
        </button>
      </div>

      <div class="flex items-center my-4">
        <div class="flex-1 border-t border-surface-border"></div>
        <span class="px-2 text-[10px] text-gray-400 uppercase tracking-widest font-mono">or email</span>
        <div class="flex-1 border-t border-surface-border"></div>
      </div>

      <form onsubmit="handleEmailAuth(event)" class="space-y-3">
        <div>
          <label class="block text-[11px] font-mono text-gray-400 mb-1">Email address</label>
          <input type="email" id="auth-email" required placeholder="you@example.com" class="w-full px-3 py-2 bg-surface-dim border border-surface-border rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:border-accent" />
        </div>
        <button type="submit" id="btn-email-submit" class="w-full py-2 bg-gray-100 hover:bg-white text-gray-900 text-xs font-semibold rounded-lg transition cursor-pointer">
          Send Magic Sign-In Link
        </button>
        <p id="auth-msg" class="text-[11px] text-center"></p>
      </form>
    </div>
  </div>
  `;
})();
