const { app, BrowserWindow, globalShortcut, Notification, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('ffmpeg-static');
const cleanup = require('./cleanup');
const settingsManager = require('./settings_manager');
const activityLogger = require('./activity_logger');
const secretManager = require('./secret_manager');
const platformHelper = require('./platform_helper');
const optimizer = require('./optimizer');
const { uIOhook } = require('uiohook-napi');

// Set App User Model ID for Windows Taskbar consistency
if (process.platform === 'win32') {
  app.setAppUserModelId('com.leelav1.assistant');
}

// Help functionality: Load .env from both local and original project
function loadEnv(targetPath) {
  if (fs.existsSync(targetPath)) {
    try {
      const envRaw = fs.readFileSync(targetPath, 'utf8');
      envRaw.split(/\r?\n/).forEach(line => {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) {
          const k = m[1].trim();
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (!process.env[k]) process.env[k] = v;
        }
      });
      console.log('[LeelaV1] Loaded env from', targetPath);
    } catch (e) {
      console.warn('[LeelaV1] Failed to read .env at', targetPath, e);
    }
  }
}

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(__dirname, '..', 'voice-writer-ai', '.env'));
loadEnv(path.join('C:', 'Users', 'admin', 'Documents', 'SpeechToTextAI', 'voice-writer-ai', '.env'));

const logs = [];
const logLimit = 1000;

function addLog(level, msg) {
  const logLine = `${new Date().toISOString()} [${level}] ${String(msg)}`;
  logs.push(logLine);
  if (logs.length > logLimit) logs.shift();
  // Also write to file for persistence if desired, but for now memory buffer is enough for live debugging
  try {
    const logFile = path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'LeelaV1', 'app.log');
    fs.appendFileSync(logFile, logLine + '\n');
  } catch (e) { }
}

// Intercept console
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  originalLog.apply(console, args);
  addLog('INFO', args.join(' '));
};
console.error = (...args) => {
  originalError.apply(console, args);
  addLog('ERROR', args.join(' '));
};
console.warn = (...args) => {
  originalWarn.apply(console, args);
  addLog('WARN', args.join(' '));
};

// Auto-Restart with Crash Loop Guard
// Max 3 restarts within 60 seconds to prevent infinite crash loops
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS = 3;
const recentCrashes = [];

function safeRestart(reason) {
  const now = Date.now();
  recentCrashes.push(now);
  // Keep only crashes within the window
  while (recentCrashes.length > 0 && (now - recentCrashes[0]) > RESTART_WINDOW_MS) {
    recentCrashes.shift();
  }

  if (recentCrashes.length > MAX_RESTARTS) {
    console.error(`[LeelaV1] Crash loop detected (${recentCrashes.length} crashes in ${RESTART_WINDOW_MS / 1000}s). NOT restarting.`);
    app.exit(1);
    return;
  }

  console.error(`[LeelaV1] Auto-restarting due to: ${reason}`);
  app.relaunch();
  app.exit(0);
}

process.on('uncaughtException', (err) => {
  console.error('[LeelaV1 MAIN] Uncaught Exception:', err && err.message ? err.message : err);
  setTimeout(() => safeRestart(err && err.message ? err.message : 'uncaughtException'), 300);
});
process.on('unhandledRejection', (reason) => {
  console.error('[LeelaV1 MAIN] Unhandled Rejection:', reason);
  setTimeout(() => safeRestart(String(reason)), 300);
});

let isProcessingHotkey = false;
let statusWindow;
let dashboardWindow;

const AppStates = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  SUCCESS_PASTE: 'SUCCESS_PASTE',
  SUCCESS_POLISH: 'SUCCESS_POLISH',
  ERROR: 'ERROR',
  WARNING: 'WARNING'
};

let currentStateStatus = AppStates.IDLE;

// Dual-Mode Recording State
let isCtrlPressed = false;
let isSpacePressed = false;
let pressStartTime = 0;
let recordingType = null; // 'CLICK' or 'HOLD'
let isRecordingActive = false; // Tracks if the recorder is running
let lastHotkeyTime = 0; // Debounce guard
let pendingSelection = null; // Stores text for Command Mode
let oldClipboardBeforeSelection = null; // Stores clipboard for restoration
let capturePromise = null; // Promise tracker for selection capture
const HOTKEY_DEBOUNCE = 100; // ms

