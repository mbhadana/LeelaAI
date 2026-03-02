const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

class SecretManager {
    constructor() {
        this.configPath = path.join(app.getPath('userData'), 'config.json');
        this.keyDir = path.dirname(this.configPath);
        this.migrateConfig();
    }

    migrateConfig() {
        const rootConfig = path.join(__dirname, 'config.json');
        if (fs.existsSync(rootConfig)) {
            try {
                if (!fs.existsSync(this.configPath)) {
                    this.ensureDirectory();
                    fs.copyFileSync(rootConfig, this.configPath);
                    console.log('[SecretManager] Migrated config from project root');
                }
                fs.unlinkSync(rootConfig); // Always remove from root
                console.log('[SecretManager] Removed legacy config from project root');
            } catch (e) {
                console.error('[SecretManager] Config migration/cleanup failed:', e);
            }
        }
    }

    ensureDirectory() {
        if (!fs.existsSync(this.keyDir)) {
            fs.mkdirSync(this.keyDir, { recursive: true });
        }
    }

    /**
     * Encrypts and saves the Sarvam API key.
     * @param {string} apiKey 
     */
    setApiKey(apiKey) {
        if (!apiKey) return;
        this.ensureDirectory();

        let encrypted;
        try {
            if (safeStorage.isEncryptionAvailable()) {
                encrypted = safeStorage.encryptString(apiKey).toString('base64');
            } else {
                // Fallback or error if encryption isn't available
                console.warn('[SecretManager] Encryption not available, using plain storage (NOT RECOMMENDED)');
                encrypted = Buffer.from(apiKey).toString('base64');
            }

            const config = this.loadConfig();
            config.sarvam_api_key = encrypted;
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('[SecretManager] Failed to set API key:', e);
            return false;
        }
    }

    /**
     * Decrypts and returns the Sarvam API key.
     * @returns {string|null}
     */
    getApiKey() {
        try {
            const config = this.loadConfig();
            const encrypted = config.sarvam_api_key;
            if (!encrypted) return null;

            const buffer = Buffer.from(encrypted, 'base64');
            if (safeStorage.isEncryptionAvailable()) {
                return safeStorage.decryptString(buffer);
            } else {
                return buffer.toString('utf8');
            }
        } catch (e) {
            console.error('[SecretManager] Failed to get API key:', e);
            return null;
        }
    }

    hasApiKey() {
        const config = this.loadConfig();
        return !!config.sarvam_api_key;
    }

    removeApiKey() {
        try {
            const config = this.loadConfig();
            delete config.sarvam_api_key;
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('[SecretManager] Failed to remove API key:', e);
            return false;
        }
    }

    loadConfig() {
        if (fs.existsSync(this.configPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } catch (e) {
                console.warn('[SecretManager] Failed to parse config.json, returning empty', e);
                return {};
            }
        }
        return {};
    }
}

module.exports = new SecretManager();
