const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = app.getPath('userData');
const SETTINGS_FILE = path.join(USER_DATA_DIR, 'settings.json');

// Migration: Check for legacy paths
function migrateSettings() {
    const rootSettings = path.join(__dirname, 'settings.json');
    const programDataSettings = path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'LeelaV1', 'settings.json');

    // 1. Check Root migration
    if (fs.existsSync(rootSettings)) {
        try {
            if (!fs.existsSync(SETTINGS_FILE)) {
                fs.copyFileSync(rootSettings, SETTINGS_FILE);
                console.log('[SettingsManager] Migrated settings from project root');
            }
            fs.unlinkSync(rootSettings); // Always remove from root
            console.log('[SettingsManager] Removed legacy settings from project root');
        } catch (e) {
            console.error('[SettingsManager] Root migration/cleanup failed:', e);
        }
    }

    // 2. Check ProgramData migration
    if (fs.existsSync(programDataSettings)) {
        try {
            if (!fs.existsSync(SETTINGS_FILE)) {
                fs.copyFileSync(programDataSettings, SETTINGS_FILE);
                console.log('[SettingsManager] Migrated settings from ProgramData');
            }
            fs.unlinkSync(programDataSettings);
            console.log('[SettingsManager] Removed legacy settings from ProgramData');
        } catch (e) {
            console.error('[SettingsManager] ProgramData migration/cleanup failed:', e);
        }
    }
}

migrateSettings();

const DEFAULT_SETTINGS = {
    overlayEnabled: true,
    hotkey: 'Control+Space',
    historyEnabled: true,
    historyRetentionLimit: 200,
    startWithWindows: false,
    targetLanguage: 'en',
    targetLanguageName: 'English',
    onboarding_completed: false,
    optimizerEnabled: true,
    optimizerQualityThreshold: 95,
    optimizerMaxFileSizeMB: 500,
    optimizerAutoLearn: true,
};

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
        } catch (e) {
            console.error('[SettingsManager] Failed to load settings:', e);
        }
    } else {
        saveSettings();
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('[SettingsManager] Failed to save settings:', e);
    }
}

function getSettings() {
    return { ...settings };
}

function updateSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    saveSettings();
    return settings;
}

// Initial load
loadSettings();

module.exports = {
    getSettings,
    updateSettings
};