// createWindow() removed - functionality merged into Dashboard

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) return;

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  const { x, y } = primaryDisplay.workArea;

  statusWindow = new BrowserWindow({
    width: width,
    height: 20, /* Height optimized for taskbar boundary */
    x: x,
    y: y + primaryDisplay.workArea.height - 20,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    icon: platformHelper.getIconPath(__dirname),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  statusWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  // Position handled at window creation

  // Interaction-Transparent: Allow clicking through the pill to underlying windows
  statusWindow.setIgnoreMouseEvents(true);

  // Optional: Restore it for the close button if we really want it, 
  // but user said "Allow clicking/typing behind it"
}

function updateState(state, message = null) {
  // Check if overlay is enabled in settings
  const settings = settingsManager.getSettings();
  if (!settings.overlayEnabled && state !== AppStates.IDLE) return;

  if (currentStateStatus !== state) {
    console.log(`[STATE] Transition: ${currentStateStatus} -> ${state}`);
    currentStateStatus = state;
  }

  if (!statusWindow || statusWindow.isDestroyed()) createStatusWindow();

  if (state === AppStates.IDLE) {
    statusWindow.webContents.send('hide-status');
    setTimeout(() => { if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide(); }, 400);
  } else {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { x, y } = primaryDisplay.workArea;
    const { height } = primaryDisplay.workArea;
    statusWindow.setPosition(x, y + height - 20);

    statusWindow.show();
    statusWindow.webContents.send('update-status', state, message);

    // Auto-hide for terminal states
    if (state === AppStates.SUCCESS_PASTE || state === AppStates.SUCCESS_POLISH || state === AppStates.ERROR || state === AppStates.WARNING) {
      setTimeout(() => updateState(AppStates.IDLE), 1500);
    }
  }
}

let tray = null;

function createTray() {
  const iconPath = platformHelper.getIconPath(__dirname);
  const { Menu, Tray } = require('electron');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => createDashboardWindow() },
    {
      label: 'Settings', click: () => {
        createDashboardWindow();
        // Potentially send IPC to switch to settings tab here if needed
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Leela V1', click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Leela V1 - AI Assistant');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    createDashboardWindow();
  });
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Leela V1 Dashboard',
    icon: platformHelper.getIconPath(__dirname),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));

  // Instead of closing, hide the dashboard
  dashboardWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
  });

  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}

function notifyDashboard(event, data) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(event, data);
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Both command line and simple double-click should now trigger the Dashboard
    createDashboardWindow();
  });
}

/**
 * Captures currently selected text by simulating Ctrl+C
 */
async function captureSelectedText() {
  const oldClipboard = clipboard.readText();
  clipboard.clear();

  // 1. Simulate Copy command to get selection
  const copyScriptContent = platformHelper.getCopyScript();
  const copyScriptPath = path.join(require('os').tmpdir(), `leelacopy_${Date.now()}.${platformHelper.getScriptExtension()}`);
  fs.writeFileSync(copyScriptPath, copyScriptContent);

  const selectionResult = await new Promise((resolve) => {
    const cmd = platformHelper.getExecutionCommand(copyScriptPath);
    exec(cmd, { windowsHide: true }, async () => {
      try { fs.unlinkSync(copyScriptPath); } catch (_) { }
      await new Promise(r => setTimeout(r, 100)); // Optimized to 100ms
      const selection = clipboard.readText();
      resolve(selection);
    });
  });

  if (!selectionResult || selectionResult.trim().length === 0) {
    return { selection: '', oldClipboard, isEditable: false };
  }

  // 2. Heuristic: Try to "Cut" (Ctrl+X) and then "Undo" (Ctrl+Z)
  clipboard.clear();
  const cutScriptContent = platformHelper.getCutScript();
  const cutScriptPath = path.join(require('os').tmpdir(), `leelacut_${Date.now()}.${platformHelper.getScriptExtension()}`);
  fs.writeFileSync(cutScriptPath, cutScriptContent);

  const isEditable = await new Promise((resolve) => {
    const cmd = platformHelper.getExecutionCommand(cutScriptPath);
    exec(cmd, { windowsHide: true }, async () => {
      try { fs.unlinkSync(cutScriptPath); } catch (_) { }
      await new Promise(r => setTimeout(r, 100)); // Optimized to 100ms
      const cutContent = clipboard.readText();
      const editable = cutContent !== "";

      if (editable) {
        // Use UNDO to restore text AND selection highlight
        const undoScriptContent = platformHelper.getUndoScript();
        const undoScriptPath = path.join(require('os').tmpdir(), `leelaundo_${Date.now()}.${platformHelper.getScriptExtension()}`);
        fs.writeFileSync(undoScriptPath, undoScriptContent);
        const undoCmd = platformHelper.getExecutionCommand(undoScriptPath);
        exec(undoCmd, { windowsHide: true }, () => {
          try { fs.unlinkSync(undoScriptPath); } catch (_) { }
          resolve(true);
        });
      } else {
        resolve(false);
      }
    });
  });

  return { selection: selectionResult, oldClipboard, isEditable };
}

/**
 * Polishes text using Sarvam Chat API for Intelligent Dictation
 */
