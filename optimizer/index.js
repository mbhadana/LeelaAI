/**
 * Self-Optimizing File & Performance System — Main Orchestrator
 *
 * This is the ONLY public entry point for the optimizer subsystem.
 * All other modules are internal and should not be imported directly.
 *
 * Pipeline: analyze → strategize → optimize → validate → log → learn
 *
 * Safety guarantees:
 * - Original files are NEVER modified or deleted
 * - All work happens on temp copies
 * - Automatic rollback on quality failure
 * - Isolated error handling — never throws to caller
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const analyzer = require('./analyzer');
const strategy = require('./strategy');
const engine = require('./engine');
const validator = require('./validator');
const logger = require('./logger');
const learner = require('./learner');

// Default optimizer settings
const DEFAULT_OPTIMIZER_SETTINGS = {
    optimizerEnabled: true,
    optimizerQualityThreshold: 95,
    optimizerMaxFileSizeMB: 500,
    optimizerAutoLearn: true,
};

let optimizerSettings = { ...DEFAULT_OPTIMIZER_SETTINGS };

/**
 * Load optimizer settings from disk (merges with defaults).
 * Called once on startup and when settings change.
 */
function loadOptimizerSettings() {
    try {
        let settingsDir;
        try {
            const { app } = require('electron');
            settingsDir = app.getPath('userData');
        } catch (e) {
            settingsDir = path.join(os.homedir(), '.leelav1');
        }

        const settingsFile = path.join(settingsDir, 'optimizer_settings.json');
        if (fs.existsSync(settingsFile)) {
            const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            optimizerSettings = { ...DEFAULT_OPTIMIZER_SETTINGS, ...data };
        }
    } catch (e) {
        console.warn('[Optimizer] Failed to load settings, using defaults:', e.message);
    }
}

/**
 * Save optimizer settings to disk.
 */
function saveOptimizerSettings() {
    try {
        let settingsDir;
        try {
            const { app } = require('electron');
            settingsDir = app.getPath('userData');
        } catch (e) {
            settingsDir = path.join(os.homedir(), '.leelav1');
        }

        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }

        const settingsFile = path.join(settingsDir, 'optimizer_settings.json');
        fs.writeFileSync(settingsFile, JSON.stringify(optimizerSettings, null, 2));
    } catch (e) {
        console.error('[Optimizer] Failed to save settings:', e.message);
    }
}

// Load on module init
loadOptimizerSettings();

/**
 * MAIN API: Optimize a file through the full pipeline.
 *
 * @param {string} filePath — absolute path to the file to optimize
 * @param {Object} [options] — override options
 * @param {number} [options.qualityThreshold] — override quality threshold (0-100)
 * @param {string} [options.forceStrategy] — force a specific strategy
 * @param {Function} [options.onProgress] — progress callback: (stage, percent, message)
 * @returns {Promise<Object>} OptimizationResult
 */
