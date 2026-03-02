/**
 * Performance Logger — Stores optimization metrics for analysis and learning.
 * Follows the same patterns as activity_logger.js for consistency.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let USER_DATA_DIR;
try {
    const { app } = require('electron');
    USER_DATA_DIR = app.getPath('userData');
} catch (e) {
    // Fallback for non-Electron execution (tests, CLI)
    USER_DATA_DIR = path.join(os.homedir(), '.leelav1');
}

const METRICS_FILE = path.join(USER_DATA_DIR, 'optimizer_metrics.json');
const MAX_ENTRIES = 500;

/**
 * Ensure the data directory exists.
 */
function ensureDir() {
    try {
        if (!fs.existsSync(USER_DATA_DIR)) {
            fs.mkdirSync(USER_DATA_DIR, { recursive: true });
        }
    } catch (e) {
        console.error('[OptimizerLogger] Failed to create data directory:', e.message);
    }
}

/**
 * Load existing metrics from disk.
 * @returns {Array}
 */
function loadMetrics() {
    try {
        if (fs.existsSync(METRICS_FILE)) {
            const data = fs.readFileSync(METRICS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('[OptimizerLogger] Failed to load metrics:', e.message);
    }
    return [];
}

/**
 * Save metrics to disk.
 * @param {Array} metrics
 */
function saveMetrics(metrics) {
    ensureDir();
    try {
        fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
    } catch (e) {
        console.error('[OptimizerLogger] Failed to save metrics:', e.message);
    }
}

/**
 * Log an optimization run's results.
 *
 * @param {Object} entry
 * @param {string} entry.originalPath
 * @param {number} entry.originalSize
 * @param {number} entry.optimizedSize
 * @param {number} entry.processingTimeMs
 * @param {number} entry.qualityScore
 * @param {string} entry.methodUsed — strategy name
 * @param {string} entry.fileType
 * @param {string} entry.format
 * @param {boolean} [entry.skipped]
 * @param {boolean} [entry.rolledBack]
 * @param {Array} [entry.stages]
 */
function logOptimization(entry) {
    try {
        const metrics = loadMetrics();

        const record = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            timestamp: new Date().toISOString(),
            originalPath: entry.originalPath,
            fileName: path.basename(entry.originalPath),
            originalSize: entry.originalSize,
            optimizedSize: entry.optimizedSize,
            reductionPercent: entry.originalSize > 0
                ? Math.round((1 - entry.optimizedSize / entry.originalSize) * 100 * 100) / 100
                : 0,
            processingTimeMs: entry.processingTimeMs,
            qualityScore: entry.qualityScore,
            methodUsed: entry.methodUsed,
            fileType: entry.fileType,
            format: entry.format || 'unknown',
            skipped: entry.skipped || false,
            rolledBack: entry.rolledBack || false,
            stages: entry.stages || [],
            systemEnv: {
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                hostname: os.hostname(),
            },
        };

        metrics.unshift(record);

        // Cap entries
        if (metrics.length > MAX_ENTRIES) {
            metrics.length = MAX_ENTRIES;
        }

        saveMetrics(metrics);
        console.log(`[OptimizerLogger] Logged: ${record.fileName} | ${record.reductionPercent}% reduction | ${record.processingTimeMs}ms`);

        return record;
    } catch (e) {
        console.error('[OptimizerLogger] Failed to log optimization:', e.message);
        return null;
    }
}

/**
 * Get all logged metrics.
 * @returns {Array}
 */
function getMetrics() {
    return loadMetrics();
}

/**
 * Get aggregate statistics across all logged optimizations.
 * @returns {Object}
 */
function getStats() {
    const metrics = loadMetrics().filter(m => !m.skipped);

    if (metrics.length === 0) {
        return {
            totalOptimizations: 0,
            totalOriginalSize: 0,
            totalOptimizedSize: 0,
            totalSaved: 0,
            avgReductionPercent: 0,
            avgProcessingTimeMs: 0,
            avgQualityScore: 0,
            bestReduction: null,
            strategyBreakdown: {},
            fileTypeBreakdown: {},
        };
    }

    const totalOriginal = metrics.reduce((s, m) => s + (m.originalSize || 0), 0);
    const totalOptimized = metrics.reduce((s, m) => s + (m.optimizedSize || 0), 0);
    const totalTime = metrics.reduce((s, m) => s + (m.processingTimeMs || 0), 0);
    const totalQuality = metrics.reduce((s, m) => s + (m.qualityScore || 0), 0);

    // Strategy breakdown
    const strategyBreakdown = {};
    for (const m of metrics) {
        const key = m.methodUsed || 'unknown';
        if (!strategyBreakdown[key]) {
            strategyBreakdown[key] = { count: 0, avgReduction: 0, totalReduction: 0 };
        }
        strategyBreakdown[key].count++;
        strategyBreakdown[key].totalReduction += m.reductionPercent || 0;
    }
    for (const key of Object.keys(strategyBreakdown)) {
        strategyBreakdown[key].avgReduction =
            Math.round(strategyBreakdown[key].totalReduction / strategyBreakdown[key].count * 100) / 100;
    }

    // File type breakdown
    const fileTypeBreakdown = {};
    for (const m of metrics) {
        const key = m.fileType || 'unknown';
        if (!fileTypeBreakdown[key]) {
            fileTypeBreakdown[key] = { count: 0, avgReduction: 0, totalReduction: 0 };
        }
        fileTypeBreakdown[key].count++;
        fileTypeBreakdown[key].totalReduction += m.reductionPercent || 0;
    }
    for (const key of Object.keys(fileTypeBreakdown)) {
        fileTypeBreakdown[key].avgReduction =
            Math.round(fileTypeBreakdown[key].totalReduction / fileTypeBreakdown[key].count * 100) / 100;
    }

    // Best single optimization
    const bestReduction = metrics.reduce((best, m) =>
        (m.reductionPercent || 0) > (best?.reductionPercent || 0) ? m : best, null);

    return {
        totalOptimizations: metrics.length,
        totalOriginalSize: totalOriginal,
        totalOptimizedSize: totalOptimized,
        totalSaved: totalOriginal - totalOptimized,
        totalSavedHuman: formatBytes(totalOriginal - totalOptimized),
        avgReductionPercent: Math.round(metrics.reduce((s, m) => s + (m.reductionPercent || 0), 0) / metrics.length * 100) / 100,
        avgProcessingTimeMs: Math.round(totalTime / metrics.length),
        avgQualityScore: Math.round(totalQuality / metrics.length * 10) / 10,
        bestReduction: bestReduction ? {
            fileName: bestReduction.fileName,
            reductionPercent: bestReduction.reductionPercent,
            method: bestReduction.methodUsed,
        } : null,
        strategyBreakdown,
        fileTypeBreakdown,
    };
}

/**
 * Clear all metrics (use with caution).
 */
function clearMetrics() {
    saveMetrics([]);
}

function formatBytes(bytes) {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

module.exports = {
    logOptimization,
    getMetrics,
    getStats,
    clearMetrics,
};