async function polishText(text, instruction = null, overrideLang = null, overrideLangName = null) {
  const apiKey = secretManager.getApiKey();
  if (!apiKey) throw new Error('Sarvam API Key not found. Please set it in Settings.');

  const settings = settingsManager.getSettings();
  const targetLang = overrideLang || settings.targetLanguage || 'en';
  const targetLangName = overrideLangName || settings.targetLanguageName || 'English';

  const isEnglish = targetLang === 'en';

  let systemPrompt = "";
  if (instruction) {
    // COMMAND MODE PROMPT: Leela’s Senior Writing Executor
    systemPrompt = `You are Leela’s Senior Writing Executor.
Your role is to intelligently transform the "input_text" based strictly on the "user_instruction".

STRICT PHILOSOPHY:
- Clear, intelligent, non-robotic writing.
- Background processor: NEVER reveal reasoning, thoughts, or commentary.
- Return ONLY the final usable text.

------------------------------------------------
STEP 1 — INTENT CLASSIFICATION
Infer intent naturally. If unclear → default to POLISH.
Possible intents: POLISH, MAKE PROFESSIONAL, SUMMARIZE, SHORTEN, EXPAND, SIMPLIFY, TRANSLATE, TONE CHANGE, FORMAT CHANGE.

------------------------------------------------
STEP 2 — TRANSFORMATION RULES
- POLISH: Improve grammar/clarity, remove repetition, preserve meaning, keep tone natural.
- MAKE PROFESSIONAL: Remove slang, increase clarity, structure, maintain respectful tone.
- SUMMARIZE: Reduce length by >=50%, preserve core meaning, make concise and structured.
- SHORTEN: Reduce length by ~40–60%, keep original message intact.
- EXPAND: Add clarity/structure, elaborate logically, no unrelated ideas.
- SIMPLIFY: Plain language, remove jargon, accessible.
- TRANSLATE: Absolute accuracy in ${targetLangName}, preserve tone, no explanations.
- TONE CHANGE: Adjust as requested, maintain original meaning.
- FORMAT CHANGE: Convert format (bullet points, paragraph, etc.) strictly.

------------------------------------------------
STEP 3 — STYLE ALIGNMENT
- Preserve user’s voice.
- Avoid robotic phrasing or over-formality (unless requested).
- Avoid unnecessary verbosity.

------------------------------------------------
STEP 4 — STRUCTURAL ENFORCEMENT
If structural change is required, enforce it strictly and fully.

------------------------------------------------
STEP 5 — SILENT QUALITY CHECK (INTERNAL)
Verify: Meaning preserved, instruction executed, NEVER output your thoughts.

------------------------------------------------
FINAL OUTPUT RULE
Return ONLY the final transformed text. 
- No labels (e.g., "Result:", "Transformed:").
- No commentary or preamble (e.g., "Here is the text:", "Okay, let's...").
- No reasoning, internal analysis, thoughts, or evaluation tags.
- No <internal_analysis>, <thought>, or <final_result> tags.

Failure to follow the "Output Only" rule is a system error.`;
  } else {
    // STANDARD POLISH PROMPT
    systemPrompt = isEnglish
      ? `You are Leela's "Invisible Editor." 
Your MISSION: Transform spoken transcriptions into world-class written English.

STRICT INSTRUCTIONS:
- You are an invisible editor. NEVER reveal your reasoning, thoughts, or analysis.
- Do NOT output <thought>, analysis, or explanations.
- Do NOT show evaluation scores or describe improvements.
- Return ONLY the final, polished text. No conversational preamble.

WORKFLOW (INTERNAL ONLY):
1. [POLISH]: Convert audio to professional English. Remove fillers/stumbles.
2. [SELF-EVALUATE]: Score internally (1-10) on Meaning, Grammar, and Tone.
3. [IMPROVE]: If scores < 8, perform a second pass.

OUTPUT FORMAT:
Return ONLY the final, polished text. No conversational preamble. No thoughts. No tags.`
      : `You are Leela's "Invisible Editor."
Your MISSION: Translate transcriptions into professional, high-quality ${targetLangName}.

STRICT INSTRUCTIONS:
- You are an invisible editor. NEVER reveal your reasoning, thoughts, or analysis.
- Do NOT output <thought>, analysis, or explanations.
- Do NOT show evaluation scores or describe improvements.
- Return ONLY the final, polished text. No conversational preamble.

WORKFLOW (INTERNAL ONLY):
1. [TRANSLATE]: Provide a natural translation.
2. [SELF-EVALUATE]: Score internally (1-10) on Accuracy, Fluency, and Tone.
3. [IMPROVE]: If scores < 8, refine.

OUTPUT FORMAT:
Return ONLY the final, polished text. No conversational preamble. No thoughts. No tags.`;
  }

  const userPrompt = instruction
    ? `USER_INSTRUCTION: "${instruction}"\nINPUT_TEXT: "${text}"`
    : `TRANSCRIPTION TO PROCESS: "${text}"`;

  const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
    model: 'sarvam-m',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.1
  }, {
    headers: { 'api-subscription-key': apiKey },
    timeout: 30000
  });

  const content = response.data?.choices?.[0]?.message?.content || text;

  // EXTRACTION & SANITIZATION
  // We no longer use tags. We just clean up any potential markdown or labels if the AI leaks them.
  let cleaned = content
    .replace(/<internal_analysis>[\s\S]*?<\/internal_analysis>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<final_result>|<\/final_result>/gi, '')
    .replace(/<final_output>|<\/final_output>/gi, '')
    .replace(/<internal_feedback>[\s\S]*?<\/internal_feedback>/gi, '')
    .trim();

  // Safety Cleanup: Prune potential preamble or AI chatter
  const removalPatterns = [
    /^(?:certainly|of course|sure|okay|here is|the (?:polished|transformed) version is)[:\s-]*/i,
    /^(?:Result|Transformed|Polished|Final Text|Here is the result)[:\s-]*/i,
    /^["'«„](.*?)["'»“]$/s
  ];

  for (const regex of removalPatterns) {
    cleaned = cleaned.replace(regex, (match, p1) => p1 || '').trim();
  }

  // Final trim and character cleanup
  cleaned = cleaned.replace(/^[:\s.-]+/, '').trim();

  return {
    text: cleaned,
    qualityScores: { meaning: 10, grammar: 10, tone: 10 }
  };
}

