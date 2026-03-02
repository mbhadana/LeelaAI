/**
 * Adaptive Learning Module — Deterministic self-improvement through pattern recognition.
 *
 * Tracks per-file-type performance, learns best strategies, and adjusts
 * recommendations over time. All learning is deterministic — same input
 * always produces the same recommendation.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let USER_DATA_DIR;
try {
    const { app } = require('electron');
    USER_DATA_DIR = app.getPath('userData');
} catch (e) {
    USER_DATA_DIR = path.join(os.homedir(), '.leelav1');
}

const LEARNING_FILE = path.join(USER_DATA_DIR, 'optimizer_learning.json');
const DECAY_FACTOR = 0.95; // Each new sample slightly reduces old sample weight
const MIN_SAMPLES_FOR_CONFIDENCE = 3;

/**
 * Default structure for the learning database.
 */
function getDefaultDB() {
    return {
        version: 1,
        lastUpdated: new Date().toISOString(),
        fileTypeStrategies: {},   // { 'image:png': { bestStrategy, avgReduction, ... } }
        entropyProfiles: {},      // { 'low': { bestStrategy, ... }, 'medium': { ... } }
        performanceHistory: [],   // Recent optimization outcomes for trend analysis
    };
}

/**
 * Load the learning database from disk.
 * @returns {Object}
 */
function loadDB() {
    try {
        if (fs.existsSync(LEARNING_FILE)) {
            const data = fs.readFileSync(LEARNING_FILE, 'utf8');
            const db = JSON.parse(data);
            if (db.version === 1) return db;
        }
    } catch (e) {
        console.error('[OptimizerLearner] Failed to load learning DB:', e.message);
    }
    return getDefaultDB();
}

/**
 * Save the learning database to disk.
 * @param {Object} db
 */