async function optimizeFile(filePath, options = {}) {
    const startTime = Date.now();
    const progress = options.onProgress || (() => { });

    // Guard: check if optimizer is enabled
    if (!optimizerSettings.optimizerEnabled) {
        return createResult(filePath, null, null, null, {
            skipped: true,
            reason: 'Optimizer disabled in settings',
            processingTimeMs: Date.now() - startTime,
        });
    }

    try {
        // ── Stage 1: Analyze ──────────────────────────────────────
        progress('analyze', 10, 'Analyzing file...');
        const analysisReport = await analyzer.analyze(filePath);

        // Guard: file size limit
        const maxSize = (optimizerSettings.optimizerMaxFileSizeMB || 500) * 1024 * 1024;
        if (analysisReport.fileSize > maxSize) {
            return createResult(filePath, analysisReport, null, null, {
                skipped: true,
                reason: `File exceeds size limit (${analysisReport.fileSizeHuman} > ${optimizerSettings.optimizerMaxFileSizeMB}MB)`,
                processingTimeMs: Date.now() - startTime,
            });
        }

        // ── Stage 2: Strategize ───────────────────────────────────
        progress('strategize', 20, 'Selecting optimization strategy...');

        // Get learned hints
        const hints = optimizerSettings.optimizerAutoLearn ? learner.getHints(analysisReport) : null;

        // Select strategy (or use forced override)
        let optimizationPlan;
        if (options.forceStrategy) {
            optimizationPlan = strategy.selectStrategy(
                { ...analysisReport, recommendedStrategy: options.forceStrategy },
                hints,
                optimizerSettings
            );
        } else {
            optimizationPlan = strategy.selectStrategy(analysisReport, hints, optimizerSettings);
        }

        // Check if strategy says skip
        if (optimizationPlan.strategy === 'skip') {
            const result = createResult(filePath, analysisReport, optimizationPlan, null, {
                skipped: true,
                reason: `Strategy: ${optimizationPlan.confidence}`,
                processingTimeMs: Date.now() - startTime,
            });

            // Log skipped optimization too
            logger.logOptimization({
                originalPath: filePath,
                originalSize: analysisReport.fileSize,
                optimizedSize: analysisReport.fileSize,
                processingTimeMs: result.processingTimeMs,
                qualityScore: 100,
                methodUsed: 'skip',
                fileType: analysisReport.fileType,
                format: analysisReport.format,
                skipped: true,
            });

            return result;
        }

        // ── Stage 3: Optimize ─────────────────────────────────────
        progress('optimize', 40, `Optimizing with ${optimizationPlan.strategyName}...`);

        let engineResult = await engine.execute(filePath, analysisReport, optimizationPlan);
        let currentOutputPath = engineResult.outputPath;
        let retryCount = 0;
        let qualityThreshold = options.qualityThreshold || optimizerSettings.optimizerQualityThreshold || 95;

        // ── Stage 4: Validate ─────────────────────────────────────
        progress('validate', 70, 'Validating output quality...');

        let validationResult = null;
        let accepted = false;

        while (retryCount <= optimizationPlan.maxRetries) {
            if (currentOutputPath === filePath) {
                // Engine skipped — nothing to validate
                accepted = true;
                validationResult = { valid: true, qualityScore: 100, issues: [], details: {} };
                break;
            }

            validationResult = await validator.validate(
                filePath, currentOutputPath, analysisReport, qualityThreshold
            );

            if (validationResult.valid) {
                accepted = true;
                break;
            }

            // Quality failure — try safer settings
            retryCount++;
            if (retryCount <= optimizationPlan.maxRetries) {
                progress('retry', 40 + retryCount * 10, `Quality below threshold. Retrying with safer settings (${retryCount}/${optimizationPlan.maxRetries})...`);
                console.warn(`[Optimizer] Quality ${validationResult.qualityScore}% < ${qualityThreshold}%. Retrying (${retryCount}/${optimizationPlan.maxRetries})...`);

                // Clean up failed output
                engine.cleanupFile(currentOutputPath);

                // Apply safer fallback
                const fallback = optimizationPlan.saferFallback;
                optimizationPlan = strategy.selectStrategy(
                    { ...analysisReport, recommendedStrategy: fallback.strategy },
                    null, // Don't use learner hints for retry
                    { ...optimizerSettings, optimizerQualityThreshold: qualityThreshold }
                );
                optimizationPlan.qualityPreset = fallback.qualityPreset;
                optimizationPlan.qualitySettings = strategy.QUALITY_PRESETS[fallback.qualityPreset];

                engineResult = await engine.execute(filePath, analysisReport, optimizationPlan);
                currentOutputPath = engineResult.outputPath;
            }
        }

        // ── Stage 5: Rollback if still failed ─────────────────────
        if (!accepted) {
            progress('rollback', 90, 'Rolling back — quality below threshold');
            console.warn(`[Optimizer] All retries failed. Rolling back.`);
            engine.cleanupFile(currentOutputPath);
            currentOutputPath = filePath;

            // Log the rollback
            logger.logOptimization({
                originalPath: filePath,
                originalSize: analysisReport.fileSize,
                optimizedSize: analysisReport.fileSize,
                processingTimeMs: Date.now() - startTime,
                qualityScore: validationResult?.qualityScore || 0,
                methodUsed: optimizationPlan.strategyName,
                fileType: analysisReport.fileType,
                format: analysisReport.format,
                rolledBack: true,
            });

            // Record failure in learner
            if (optimizerSettings.optimizerAutoLearn) {
                learner.recordResult({
                    fileType: analysisReport.fileType,
                    format: analysisReport.format,
                    strategy: optimizationPlan.strategy,
                    qualityPreset: optimizationPlan.qualityPreset,
                    reductionPercent: 0,
                    qualityScore: validationResult?.qualityScore || 0,
                    processingTimeMs: Date.now() - startTime,
                    entropy: analysisReport.entropy,
                    success: false,
                });
            }

            return createResult(filePath, analysisReport, optimizationPlan, validationResult, {
                outputPath: filePath,
                rolledBack: true,
                retries: retryCount,
                processingTimeMs: Date.now() - startTime,
            });
        }

        // ── Stage 6: Log & Learn ──────────────────────────────────
        progress('complete', 95, 'Logging results...');

        const optimizedSize = currentOutputPath !== filePath
            ? fs.statSync(currentOutputPath).size
            : analysisReport.fileSize;

        const logEntry = logger.logOptimization({
            originalPath: filePath,
            originalSize: analysisReport.fileSize,
            optimizedSize: optimizedSize,
            processingTimeMs: Date.now() - startTime,
            qualityScore: validationResult?.qualityScore || 100,
            methodUsed: optimizationPlan.strategyName,
            fileType: analysisReport.fileType,
            format: analysisReport.format,
            stages: engineResult.stages,
        });

        // Record success in learner
        if (optimizerSettings.optimizerAutoLearn) {
            learner.recordResult({
                fileType: analysisReport.fileType,
                format: analysisReport.format,
                strategy: optimizationPlan.strategy,
                qualityPreset: optimizationPlan.qualityPreset,
                reductionPercent: logEntry?.reductionPercent || 0,
                qualityScore: validationResult?.qualityScore || 100,
                processingTimeMs: Date.now() - startTime,
                entropy: analysisReport.entropy,
                success: true,
            });
        }

        progress('done', 100, 'Optimization complete!');

        return createResult(filePath, analysisReport, optimizationPlan, validationResult, {
            outputPath: currentOutputPath,
            optimizedSize,
            reductionPercent: logEntry?.reductionPercent || 0,
            retries: retryCount,
            stages: engineResult.stages,
            processingTimeMs: Date.now() - startTime,
        });

    } catch (error) {
        console.error(`[Optimizer] Pipeline error: ${error.message}`);

        return createResult(filePath, null, null, null, {
            error: error.message,
            processingTimeMs: Date.now() - startTime,
        });
    }
}