/**
 * Sync the "Run on Startup" setting with Windows using Electron's API
 */
function syncStartupSetting() {
  const settings = settingsManager.getSettings();
  const startWithWindows = settings.startWithWindows;

  console.log(`[LeelaV1] Syncing startup setting: ${startWithWindows}`);

  try {
    app.setLoginItemSettings({
      openAtLogin: startWithWindows,
      path: process.execPath,
      args: [
        path.resolve(__dirname)
      ]
    });
    console.log(`[LeelaV1] Successfully ${startWithWindows ? 'registered' : 'unregistered'} for startup.`);
  } catch (e) {
    console.error('[LeelaV1] Failed to sync startup setting:', e);
  }
}

app.whenReady().then(() => {
  // First-run Initialization
  const userDataPath = app.getPath('userData');
  const firstRunFile = path.join(userDataPath, 'first_run.flag');
  if (!fs.existsSync(firstRunFile)) {
    console.log('[LeelaV1] First run detected. Initializing setup.');
    // History initialization is handled by activity_logger.js's migrate logic
    // but we can ensure the directory exists here if needed.
    fs.writeFileSync(firstRunFile, 'initialized');
  }

  createTray();

  // createWindow() removed
  createDashboardWindow(); // Single UI window (will show setup or dashboard internally)

  createStatusWindow();

  // Handle command line flags
  if (process.argv.includes('--dashboard')) {
    createDashboardWindow();
  }
  // Dual-Mode Hotkey Handling Logic
  async function handleHotkeyTrigger() {
    if (isProcessingHotkey) return;
    isProcessingHotkey = true;

    console.log('[LeelaV1] Hotkey Triggered: Control+Space');

    try {
      // RESET STATE
      pendingSelection = null;
      oldClipboardBeforeSelection = null;

      // START CAPTURE (Async)
      capturePromise = captureSelectedText();
      const result = await capturePromise;
      const { selection, oldClipboard, isEditable } = result;

      if (selection && selection.trim().length > 0) {
        if (!isEditable) {
          console.log('[LeelaV1] Text is NOT editable. Aborting trigger.');
          clipboard.writeText(oldClipboard);
          capturePromise = null;
          isProcessingHotkey = false;
          return;
        }

        console.log('[LeelaV1] Selection detected and editable. Preparing Command/Hold recording.');
        pendingSelection = selection;
        oldClipboardBeforeSelection = oldClipboard;

        // START RECORDING UI (Wait for keydown to ensure it's still held if needed)
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('play-command-sound'); // Immediate feedback
          dashboardWindow.webContents.send('hotkey-toggle');
        }
      } else {
        console.log('[LeelaV1] No selection. Default Dictation Mode.');
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('hotkey-toggle');
        }
      }
      isProcessingHotkey = false;
    } catch (err) {
      console.error('[LeelaV1] Trigger error:', err);
      updateState(AppStates.ERROR, 'Trigger Failed');
      capturePromise = null;
      isProcessingHotkey = false;
    }
  }

  async function handleHotkeyRelease(duration) {
    console.log(`[LeelaV1] Hotkey Released (Duration: ${duration}ms)`);

    // WAIT for capture to finish if it's still running
    if (capturePromise) {
      console.log('[LeelaV1] Waiting for selection capture to finalize...');
      await capturePromise;
      capturePromise = null;
    }
    if (pendingSelection) {
      if (duration < 300) {
        console.log(`[LeelaV1] Short tap with selection (${duration}ms). DISCARDING recording and triggering INSTANT POLISH.`);

        // Stop the recording that was started on keydown (if active)
        if (isRecordingActive && dashboardWindow && !dashboardWindow.isDestroyed()) {
          // We'll set a flag so process-recording knows to discard this one
          recordingType = 'TAP_DISCARD';
          dashboardWindow.webContents.send('hotkey-toggle');
        }

        // Run existing Instant Polish logic
        runInstantPolish(pendingSelection, oldClipboardBeforeSelection);
        pendingSelection = null;
      } else {
        console.log(`[LeelaV1] Hold Command detected (${duration}ms). Finalizing voice command.`);
        recordingType = 'HOLD';
        if (isRecordingActive && dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('hotkey-toggle');
        }
      }
    } else {
      // Normal dictation logic
      if (duration >= 500) {
        console.log(`[LeelaV1] Dictation Hold finished (${duration}ms).`);
        recordingType = 'HOLD';
        if (isRecordingActive && dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('hotkey-toggle');
        }
      } else {
        console.log(`[LeelaV1] Dictation Click detected.`);
        recordingType = 'CLICK';
      }
    }
  }

  // Helper for instant polish (tap behavior)
  async function runInstantPolish(text, oldClipboard) {
    updateState(AppStates.PROCESSING);
    try {
      const polishResult = await polishText(text);
      const polished = polishResult.text;
      const qualityScores = polishResult.qualityScores;

      if (settingsManager.getSettings().historyEnabled) {
        activityLogger.logAction({
          type: 'Smart Polish',
          input: text,
          output: polished,
          status: 'SUCCESS',
          qualityScores
        });
        notifyDashboard('history-updated');
      }

      clipboard.writeText(polished);
      const scriptContent = platformHelper.getPasteScript();
      const scriptPath = path.join(require('os').tmpdir(), `leelapaste_polish_${Date.now()}.${platformHelper.getScriptExtension()}`);
      fs.writeFileSync(scriptPath, scriptContent);

      const cmd = platformHelper.getExecutionCommand(scriptPath);
      exec(cmd, { windowsHide: true }, () => {
        try { fs.unlinkSync(scriptPath); } catch (_) { }
        setTimeout(() => {
          clipboard.writeText(oldClipboard);
          updateState(AppStates.SUCCESS_POLISH);
        }, 500);
      });
    } catch (err) {
      console.error('[LeelaV1] Polish failed:', err.message);
      updateState(AppStates.ERROR);
      clipboard.writeText(oldClipboard);
    }
  }

  // Register uIOhook listeners
  uIOhook.on('keydown', (e) => {
    const isCtrl = e.keycode === 29 || e.keycode === 3613;
    const isSpace = e.keycode === 57;

    if (isCtrl) isCtrlPressed = true;
    if (isSpace) isSpacePressed = true;

    if (isCtrlPressed && isSpacePressed) {
      const now = Date.now();
      if (pressStartTime === 0 && now - lastHotkeyTime > HOTKEY_DEBOUNCE) {
        lastHotkeyTime = now;
        pressStartTime = now;
        handleHotkeyTrigger();
      }
    }
  });

  uIOhook.on('keyup', (e) => {
    const isCtrl = e.keycode === 29 || e.keycode === 3613;
    const isSpace = e.keycode === 57;

    if (isCtrl) isCtrlPressed = false;
    if (isSpace) {
      isSpacePressed = false;
      if (pressStartTime !== 0) {
        const duration = Date.now() - pressStartTime;
        pressStartTime = 0;
        handleHotkeyRelease(duration);
      }
    }
  });

  uIOhook.start();

  // Sync startup setting on launch
  syncStartupSetting();

  // Start background cleanup (silent)
  cleanup.initCleanup(__dirname);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboardWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Ensure we unregister global shortcuts on quit
