// app.js - Cleaned JavaScript for LintIQ Frontend
"use strict";

(function () {
  // --- 1. Global State & Challenges Store ---
  const BACKEND_CONFIG = {
    localUrl: "http://127.0.0.1:8000",
    prodUrl: "https://lintiq.onrender.com",
    activeUrl: "http://127.0.0.1:8000",
    timeoutMs: 4000,
  };

  const CHALLENGE_DATABASE = {
    "042": {
      id: "0x48FA",
      title: "Binary Search Edge Condition Lock",
      difficulty: "Medium",
      desc: "The candidate implementation of classical binary search suffers from a catastrophic upper-bound boundary condition lock. When searching for a target strictly greater than the maximum element of a sorted collection, the pointer reassignment traps execution in a non-terminating spin loop.",
      expected: [
        "Returns exact index mid when needle exists.",
        "Returns -1 gracefully when needle < arr[0].",
        "Terminates O(log N) gracefully when needle > arr[N-1]."
      ],
      anomaly: [
        "Infinite Loop: Watchdog kills after 2,500ms.",
        "Pointer state: low = 4, high = 4, mid = 4 locked.",
        "Line 9 reassigns low = mid instead of advance."
      ],
      hints: {
        l1: "Inspect the convergence rate when low == high - 1. If integer division truncates towards low, reassignment must advance strictly past the midpoint.",
        l2: "Look closely at line 9. When nums[mid] < target, what should the new low boundary be to ensure strict shrinking of the interval?",
        l3: "Change line 9 from low = mid to low = mid + 1."
      },
      defaultInput: JSON.stringify({ nums: [2, 4, 6, 8, 10], target: 15 }, null, 2),
      starterCode: `from typing import List

def binary_search(nums: List[int], target: int) -> int:
    """
    Executes logarithmic lookup for target needle element.
    Returns index of target if present, otherwise returns -1.
    """
    low = 0
    high = len(nums) - 1

    while low <= high:
        mid = (low + high) // 2
        if nums[mid] == target:
            return mid
        elif nums[mid] < target:
            # BUGGY LINE: Causes infinite spin when target is out of bounds
            low = mid
        else:
            high = mid - 1

    return -1`
    },
    "043": {
      id: "0x892B",
      title: "Circular Buffer Wrap-Around Overflow",
      difficulty: "Medium",
      desc: "Ring buffer pointer arithmetic omits modulo wrap-around verification during rapid tail ingress, yielding out-of-bounds pointer overflow.",
      expected: [
        "Head and tail pointers stay strictly bounded inside capacity.",
        "Tail wraps to index 0 upon reaching queue boundary."
      ],
      anomaly: [
        "IndexError: list assignment index out of range when tail >= buffer.size.",
        "Unbounded pointer growth during sustained concurrent push."
      ],
      hints: {
        l1: "Check the write pointer advance operation against array capacity.",
        l2: "Remember to apply the modulo operation on every pointer increment.",
        l3: "Update `tail = tail + 1` to `tail = (tail + 1) % capacity`."
      },
      defaultInput: JSON.stringify({ capacity: 8, items_to_push: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, null, 2),
      starterCode: `class CircularBuffer:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.buffer = [None] * capacity
        self.head = 0
        self.tail = 0
        self.size = 0

    def push(self, val: int) -> bool:
        if self.size == self.capacity:
            return False
        # BUG: Fails to wrap around array modulo
        self.buffer[self.tail] = val
        self.tail = self.tail + 1
        self.size += 1
        return True`
    },
    "044": {
      id: "0x11DC",
      title: "Mutex Pool Inversion Deadlock",
      difficulty: "Hard",
      desc: "Thread lock acquisition occurs in arbitrary non-deterministic order between worker tasks, triggering an AB-BA deadlock cycle.",
      expected: [
        "Deterministic lock acquisition order based on mutex ID.",
        "All threads release locks within 100ms timeout."
      ],
      anomaly: [
        "Deadlock detected: Worker A holds Mutex 1, waiting on Mutex 2.",
        "Worker B holds Mutex 2, waiting on Mutex 1."
      ],
      hints: {
        l1: "Look at the order in which locks are acquired by competing threads.",
        l2: "Ensure a global total order is enforced when acquiring multiple mutexes.",
        l3: "Sort the mutex list by ID before requesting lock acquisition."
      },
      defaultInput: JSON.stringify({ thread_a_locks: [1, 2], thread_b_locks: [2, 1] }, null, 2),
      starterCode: `import threading
import time

def acquire_locks_unsafe(lock_a: threading.Lock, lock_b: threading.Lock):
    # BUG: Non-deterministic order leads to cyclic AB-BA stall
    lock_a.acquire()
    time.sleep(0.01)
    lock_b.acquire()
    lock_b.release()
    lock_a.release()`
    }
  };

  let currentChallengeId = "042";
  let monacoEditorInstance = null;
  let currentStreak = 4;
  let currentXP = 1280;
  let hintsUnlocked = { l1: true, l2: false, l3: false };

  // --- 2. Monaco Editor Initialization ---
  function initMonacoEditor() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

    require(['vs/editor/editor.main'], function () {
      monaco.editor.defineTheme('lintiqDark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'c084fc', fontStyle: 'bold' },
          { token: 'identifier', foreground: 'e2e8f0' },
          { token: 'string', foreground: '34d399' },
          { token: 'number', foreground: 'fbbf24' },
          { token: 'delimiter', foreground: '94a3b8' },
          { token: 'type', foreground: '38bdf8' }
        ],
        colors: {
          'editor.background': '#0a0e14',
          'editor.foreground': '#f1f5f9',
          'editorLineNumber.foreground': '#334155',
          'editorLineNumber.activeForeground': '#a78bfa',
          'editor.lineHighlightBackground': '#11182760',
          'editorCursor.foreground': '#c084fc',
          'editorWhitespace.foreground': '#1e293b',
          'editorIndentGuide.background': '#1e293b',
          'editorIndentGuide.activeBackground': '#475569'
        }
      });

      const hostElem = document.getElementById('monaco-host');
      if (!hostElem) return;

      monacoEditorInstance = monaco.editor.create(hostElem, {
        value: CHALLENGE_DATABASE[currentChallengeId].starterCode,
        language: 'python',
        theme: 'lintiqDark',
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        tabSize: 4,
        insertSpaces: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        cursorBlinking: 'smooth',
        padding: { top: 12, bottom: 12 },
        lineNumbersMinChars: 3
      });

      // Keybindings
      monacoEditorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, triggerRunCustom);
      monacoEditorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, triggerSubmitPatch);

      updateBuggyLineDecorations();
    });
  }

  function updateBuggyLineDecorations() {
    if (!monacoEditorInstance) return;
    monacoEditorInstance.deltaDecorations([], [{
      range: new monaco.Range(17, 1, 17, 1),
      options: {
        isWholeLine: true,
        className: 'buggy-line-highlight',
        glyphMarginClassName: 'buggy-line-glyph'
      }
    }]);
  }

  // --- 3. Split-Pane Resizing Handlers ---
  function initSplitPanes() {
    const gutterCol = document.getElementById('gutter-col');
    const leftPane = document.getElementById('left-pane');
    const gutterRow = document.getElementById('gutter-row');
    const bottomDrawer = document.getElementById('bottom-drawer');

    let isDraggingCol = false;
    gutterCol.addEventListener('mousedown', e => {
      isDraggingCol = true;
      gutterCol.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    let isDraggingRow = false;
    gutterRow.addEventListener('mousedown', e => {
      isDraggingRow = true;
      gutterRow.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    });

    window.addEventListener('mousemove', e => {
      if (isDraggingCol) {
        const containerRect = document.getElementById('workspace-container').getBoundingClientRect();
        const newWidth = e.clientX - containerRect.left;
        if (newWidth >= 300 && newWidth <= 700) {
          leftPane.style.width = `${newWidth}px`;
        }
      }
      if (isDraggingRow) {
        const containerRect = document.getElementById('right-pane').getBoundingClientRect();
        const newHeight = containerRect.bottom - e.clientY;
        if (newHeight >= 44 && newHeight <= 500) {
          bottomDrawer.style.height = `${newHeight}px`;
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingCol) {
        isDraggingCol = false;
        gutterCol.classList.remove('dragging');
        document.body.style.cursor = 'default';
      }
      if (isDraggingRow) {
        isDraggingRow = false;
        gutterRow.classList.remove('dragging');
        document.body.style.cursor = 'default';
      }
    });
  }

  // --- 4. Drawer & Tabs Management ---
  function initDrawerTabs() {
    const tabs = {
      'tab-custom-input': 'content-custom-input',
      'tab-execution-trace': 'content-execution-trace',
      'tab-official-suite': 'content-official-suite'
    };

    Object.keys(tabs).forEach(tabId => {
      const btn = document.getElementById(tabId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        Object.keys(tabs).forEach(id => {
          const otherBtn = document.getElementById(id);
          const otherContent = document.getElementById(tabs[id]);
          otherBtn.classList.remove('active-drawer-tab', 'text-brand-300', 'bg-brand-500/10', 'border', 'border-brand-500/30');
          otherBtn.classList.add('text-slate-400');
          otherContent.classList.add('hidden');
        });
        btn.classList.add('active-drawer-tab', 'text-brand-300', 'bg-brand-500/10', 'border', 'border-brand-500/30');
        btn.classList.remove('text-slate-400');
        document.getElementById(tabs[tabId]).classList.remove('hidden');
      });
    });

    const toggleBtn = document.getElementById('toggle-drawer-btn');
    const drawer = document.getElementById('bottom-drawer');
    let isCollapsed = false;
    toggleBtn.addEventListener('click', () => {
      isCollapsed = !isCollapsed;
      if (isCollapsed) {
        drawer.style.height = '42px';
        document.getElementById('toggle-drawer-icon').style.transform = 'rotate(180deg)';
      } else {
        drawer.style.height = '250px';
        document.getElementById('toggle-drawer-icon').style.transform = 'rotate(0deg)';
      }
    });

    document.getElementById('clear-console-btn').addEventListener('click', () => {
      document.getElementById('terminal-stdout').innerHTML = `<div class="text-slate-500 italic">$ Terminal cleared. Ready for next execution run.</div>`;
      document.getElementById('latency-val').textContent = '-- ms';
    });
  }

  // --- 5. Progressive AI Hints System ---
  function initProgressiveHints() {
    const hint2Btn = document.getElementById('reveal-hint-2-btn');
    const hint3Btn = document.getElementById('reveal-hint-3-btn');
    const getAiHintBtn = document.getElementById('get-ai-hint-btn');

    hint2Btn.addEventListener('click', () => {
      if (hintsUnlocked.l2) return;
      hintsUnlocked.l2 = true;
      currentXP = Math.max(0, currentXP - 25);
      updateScoreUI();

      const hint2Card = document.getElementById('hint-card-2');
      hint2Card.classList.remove('bg-surface-card/60', 'border-slate-800');
      hint2Card.classList.add('bg-surface-card', 'border-purple-500/30');
      document.getElementById('hint-2-icon').textContent = '💡';
      document.getElementById('hint-2-text').textContent = CHALLENGE_DATABASE[currentChallengeId].hints.l2;
      document.getElementById('hint-2-text').classList.remove('text-slate-500', 'italic');
      document.getElementById('hint-2-text').classList.add('text-slate-300');
      hint2Btn.replaceWith(createBadgeElement('Unlocked', 'bg-purple-500/20 text-purple-300'));

      hint3Btn.disabled = false;
      hint3Btn.classList.remove('bg-slate-800', 'text-slate-500', 'cursor-not-allowed', 'border-slate-700');
      hint3Btn.classList.add('bg-brand-500/20', 'hover:bg-brand-500/30', 'text-brand-300', 'border-brand-500/40', 'cursor-pointer');
      hint3Btn.textContent = 'Reveal (-50 XP)';
      document.getElementById('hints-unlocked-status').textContent = '2 of 3 Available';
    });

    hint3Btn.addEventListener('click', () => {
      if (hintsUnlocked.l3 || !hintsUnlocked.l2) return;
      hintsUnlocked.l3 = true;
      currentXP = Math.max(0, currentXP - 50);
      updateScoreUI();

      const hint3Card = document.getElementById('hint-card-3');
      hint3Card.classList.remove('bg-surface-card/40', 'border-slate-800/80', 'opacity-75');
      hint3Card.classList.add('bg-surface-card', 'border-purple-500/30', 'opacity-100');
      document.getElementById('hint-3-icon').textContent = '💡';
      document.getElementById('hint-3-text').textContent = CHALLENGE_DATABASE[currentChallengeId].hints.l3;
      document.getElementById('hint-3-text').classList.remove('text-slate-600', 'italic');
      document.getElementById('hint-3-text').classList.add('text-slate-300');
      hint3Btn.replaceWith(createBadgeElement('Unlocked', 'bg-purple-500/20 text-purple-300'));
      document.getElementById('hints-unlocked-status').textContent = 'All 3 Unlocked';
    });

    getAiHintBtn.addEventListener('click', () => {
      if (!hintsUnlocked.l2) {
        hint2Btn.click();
      } else if (!hintsUnlocked.l3) {
        hint3Btn.click();
      } else {
        showToast("All available AI hints unlocked for this challenge.");
      }
    });
  }

  function createBadgeElement(text, classes) {
    const span = document.createElement('span');
    span.className = `text-[10px] font-mono px-1.5 py-0.5 rounded ${classes}`;
    span.textContent = text;
    return span;
  }

  function updateScoreUI() {
    document.getElementById('score-counter').textContent = currentXP.toLocaleString();
    document.getElementById('streak-counter').textContent = currentStreak;
  }

  // --- 6. Challenge Switcher ---
  function initChallengeSwitcher() {
    const selector = document.getElementById('challenge-select');
    selector.addEventListener('change', e => loadChallenge(e.target.value));
  }

  function loadChallenge(id) {
    const data = CHALLENGE_DATABASE[id];
    if (!data) return;
    currentChallengeId = id;
    document.getElementById('challenge-vuln-id').textContent = `ID: ${data.id}`;
    document.getElementById('challenge-title').textContent = data.title;
    document.getElementById('challenge-desc').textContent = data.desc;
    document.getElementById('challenge-difficulty').textContent = data.difficulty;

    const expUl = document.getElementById('expected-list');
    expUl.innerHTML = data.expected.map(item => `<li>• ${escapeHtml(item)}</li>`).join('');
    const anomUl = document.getElementById('anomaly-list');
    anomUl.innerHTML = data.anomaly.map(item => `<li>• ${escapeHtml(item)}</li>`).join('');

    document.getElementById('hint-1-text').textContent = data.hints.l1;
    hintsUnlocked = { l1: true, l2: false, l3: false };
    document.getElementById('hints-unlocked-status').textContent = '1 of 3 Available';

    document.getElementById('custom-input-textarea').value = data.defaultInput;
    if (monacoEditorInstance) {
      monacoEditorInstance.setValue(data.starterCode);
    }
  }

  // --- 7. Backend Execution & Simulation Fallbacks ---
  async function checkBackendHealth() {
    const indicatorDot = document.getElementById('backend-indicator-dot');
    const indicatorLabel = document.getElementById('backend-indicator-label');
    const banner = document.getElementById('backend-status-banner');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${BACKEND_CONFIG.activeUrl}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        indicatorDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
        indicatorLabel.textContent = 'FastAPI Connected';
        banner.classList.add('hidden');
        return true;
      }
    } catch (err) {
      indicatorDot.className = 'w-2 h-2 rounded-full bg-amber-400';
      indicatorLabel.textContent = 'Sandbox Simulation';
      banner.classList.remove('hidden');
      return false;
    }
  }

  async function triggerRunCustom() {
    const btn = document.getElementById('run-custom-btn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin text-xs">⟳</span> Running...`;
    document.getElementById('tab-execution-trace').click();

    const code = monacoEditorInstance ? monacoEditorInstance.getValue() : '';
    const customInputRaw = document.getElementById('custom-input-textarea').value;
    let parsedInput = {};
    try {
      parsedInput = JSON.parse(customInputRaw);
    } catch (e) {
      appendTerminalOutput(`[ERROR] Invalid JSON payload in Custom Input: ${e.message}`, 'rose');
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      return;
    }

    const startTime = performance.now();
    try {
      const response = await fetch(`${BACKEND_CONFIG.activeUrl}/run-custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: currentChallengeId,
          patch_code: code,
          input_args: parsedInput
        })
      });
      const elapsed = Math.round(performance.now() - startTime);
      document.getElementById('latency-val').textContent = `${elapsed} ms`;
      if (response.ok) {
        const data = await response.json();
        renderExecutionTrace(data);
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      simulateRunCustomExecution(code, parsedInput);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }

  async function triggerSubmitPatch() {
    const btn = document.getElementById('submit-patch-btn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin text-xs">⟳</span> Grading...`;
    document.getElementById('tab-official-suite').click();
    const code = monacoEditorInstance ? monacoEditorInstance.getValue() : '';
    const startTime = performance.now();
    try {
      const response = await fetch(`${BACKEND_CONFIG.activeUrl}/submit-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge_id: currentChallengeId,
          patch_code: code
        })
      });
      const elapsed = Math.round(performance.now() - startTime);
      document.getElementById('latency-val').textContent = `${elapsed} ms`;
      if (response.ok) {
        const data = await response.json();
        renderOfficialSuiteResults(data);
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      simulateOfficialSuiteGrading(code);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }

  function simulateRunCustomExecution(code, inputPayload) {
    const elapsed = Math.floor(Math.random() * 30) + 12;
    document.getElementById('latency-val').textContent = `${elapsed} ms`;
    const isFixed = code.includes('low = mid + 1');
    const terminal = document.getElementById('terminal-stdout');
    if (isFixed) {
      terminal.innerHTML = `
        <div class="text-slate-400">$ python -m pytest tests/test_custom.py -v</div>
        <div class="text-emerald-400 flex items-center gap-1.5">
          <span>✓ PASSED</span>
          <span class="text-slate-200">test_custom_execution(nums=${JSON.stringify(inputPayload.nums)}, target=${inputPayload.target})</span>
          <span class="text-slate-500 ml-auto">[100%] 0.008s</span>
        </div>
        <div class="text-emerald-400/90 pt-1 text-[11px] border-t border-emerald-500/20 mt-1">
          Returned: <strong>-1</strong> (Needle gracefully unindexed without infinite boundary spin).<br>
          =================== 1 passed in 0.012s ===================
        </div>
      `;
    } else {
      terminal.innerHTML = `
        <div class="text-slate-400">$ python -m pytest tests/test_custom.py -v</div>
        <div class="text-rose-400 flex items-center gap-1.5">
          <span>✗ FAILED</span>
          <span class="text-slate-200">test_custom_execution(target=${inputPayload.target})</span>
          <span class="text-rose-400 font-bold ml-auto">TIMEOUT > 2500ms</span>
        </div>
        <div class="text-rose-400/90 pt-1 text-[11px] border-t border-rose-500/20 mt-1">
          AssertionError: Process interrupted after 2500ms watchdog trigger.<br>
          State trace: low=4, high=4, mid=4 → low reassigned to 4 repeatedly.<br>
          Line 17: low = mid trapped execution.
        </div>
      `;
    }
  }

  function simulateOfficialSuiteGrading(code) {
    const isFixed = code.includes('low = mid + 1');
    const pill = document.getElementById('suite-status-pill');
    const scoreInd = document.getElementById('suite-score-indicator');
    const casesList = document.getElementById('suite-cases-list');
    if (isFixed) {
      pill.textContent = '3/3 Pass';
      pill.className = 'text-[10px] px-1.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      scoreInd.textContent = 'Current XP Gain: +150 PTS (Verified)';
      currentStreak += 1;
      currentXP += 150;
      updateScoreUI();
      casesList.innerHTML = `
        <div class="flex items-center justify-between p-2 rounded bg-surface-card border border-emerald-500/30">
          <div class="flex items-center gap-2">
            <span class="text-emerald-400">✓</span>
            <span class="text-slate-200">Case 1: Standard needle match in odd array</span>
          </div>
          <span class="text-slate-400 text-[11px]">8ms (PASS)</span>
        </div>
        <div class="flex items-center justify-between p-2 rounded bg-surface-card border border-emerald-500/30">
          <div class="flex items-center gap-2">
            <span class="text-emerald-400">✓</span>
            <span class="text-slate-200">Case 2: Needle less than min boundary (-1)</span>
          </div>
          <span class="text-slate-400 text-[11px]">6ms (PASS)</span>
        </div>
        <div class="flex items-center justify-between p-2 rounded bg-surface-card border border-emerald-500/30">
          <div class="flex items-center gap-2">
            <span class="text-emerald-400">✓</span>
            <span class="text-emerald-300 font-semibold">Case 3: Needle strictly greater than array ceiling</span>
          </div>
          <span class="text-emerald-400 font-mono text-[11px]">9ms (PASS)</span>
        </div>`;
    } else {
      pill.textContent = '2/3 Pass';
      pill.className = 'text-[10px] px-1.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30';
      scoreInd.textContent = 'Current XP Gain: 0 / 150 PTS';
      casesList.innerHTML = `
        <div class="flex items-center justify-between p-2 rounded bg-surface-card border border-emerald-500/20">
          <div class="flex items-center gap-2">
            <span class="text-emerald-400">✓</span>
            <span class="text-slate-200">Case 1: Standard needle match in odd array</span>
          </div>
          <span class="text-slate-400 text-[11px]">12ms (PASS)</span>
        </div>
        <div class="flex items-center justify-between p-2 rounded bg-surface-card border border-emerald-500/20">
          <div class="flex items-center gap-2">
            <span class="text-emerald-400">✓</span>
            <span class="text-slate-200">Case 2: Needle less than min boundary (-1)</span>
          </div>
          <span class="text-slate-400 text-[11px]">9ms (PASS)</span>
        </div>
        <div class="flex items-center justify-between p-2 rounded bg-rose-950/20 border border-rose-500/30">
          <div class="flex items-center gap-2">
            <span class="text-rose-400">✗</span>
            <span class="text-rose-200">Case 3: Needle strictly greater than array ceiling</span>
          </div>
          <span class="text-rose-400 font-mono text-[11px]">TIMEOUT (2500ms limit reached)</span>
        </div>`;
    }
  }

  // --- 8. Reset button listener ---
  function initResetButton() {
    document.getElementById('reset-code-btn').addEventListener('click', () => {
      if (monacoEditorInstance) {
        monacoEditorInstance.setValue(CHALLENGE_DATABASE[currentChallengeId].starterCode);
        showToast("Reset code to starter patch.");
      }
    });
    document.getElementById('dismiss-banner-btn').addEventListener('click', () => {
      document.getElementById('backend-status-banner').classList.add('hidden');
    });
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'fixed bottom-5 right-5 z-50 px-4 py-2 rounded-lg bg-surface-card border border-brand-500/40 text-brand-200 text-xs font-mono shadow-xl transition-opacity duration-300';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- DOM Ready Bootstrap ---
  document.addEventListener('DOMContentLoaded', () => {
    initMonacoEditor();
    initSplitPanes();
    initDrawerTabs();
    initProgressiveHints();
    initChallengeSwitcher();
    initResetButton();
    checkBackendHealth();
  });
})();