/**
 * Analyze a file without optimizing.
 *
 * @param {string} filePath
 * @returns {Promise<Object>} AnalysisReport
 */
async function analyzeFile(filePath) {
    try {
        return await analyzer.analyze(filePath);
    } catch (error) {
        return { error: error.message };
    }
}

/**
 * Get optimizer statistics.
 * @returns {Object}
 */
function getOptimizerStats() {
    try {
        return {
            metrics: logger.getStats(),
            learning: learner.getLearningStats(),
        };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * Get optimizer metrics history.
 * @returns {Array}
 */
function getOptimizerMetrics() {
    return logger.getMetrics();
}

/**
 * Get current optimizer settings.
 * @returns {Object}
 */
function getOptimizerSettings() {
    return { ...optimizerSettings };
}

/**
 * Update optimizer settings.
 * @param {Object} newSettings
 * @returns {Object} Updated settings
 */
function updateOptimizerSettings(newSettings) {
    optimizerSettings = { ...optimizerSettings, ...newSettings };
    saveOptimizerSettings();
    return { ...optimizerSettings };
}

/**
 * Reset the learning database.
 */
function resetLearning() {
    learner.resetLearning();
}

/**
 * Cleanup all optimizer temp files.
 */
function cleanup() {
    engine.cleanupAllTemp();
}

/**
 * Construct a standardized result object.
 */
function createResult(originalPath, analysis, plan, validation, extra = {}) {
    const originalSize = analysis?.fileSize || (fs.existsSync(originalPath) ? fs.statSync(originalPath).size : 0);

    return {
        success: !extra.error && !extra.rolledBack && !extra.skipped,
        originalPath,
        outputPath: extra.outputPath || originalPath,
        originalSize,
        originalSizeHuman: analyzer.formatBytes(originalSize),
        optimizedSize: extra.optimizedSize || originalSize,
        optimizedSizeHuman: analyzer.formatBytes(extra.optimizedSize || originalSize),
        reductionPercent: extra.reductionPercent || 0,
        processingTimeMs: extra.processingTimeMs || 0,
        qualityScore: validation?.qualityScore || (extra.skipped ? 100 : 0),
        strategy: plan?.strategyName || 'none',
        confidence: plan?.confidence || 'none',
        retries: extra.retries || 0,
        stages: extra.stages || [],
        skipped: extra.skipped || false,
        rolledBack: extra.rolledBack || false,
        error: extra.error || null,
        reason: extra.reason || null,
        analysis: analysis || null,
        validation: validation ? { qualityScore: validation.qualityScore, issues: validation.issues } : null,
    };
}

module.exports = {
    optimizeFile,
    analyzeFile,
    getOptimizerStats,
    getOptimizerMetrics,
    getOptimizerSettings,
    updateOptimizerSettings,
    resetLearning,
    cleanup,
};