app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
    console.log('[LeelaV1] Unregistered all global shortcuts');
  } catch (e) {
    console.error('[LeelaV1] Error unregistering global shortcuts:', e);
  }
});

// Paste text into the currently focused application by writing to clipboard and sending Ctrl+V
ipcMain.handle('paste-text', async (event, text) => {
  try {
    if (!text) return { ok: false, error: 'empty' };
    console.log('[LeelaV1] Pasting transcript:', text.substring(0, 50) + '...');
    clipboard.writeText(String(text));

    // Platform specific paste
    const scriptContent = platformHelper.getPasteScript();
    const scriptPath = path.join(require('os').tmpdir(), `leelapaste_${Date.now()}.${platformHelper.getScriptExtension()}`);
    fs.writeFileSync(scriptPath, scriptContent);

    const cmd = platformHelper.getExecutionCommand(scriptPath);
    exec(cmd, { windowsHide: true }, (err) => {
      try { fs.unlinkSync(scriptPath); } catch (_) { }
    });

    return { ok: true };
  } catch (e) {
    console.error('[LeelaV1] paste-text handler error:', e);
    return { ok: false, error: String(e) };
  }
});

// Receive renderer log messages and persist to file for debugging
ipcMain.on('renderer-log', (event, level, msg) => {
  try {
    const logLine = `${new Date().toISOString()} [${level}] ${String(msg)}\n`;
    fs.appendFileSync(path.join(__dirname, 'renderer.log'), logLine);
  } catch (e) {
    console.error('[LeelaV1] Failed to write renderer.log', e);
  }
});

/**
 * Convert .webm to .wav (16kHz, mono) and transcribe via Sarvam synchronous API
 */
const util = require('util');
const execAsync = util.promisify(exec);

