/**
 * Strategy Selector — Determines optimal optimization approach.
 * Consults the learner DB for historical performance and uses
 * a decision matrix based on file type, entropy, and size.
 */
const path = require('path');

// Strategy definitions with their pipeline stages
const STRATEGIES = {
    lossless: {
        name: 'Lossless Optimization',
        stages: ['strip_metadata', 'normalize_headers', 'lossless_compress'],
        qualityImpact: 0, // No quality loss
        expectedReduction: { min: 5, max: 30 },
    },
    structural: {
        name: 'Structural Optimization',
        stages: ['strip_metadata', 'restructure_container', 'optimize_encoding'],
        qualityImpact: 1, // Negligible
        expectedReduction: { min: 10, max: 40 },
    },
    format_convert: {
        name: 'Format Conversion',
        stages: ['strip_metadata', 'convert_format', 'optimize_encoding'],
        qualityImpact: 2, // Minor
        expectedReduction: { min: 30, max: 80 },
    },
    perceptual: {
        name: 'Perceptual Compression',
        stages: ['strip_metadata', 'perceptual_compress', 'quality_tune'],
        qualityImpact: 5, // Controlled loss
        expectedReduction: { min: 40, max: 75 },
    },
    skip: {
        name: 'Skip (Already Optimal)',
        stages: [],
        qualityImpact: 0,
        expectedReduction: { min: 0, max: 0 },
    },
};

// Format conversion targets — what to convert to for best results
const CONVERSION_TARGETS = {
    bmp: { target: 'png', reason: 'Lossless compression without quality loss' },
    tiff: { target: 'png', reason: 'Better compression, wider support' },
    wav: { target: 'flac', reason: 'Lossless compression, ~50% reduction' },
    avi: { target: 'mp4', reason: 'Modern container, better compression' },
    wmv: { target: 'mp4', reason: 'Modern codec, better compression' },
    flv: { target: 'mp4', reason: 'Modern container, better support' },
};

// Quality presets per strategy level
const QUALITY_PRESETS = {
    maximum: { imageQuality: 95, audioKbps: 320, videoKbps: 8000 },
    high: { imageQuality: 85, audioKbps: 192, videoKbps: 4000 },
    balanced: { imageQuality: 80, audioKbps: 128, videoKbps: 2500 },
    aggressive: { imageQuality: 70, audioKbps: 96, videoKbps: 1500 },
};

/**
 * Select the optimal optimization strategy based on analysis report.
 *
 * @param {Object} analysisReport — from analyzer.analyze()
 * @param {Object|null} learnerHints — from learner.getHints() if available
 * @param {Object} settings — optimizer settings
 * @returns {Object} OptimizationPlan
 */
function selectStrategy(analysisReport, learnerHints = null, settings = {}) {
    const {
        fileType, format, compressionLevel, optimizationPotential,
        entropy, fileSize, recommendedStrategy
    } = analysisReport;

    const qualityThreshold = settings.optimizerQualityThreshold || 95;

    // 1. Check if learner has a better suggestion
    let selectedStrategy = recommendedStrategy;
    let qualityPreset = 'high';
    let confidence = 'default';

    if (learnerHints && learnerHints.bestStrategy) {
        const learned = learnerHints.bestStrategy;
        const learnedDef = STRATEGIES[learned];

        // Only override if learner's suggestion has enough data AND
        // its quality impact is within our threshold
        if (learnerHints.sampleCount >= 3 && learnedDef) {
            const maxAllowedImpact = 100 - qualityThreshold;
            if (learnedDef.qualityImpact <= maxAllowedImpact) {
                selectedStrategy = learned;
                confidence = 'learned';
            }
        }

        // Also adopt quality preset if learned
        if (learnerHints.bestPreset && QUALITY_PRESETS[learnerHints.bestPreset]) {
            qualityPreset = learnerHints.bestPreset;
        }
    }

    // 2. Safety overrides — never apply aggressive strategies to already-compressed
    if (compressionLevel === 'high' || compressionLevel === 'maximum') {
        if (selectedStrategy === 'perceptual' || selectedStrategy === 'format_convert') {
            selectedStrategy = 'structural'; // Downgrade to safe option
            confidence = 'safety_override';
        }
    }

    // 3. Skip trivially small files (< 1KB)
    if (fileSize < 1024) {
        selectedStrategy = 'skip';
        confidence = 'too_small';
    }

    // 4. Skip already-compressed archives
    if (fileType === 'compressed' || fileType === 'archive') {
        selectedStrategy = 'skip';
        confidence = 'already_compressed';
    }

    // 5. Adjust quality preset based on threshold
    if (qualityThreshold >= 98) {
        qualityPreset = 'maximum';
    } else if (qualityThreshold >= 90) {
        qualityPreset = qualityPreset === 'aggressive' ? 'balanced' : qualityPreset;
    }

    // 6. Build the optimization plan
    const strategyDef = STRATEGIES[selectedStrategy] || STRATEGIES.skip;
    const conversionTarget = CONVERSION_TARGETS[format] || null;
    const preset = QUALITY_PRESETS[qualityPreset];

    return {
        strategy: selectedStrategy,
        strategyName: strategyDef.name,
        stages: [...strategyDef.stages],
        qualityPreset: qualityPreset,
        qualitySettings: { ...preset },
        conversionTarget: conversionTarget,
        expectedReduction: { ...strategyDef.expectedReduction },
        confidence: confidence,
        maxRetries: 2,
        saferFallback: getSaferFallback(selectedStrategy, qualityPreset),
    };
}

/**
 * Get a safer fallback strategy for retry on quality failure.
 *
 * @param {string} currentStrategy
 * @param {string} currentPreset
 * @returns {{ strategy: string, qualityPreset: string }}
 */
function getSaferFallback(currentStrategy, currentPreset) {
    // Escalate quality, downgrade aggressiveness
    const presetEscalation = {
        'aggressive': 'balanced',
        'balanced': 'high',
        'high': 'maximum',
        'maximum': 'maximum',
    };

    const strategyDowngrade = {
        'perceptual': 'structural',
        'format_convert': 'lossless',
        'structural': 'lossless',
        'lossless': 'skip',
        'skip': 'skip',
    };

    return {
        strategy: strategyDowngrade[currentStrategy] || 'lossless',
        qualityPreset: presetEscalation[currentPreset] || 'maximum',
    };
}

module.exports = {
    selectStrategy,
    STRATEGIES,
    QUALITY_PRESETS,
    CONVERSION_TARGETS,
};
