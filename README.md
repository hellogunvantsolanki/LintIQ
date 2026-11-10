# LintIQ — AI Bug-Hunting & Code Review Arcade

An interactive, gamified developer arcade engineered to test and sharpen practical debugging skills under timed conditions.

- **Live Frontend:** [https://lint-iq.vercel.app](https://lint-iq.vercel.app)
- **API Documentation:** [https://lintiq.onrender.com/docs](https://lintiq.onrender.com/docs)

---

## Architecture & System Design

[Gemini AI Pipeline]
│
▼ (Structured Challenge Synthesis)
[Dual-Gate Sandbox Validator] ── (Pass/Fail Verification Gate)
│
▼ (Zero-Latency Pre-Warmed Caching)
[SQLite (problems.db)]
│
▼ (<10ms Response Delivery)
[FastAPI Cloud Engine]
▲
│ JSON Payload & Patch Verification
▼
[Monaco Editor + Tailwind UI] ── (User Submits Patch) ──► [Test Runner Gate] ──► [Score / Streak Update]


## Features

- **Automated Challenge Synthesis:** Puzzles generated dynamically via Google Gemini models, structured around common algorithmic patterns with subtle logical bugs.
- **Dual-Gate Verification:** Every generated challenge undergoes independent test verification on both the flawed source and the canonical patch before reaching the cache.
- **Sub-10ms Challenge Delivery:** Pre-warmed SQLite database eliminates cold-start latency and LLM costs during gameplay.
- **Developer Workspace:** Integrated Microsoft Monaco Editor (VS Code engine) with full syntax highlighting, indentation, and keybindings.
- **Arcade Dynamics:** Real-time solve timer, streak multipliers, difficulty-scaled scoring, and context-aware AI hints that guide without spoiling solutions.

## Tech Stack

- **Frontend:** Vanilla JavaScript, HTML5, Tailwind CSS, Monaco Editor
- **Backend:** FastAPI, Uvicorn, Pydantic, Python 3
- **AI Engine:** Google Gemini API (`google-genai` SDK)
- **Database:** SQLite3
- **Hosting:** Vercel (Frontend CDN), Render (Backend Web Service)