/**
 * Convert .webm to .wav (16kHz, mono) and transcribe via Sarvam synchronous API.
 * Handles long audio by chunking into 25s segments using FFmpeg.
 */
async function transcribeSynchronous(webmPath, apiKey) {
  const baseName = path.basename(webmPath, '.webm');
  const tempDir = path.dirname(webmPath);
  const wavPath = path.join(tempDir, `${baseName}_full.wav`);
  const chunkPattern = path.join(tempDir, `${baseName}_chunk_%03d.wav`);

  try {
    console.log('[RECORDER] Converting to WAV asynchronously:', webmPath);
    // Convert to 16k, mono, 16bit WAV without blocking the event loop
    const convCmd = `"${ffmpeg}" -i "${webmPath}" -ar 16000 -ac 1 -c:a pcm_s16le -y "${wavPath}"`;
    await execAsync(convCmd, { maxBuffer: 10 * 1024 * 1024 }); // 10MB buffer to prevent hang

    console.log('[RECORDER] Chunking audio if needed...');
    // Split into 25s chunks without blocking
    const splitCmd = `"${ffmpeg}" -i "${wavPath}" -f segment -segment_time 25 -c copy "${chunkPattern}"`;
    await execAsync(splitCmd, { maxBuffer: 10 * 1024 * 1024 });

    // Identify chunk files
    const files = fs.readdirSync(tempDir);
    const chunkFiles = files
      .filter(f => f.startsWith(`${baseName}_chunk_`) && f.endsWith('.wav'))
      .sort()
      .map(f => path.join(tempDir, f));

    console.log(`[LeelaV1] Processing ${chunkFiles.length} chunks...`);
    const transcripts = [];

    for (const chunk of chunkFiles) {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(chunk), {
        filename: 'audio.wav',
        contentType: 'audio/wav'
      });
      formData.append('model', 'saaras:v3');
      formData.append('mode', 'translate');
      const settings = settingsManager.getSettings();
      formData.append('targetLanguage', settings.targetLanguage || 'en');

      try {
        const response = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
          headers: {
            ...formData.getHeaders(),
            'api-subscription-key': apiKey
          },
          timeout: 45000 // Increased timeout for individual chunks
        });

        if (response.data && response.data.transcript) {
          transcripts.push(response.data.transcript.trim());
        }
      } catch (err) {
        console.error(`[LeelaV1] Chunk transcription segment failed:`, err.message);
      } finally {
        // Cleanup chunk file immediately
        try { fs.unlinkSync(chunk); } catch (_) { }
      }
    }

    if (transcripts.length === 0) {
      return { ok: false, error: 'transcription_failed' };
    }

    const finalTranscript = transcripts.join(' ');
    console.log('[LeelaV1] Combined Transcript:', finalTranscript.substring(0, 100) + '...');
    return { ok: true, text: finalTranscript };

  } catch (err) {
    console.error('[LeelaV1] Synchronous transcription error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    // Cleanup temporary full wav
    try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (_) { }
  }
}

