const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = app.getPath('userData');
const HISTORY_FILE = path.join(USER_DATA_DIR, 'activity_history.json');

// Migration: Check for legacy paths
function migrateHistory() {
    const rootHistory = path.join(__dirname, 'activity_history.json');
    const programDataHistory = path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'LeelaV1', 'activity_history.json');

    // 1. Check Root migration
    if (fs.existsSync(rootHistory)) {
        try {
            if (!fs.existsSync(HISTORY_FILE)) {
                fs.copyFileSync(rootHistory, HISTORY_FILE);
                console.log('[ActivityLogger] Migrated history from project root');
            }
            fs.unlinkSync(rootHistory); // Always remove from root
            console.log('[ActivityLogger] Removed legacy history from project root');
        } catch (e) {
            console.error('[ActivityLogger] Root migration/cleanup failed:', e);
        }
    }

    // 2. Check ProgramData migration
    if (fs.existsSync(programDataHistory)) {
        try {
            if (!fs.existsSync(HISTORY_FILE)) {
                fs.copyFileSync(programDataHistory, HISTORY_FILE);
                console.log('[ActivityLogger] Migrated history from ProgramData');
            }
            fs.unlinkSync(programDataHistory);
            console.log('[ActivityLogger] Removed legacy history from ProgramData');
        } catch (e) {
            console.error('[ActivityLogger] ProgramData migration/cleanup failed:', e);
        }
    }
}

migrateHistory();

function logAction({ type, input, output, status, qualityScores }) {
    try {
        let history = [];
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            history = JSON.parse(data);
        }

        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            type,
            input: input || '',
            output: output || '',
            status,
            qualityScores: qualityScores || null
        };

        history.unshift(entry);

        // Limit to 200 entries
        if (history.length > 200) {
            history = history.slice(0, 200);
        }

        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
        console.log(`[ActivityLogger] Logged ${type}: ${status}`);
    } catch (e) {
        console.error('[ActivityLogger] Failed to log action:', e);
    }
}

function getHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('[ActivityLogger] Failed to get history:', e);
    }
    return [];
}

module.exports = {
    logAction,
    getHistory
};