function saveDB(db) {
    try {
        const dir = path.dirname(LEARNING_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        db.lastUpdated = new Date().toISOString();
        fs.writeFileSync(LEARNING_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('[OptimizerLearner] Failed to save learning DB:', e.message);
    }
}

/**
 * Record an optimization result for learning.
 *
 * @param {Object} result
 * @param {string} result.fileType — e.g., 'image'
 * @param {string} result.format — e.g., 'png'
 * @param {string} result.strategy — e.g., 'lossless'
 * @param {string} result.qualityPreset — e.g., 'high'
 * @param {number} result.reductionPercent
 * @param {number} result.qualityScore
 * @param {number} result.processingTimeMs
 * @param {number} result.entropy
 * @param {boolean} result.success — whether optimization was accepted (not rolled back)
 */
function recordResult(result) {
    try {
        const db = loadDB();
        const key = `${result.fileType}:${result.format}`;
        const entropyBand = getEntropyBand(result.entropy);

        // Update file-type strategy record
        if (!db.fileTypeStrategies[key]) {
            db.fileTypeStrategies[key] = {
                strategies: {},
                totalSamples: 0,
                bestStrategy: null,
                bestPreset: null,
                bestReduction: 0,
                bestQuality: 0,
            };
        }

        const record = db.fileTypeStrategies[key];
        record.totalSamples++;

        const stratKey = result.strategy;
        if (!record.strategies[stratKey]) {
            record.strategies[stratKey] = {
                count: 0,
                totalReduction: 0,
                totalQuality: 0,
                totalTime: 0,
                successCount: 0,
                preset: result.qualityPreset,
            };
        }

        const strat = record.strategies[stratKey];
        strat.count++;
        strat.totalReduction = strat.totalReduction * DECAY_FACTOR + result.reductionPercent;
        strat.totalQuality = strat.totalQuality * DECAY_FACTOR + result.qualityScore;
        strat.totalTime = strat.totalTime * DECAY_FACTOR + result.processingTimeMs;
        if (result.success) strat.successCount++;
        strat.preset = result.qualityPreset;

        // Recalculate best strategy for this file type
        let bestScore = -1;
        for (const [sKey, sVal] of Object.entries(record.strategies)) {
            if (sVal.count < 1) continue;
            // Score = weighted combination of reduction, quality, and success rate
            const avgReduction = sVal.totalReduction / sVal.count;
            const avgQuality = sVal.totalQuality / sVal.count;
            const successRate = sVal.successCount / sVal.count;
            const score = (avgReduction * 0.4 + avgQuality * 0.4 + successRate * 100 * 0.2);
            if (score > bestScore) {
                bestScore = score;
                record.bestStrategy = sKey;
                record.bestPreset = sVal.preset;
                record.bestReduction = Math.round(avgReduction * 100) / 100;
                record.bestQuality = Math.round(avgQuality * 100) / 100;
            }
        }

        // Update entropy profiles
        if (entropyBand) {
            if (!db.entropyProfiles[entropyBand]) {
                db.entropyProfiles[entropyBand] = { strategies: {}, bestStrategy: null };
            }
            const ep = db.entropyProfiles[entropyBand];
            if (!ep.strategies[stratKey]) {
                ep.strategies[stratKey] = { count: 0, avgReduction: 0, avgQuality: 0 };
            }
            const eps = ep.strategies[stratKey];
            eps.count++;
            eps.avgReduction = (eps.avgReduction * (eps.count - 1) + result.reductionPercent) / eps.count;
            eps.avgQuality = (eps.avgQuality * (eps.count - 1) + result.qualityScore) / eps.count;

            // Update best for entropy band
            let epBest = -1;
            for (const [sKey, sVal] of Object.entries(ep.strategies)) {
                const score = sVal.avgReduction * 0.5 + sVal.avgQuality * 0.5;
                if (score > epBest) {
                    epBest = score;
                    ep.bestStrategy = sKey;
                }
            }
        }

        // Track recent performance for trend analysis (last 50 entries)
        db.performanceHistory.unshift({
            timestamp: new Date().toISOString(),
            fileType: result.fileType,
            format: result.format,
            strategy: result.strategy,
            reduction: result.reductionPercent,
            quality: result.qualityScore,
            time: result.processingTimeMs,
            success: result.success,
        });
        if (db.performanceHistory.length > 50) {
            db.performanceHistory.length = 50;
        }

        saveDB(db);
    } catch (e) {
        console.error('[OptimizerLearner] Failed to record result:', e.message);
    }
}

/**
 * Get strategy hints for a given file analysis.
 *
 * @param {Object} analysisReport — from analyzer
 * @returns {Object|null} { bestStrategy, bestPreset, sampleCount, avgReduction, avgQuality }
 */
function getHints(analysisReport) {
    try {
        const db = loadDB();
        const key = `${analysisReport.fileType}:${analysisReport.format}`;

        const record = db.fileTypeStrategies[key];
        if (record && record.totalSamples >= MIN_SAMPLES_FOR_CONFIDENCE && record.bestStrategy) {
            const bestStrat = record.strategies[record.bestStrategy];
            return {
                bestStrategy: record.bestStrategy,
                bestPreset: record.bestPreset,
                sampleCount: record.totalSamples,
                avgReduction: record.bestReduction,
                avgQuality: record.bestQuality,
                avgTimeMs: bestStrat ? Math.round(bestStrat.totalTime / bestStrat.count) : null,
                source: 'file_type',
            };
        }

        // Fallback: check entropy profile
        const entropyBand = getEntropyBand(analysisReport.entropy);
        if (entropyBand && db.entropyProfiles[entropyBand]) {
            const ep = db.entropyProfiles[entropyBand];
            if (ep.bestStrategy) {
                const eps = ep.strategies[ep.bestStrategy];
                return {
                    bestStrategy: ep.bestStrategy,
                    bestPreset: null, // No preset-level data in entropy profiles
                    sampleCount: eps ? eps.count : 0,
                    avgReduction: eps ? Math.round(eps.avgReduction * 100) / 100 : 0,
                    avgQuality: eps ? Math.round(eps.avgQuality * 100) / 100 : 0,
                    avgTimeMs: null,
                    source: 'entropy_profile',
                };
            }
        }

        return null;
    } catch (e) {
        console.error('[OptimizerLearner] Failed to get hints:', e.message);
        return null;
    }
}

/**
 * Get the learning database summary for dashboard display.
 * @returns {Object}
 */
function getLearningStats() {
    const db = loadDB();
    const totalProfiles = Object.keys(db.fileTypeStrategies).length;
    const totalSamples = Object.values(db.fileTypeStrategies).reduce((s, r) => s + r.totalSamples, 0);

    const topStrategies = Object.entries(db.fileTypeStrategies)
        .filter(([, r]) => r.bestStrategy)
        .map(([key, r]) => ({
            fileType: key,
            bestStrategy: r.bestStrategy,
            samples: r.totalSamples,
            avgReduction: r.bestReduction,
        }))
        .sort((a, b) => b.samples - a.samples)
        .slice(0, 10);

    // Trend: is optimization improving?
    const recent = db.performanceHistory.slice(0, 10);
    const older = db.performanceHistory.slice(10, 20);
    let trend = 'stable';
    if (recent.length >= 5 && older.length >= 5) {
        const recentAvg = recent.reduce((s, r) => s + r.reduction, 0) / recent.length;
        const olderAvg = older.reduce((s, r) => s + r.reduction, 0) / older.length;
        if (recentAvg > olderAvg * 1.05) trend = 'improving';
        else if (recentAvg < olderAvg * 0.95) trend = 'declining';
    }

    return {
        totalProfiles,
        totalSamples,
        topStrategies,
        trend,
        lastUpdated: db.lastUpdated,
    };
}

/**
 * Reset the learning database.
 */
function resetLearning() {
    saveDB(getDefaultDB());
    console.log('[OptimizerLearner] Learning database reset');
}

/**
 * Classify entropy into bands for pattern matching.
 * @param {number} entropy
 * @returns {string|null}
 */
function getEntropyBand(entropy) {
    if (entropy < 0) return null;
    if (entropy < 2) return 'very_low';
    if (entropy < 4) return 'low';
    if (entropy < 6) return 'medium';
    if (entropy < 7.5) return 'high';
    return 'very_high';
}

module.exports = {
    recordResult,
    getHints,
    getLearningStats,
    resetLearning,
};