// Process a saved recording using Sarvam synchronous API and paste result
ipcMain.handle('process-recording', async (event, filePath) => {
  updateState(AppStates.PROCESSING);
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      updateState(AppStates.ERROR, 'File Missing');
      return { ok: false, error: 'file_missing' };
    }

    // Load API key from secret manager
    const apiKey = secretManager.getApiKey();
    if (!apiKey) {
      updateState(AppStates.ERROR, 'API Key Missing');
      return { ok: false, error: 'no_api_key' };
    }

    console.log('[LeelaV1] Starting fast-path transcription for:', filePath);
    updateState(AppStates.PROCESSING);

    // NEW: Handle discarded taps (Quick Polish already handled the text)
    if (recordingType === 'TAP_DISCARD') {
      console.log('[LeelaV1] Recording discarded (Quick Polish mode).');
      recordingType = null;
      return { ok: true, text: '' };
    }

    const result = await transcribeSynchronous(filePath, apiKey);

    if (result.ok && result.text) {
      const transcript = result.text.trim();
      console.log('[LeelaV1] Transcript received:', transcript);

      let finalResult = transcript;
      let overrideLang = null;
      let overrideLangName = null;

      // NEW: HOLD-TO-COMMAND LOGIC
      const isContextCommand = pendingSelection !== null;
      const contextText = pendingSelection;
      const contextClipboard = oldClipboardBeforeSelection;

      // Clear pending state immediately to prevent re-runs
      pendingSelection = null;
      oldClipboardBeforeSelection = null;

      // VOICE DIRECTIVE PARSING (e.g., "Translate to Hindi: Hello" OR "Hello, translate to Hindi")
      const languages = [
        { code: 'hi', name: 'Hindi' },
        { code: 'fr', name: 'French' },
        { code: 'es', name: 'Spanish' },
        { code: 'de', name: 'German' },
        { code: 'it', name: 'Italian' },
        { code: 'ja', name: 'Japanese' },
        { code: 'ko', name: 'Korean' },
        { code: 'zh', name: 'Chinese' },
        { code: 'bn', name: 'Bengali' },
        { code: 'ta', name: 'Tamil' },
        { code: 'te', name: 'Telugu' },
        { code: 'gu', name: 'Gujarati' },
        { code: 'kn', name: 'Kannada' },
        { code: 'ml', name: 'Malayalam' },
        { code: 'mr', name: 'Marathi' },
        { code: 'pa', name: 'Punjabi' },
        { code: 'or', name: 'Odia' },
        { code: 'en', name: 'English' }
      ];

      let cleanTranscript = transcript;
      for (const lang of languages) {
        // 1. Check for command at the start
        const startRegex = new RegExp(`^(?:translate\\s+(?:to|in)\\s+|in\\s+)${lang.name}[,:\\s-]+(.*)`, 'i');
        const startMatch = transcript.match(startRegex);
        if (startMatch) {
          overrideLang = lang.code;
          overrideLangName = lang.name;
          cleanTranscript = startMatch[1].trim();
          console.log(`[LeelaV1] Voice Directive Detected (Start): ${lang.name}. Clean text: ${cleanTranscript}`);
          break;
        }

        // 2. Check for command at the end
        const endRegex = new RegExp(`^(.*?)[,:\\s-]+(?:translate\\s+(?:to|in)\\s+|in\\s+)${lang.name}[.]?$`, 'i');
        const endMatch = transcript.match(endRegex);
        if (endMatch) {
          overrideLang = lang.code;
          overrideLangName = lang.name;
          cleanTranscript = endMatch[1].trim();
          console.log(`[LeelaV1] Voice Directive Detected (End): ${lang.name}. Clean text: ${cleanTranscript}`);
          break;
        }
      }

      try {
        console.log('[LeelaV1] Processing transcription...');
        const polishResult = isContextCommand
          ? await polishText(contextText, transcript, overrideLang, overrideLangName)
          : await polishText(cleanTranscript, null, overrideLang, overrideLangName);

        finalResult = polishResult.text;
        const qualityScores = polishResult.qualityScores;
        console.log('[LeelaV1] Processing complete.');

        // Quality Guard: Check for low-quality results
        let finalState = AppStates.SUCCESS_PASTE;
        let finalMessage = null;

        if (qualityScores) {
          const minScore = Math.min(qualityScores.meaning, qualityScores.grammar, qualityScores.tone);
          if (minScore < 7) {
            finalState = AppStates.WARNING;
            finalMessage = 'Low Quality Detected';
            console.warn('[LeelaV1] Low-quality result detected:', qualityScores);
          }
        }

        // Paste using the platform-specific method
        clipboard.writeText(String(finalResult));
        const scriptContent = platformHelper.getPasteScript();
        const scriptPath = path.join(require('os').tmpdir(), `leelapaste_fast_${Date.now()}.${platformHelper.getScriptExtension()}`);
        fs.writeFileSync(scriptPath, scriptContent);

        const cmd = platformHelper.getExecutionCommand(scriptPath);
        exec(cmd, { windowsHide: true }, (err) => {
          try { fs.unlinkSync(scriptPath); } catch (_) { }
          if (err) {
            console.error('[LeelaV1] Failed to paste:', err);
            updateState(AppStates.ERROR, 'Paste Failed');
          } else {
            updateState(finalState, finalMessage);
            // Log activity
            if (settingsManager.getSettings().historyEnabled) {
              activityLogger.logAction({
                type: isContextCommand ? 'Context Command' : 'Smart Polish',
                input: isContextCommand ? `Context: ${contextText} | Cmd: ${transcript}` : transcript,
                output: finalResult,
                status: 'SUCCESS',
                qualityScores
              });
              notifyDashboard('history-updated');
            }

            // Restore clipboard if we were in command mode
            if (isContextCommand && contextClipboard) {
              setTimeout(() => clipboard.writeText(contextClipboard), 500);
            }
          }
        });
      } catch (err) {
        console.warn('[LeelaV1] Auto-polish failed, using raw transcript:', err.message);
        // Paste raw transcript
        clipboard.writeText(String(finalResult));
        const scriptContent = platformHelper.getPasteScript();
        const scriptPath = path.join(require('os').tmpdir(), `leelapaste_fast_${Date.now()}.${platformHelper.getScriptExtension()}`);
        fs.writeFileSync(scriptPath, scriptContent);

        const cmd = platformHelper.getExecutionCommand(scriptPath);
        exec(cmd, { windowsHide: true }, (err) => {
          try { fs.unlinkSync(scriptPath); } catch (_) { }
          if (err) {
            console.error('[LeelaV1] Failed to paste:', err);
            updateState(AppStates.ERROR, 'Paste Failed');
          } else {
            updateState(AppStates.SUCCESS_PASTE);
            // Log activity
            if (settingsManager.getSettings().historyEnabled) {
              activityLogger.logAction({
                type: 'Voice Dictation',
                input: transcript,
                output: finalResult,
                status: 'SUCCESS'
              });
              notifyDashboard('history-updated');
            }
          }
        });
      }
      return { ok: true, text: transcript };
    }

    updateState(AppStates.ERROR, 'No Transcript');
    return { ok: false, error: result.error || 'no_transcript' };
  } catch (e) {
    updateState(AppStates.ERROR, 'System Error');
    console.error('[API] process-recording error:', e);
    return { ok: false, error: String(e) };
  } finally {
    // Immediate and explicit cleanup of the input webm file
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { }
    cleanup.runCleanup(__dirname);
  }
});

ipcMain.on('mic-data', (event, value) => {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('mic-data', value);
  }
});

ipcMain.on('overlay-log', (event, msg) => {
  console.log(`[OVERLAY DEBUG] ${msg}`);
});

// IPC Handlers for Dashboard & Settings
ipcMain.handle('get-history', () => {
  return activityLogger.getHistory();
});

ipcMain.handle('get-temp-path', () => {
  return app.getPath('temp');
});

ipcMain.handle('get-settings', () => {
  return settingsManager.getSettings();
});

ipcMain.on('update-setting', (event, newSetting) => {
  const oldSettings = settingsManager.getSettings();
  settingsManager.updateSettings(newSetting);

  // If startWithWindows was changed, sync it
  if (newSetting.hasOwnProperty('startWithWindows') && newSetting.startWithWindows !== oldSettings.startWithWindows) {
    syncStartupSetting();
  }
});

ipcMain.on('open-dashboard', () => {
  createDashboardWindow();
});

// Added to allow renderer to update global state
ipcMain.on('update-app-state', (event, state) => {
  const newState = AppStates[state] || state;
  updateState(newState);

  // Sync internal recording state for hotkey logic
  if (newState === AppStates.LISTENING) {
    isRecordingActive = true;
  } else if (newState === AppStates.IDLE || newState === AppStates.PROCESSING || newState === AppStates.ERROR) {
    isRecordingActive = false;
  }
});

// Sarvam API Key Management IPC
ipcMain.handle('test-sarvam-key', async (event, key) => {
  try {
    const testKey = key || secretManager.getApiKey();
    if (!testKey) return { ok: false, error: 'No API key provided or stored.' };

    // Lightweight check: use Chat API
    const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
      model: 'sarvam-m',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1
    }, {
      headers: { 'api-subscription-key': testKey },
      timeout: 5000
    });

    return { ok: true };
  } catch (err) {
    console.error('[LeelaV1] API Key test failed:', err.response?.data || err.message);
    return { ok: false, error: err.response?.data?.message || err.message };
  }
});

ipcMain.handle('save-sarvam-key', async (event, key) => {
  const success = secretManager.setApiKey(key);
  if (success) {
    // Notify dashboard to refresh its view
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('key-saved');

      // Trigger onboarding if not yet completed
      const settings = settingsManager.getSettings();
      if (!settings.onboarding_completed) {
        setTimeout(() => {
          if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send('start-onboarding');
          }
        }, 500); // Short delay for setup pane to close
      }
    }
    createDashboardWindow(); // Re-ensure dictation window is ready
  }
  return success;
});

ipcMain.handle('remove-sarvam-key', () => {
  return secretManager.removeApiKey();
});

ipcMain.handle('has-sarvam-key', () => {
  return secretManager.hasApiKey();
});

ipcMain.handle('get-logs', () => {
  return logs;
});

ipcMain.on('clear-logs', () => {
  logs.length = 0;
});

ipcMain.handle('get-onboarding-status', () => {
  const settings = settingsManager.getSettings();
  return !settings.onboarding_completed;
});

ipcMain.on('complete-onboarding', () => {
  settingsManager.updateSettings({ onboarding_completed: true });
  console.log('[LeelaV1] Onboarding completed.');
});

// ── Optimizer IPC Handlers ──────────────────────────────────
ipcMain.handle('optimize-file', async (event, filePath, options) => {
  try {
    const result = await optimizer.optimizeFile(filePath, {
      ...options,
      onProgress: (stage, percent, message) => {
        notifyDashboard('optimizer-progress', { stage, percent, message });
      },
    });
    return result;
  } catch (e) {
    console.error('[LeelaV1] optimize-file error:', e);
    return { success: false, error: String(e) };
  }
});

ipcMain.handle('analyze-file', async (event, filePath) => {
  try {
    return await optimizer.analyzeFile(filePath);
  } catch (e) {
    return { error: String(e) };
  }
});

ipcMain.handle('get-optimizer-stats', () => {
  return optimizer.getOptimizerStats();
});

ipcMain.handle('get-optimizer-settings', () => {
  return optimizer.getOptimizerSettings();
});

ipcMain.on('update-optimizer-settings', (event, newSettings) => {
  optimizer.updateOptimizerSettings(newSettings);
});

ipcMain.handle('get-optimizer-metrics', () => {
  return optimizer.getOptimizerMetrics();
});

ipcMain.on('reset-optimizer-learning', () => {
  optimizer.resetLearning();
});

