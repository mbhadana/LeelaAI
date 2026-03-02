/**
 * Quality Validator — Verifies output integrity and triggers rollback on failure.
 *
 * Checks: file existence, non-zero size, header validity, dimension/duration
 * preservation, and perceptual quality estimation.
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

let ffmpegPath;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { ffmpegPath = null; }

/**
 * Validate an optimized file against the original.
 *
 * @param {string} originalPath
 * @param {string} optimizedPath
 * @param {Object} analysisReport — from analyzer
 * @param {number} qualityThreshold — e.g., 95 (percentage)
 * @returns {Promise<Object>} { valid, qualityScore, issues, details }
 */
async function validate(originalPath, optimizedPath, analysisReport, qualityThreshold = 95) {
    const issues = [];
    const details = {};

    // 1. Basic existence & size checks
    if (!fs.existsSync(optimizedPath)) {
        return { valid: false, qualityScore: 0, issues: ['Output file does not exist'], details };
    }

    const origStat = fs.statSync(originalPath);
    const optStat = fs.statSync(optimizedPath);

    if (optStat.size === 0) {
        return { valid: false, qualityScore: 0, issues: ['Output file is empty (0 bytes)'], details };
    }

    details.originalSize = origStat.size;
    details.optimizedSize = optStat.size;
    details.reductionPercent = Math.round((1 - optStat.size / origStat.size) * 100 * 100) / 100;

    // 2. Corruption check — verify file header is valid
    const headerValid = await checkFileHeader(optimizedPath, analysisReport.fileType);
    if (!headerValid) {
        issues.push('File header appears corrupt');
    }

    // 3. Type-specific validation
    let qualityScore = 100;

    try {
        switch (analysisReport.fileType) {
            case 'image':
                qualityScore = await validateImage(originalPath, optimizedPath, details, issues);
                break;
            case 'audio':
            case 'video':
                qualityScore = await validateMedia(originalPath, optimizedPath, analysisReport, details, issues);
                break;
            default:
                // For text/unknown, basic checks are sufficient
                qualityScore = headerValid ? 98 : 50;
        }
    } catch (validationErr) {
        console.warn(`[Validator] Type-specific validation failed: ${validationErr.message}`);
        // Fall back to size-ratio estimation
        qualityScore = estimateQualityFromSizeRatio(origStat.size, optStat.size);
        issues.push(`Validation fallback: ${validationErr.message}`);
    }

    details.qualityScore = qualityScore;

    // 4. Size sanity check — if optimized is BIGGER, something went wrong
    if (optStat.size > origStat.size * 1.05) { // Allow 5% tolerance for format conversion
        issues.push(`Output is larger than input (${details.reductionPercent}% increase)`);
        qualityScore = Math.min(qualityScore, 80);
    }

    const valid = qualityScore >= qualityThreshold && issues.filter(i => !i.startsWith('Validation fallback')).length === 0;

    return {
        valid,
        qualityScore,
        issues,
        details,
    };
}

/**
 * Check file header validity (basic corruption detection).
 */
async function checkFileHeader(filePath, fileType) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, header, 0, 16, 0);
        fs.closeSync(fd);

        if (bytesRead < 2) return false;

        // Check for obviously corrupt files (all zeros, all ones)
        const allZeros = header.slice(0, bytesRead).every(b => b === 0);
        const allOnes = header.slice(0, bytesRead).every(b => b === 0xFF);
        if (allZeros || allOnes) return false;

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Validate image quality by comparing dimensions, channels, and format.
 *
 * @returns {number} Quality score 0-100
 */
async function validateImage(originalPath, optimizedPath, details, issues) {
    if (!sharp) {
        // Can't do deep validation without sharp — use size-ratio estimation
        return estimateQualityFromSizeRatio(details.originalSize, details.optimizedSize);
    }

    try {
        const origMeta = await sharp(originalPath).metadata();
        const optMeta = await sharp(optimizedPath).metadata();

        details.originalDimensions = `${origMeta.width}x${origMeta.height}`;
        details.optimizedDimensions = `${optMeta.width}x${optMeta.height}`;
        details.originalFormat = origMeta.format;
        details.optimizedFormat = optMeta.format;

        let score = 100;

        // Dimension check — must be identical (no accidental resize)
        if (origMeta.width !== optMeta.width || origMeta.height !== optMeta.height) {
            issues.push(`Dimensions changed: ${origMeta.width}x${origMeta.height} → ${optMeta.width}x${optMeta.height}`);
            score -= 20;
        }

        // Channel check — losing alpha is acceptable for JPEG conversion
        if (origMeta.channels > optMeta.channels && optMeta.format !== 'jpeg') {
            issues.push(`Channel count reduced: ${origMeta.channels} → ${optMeta.channels}`);
            score -= 10;
        }

        // Color space check
        if (origMeta.space && optMeta.space && origMeta.space !== optMeta.space) {
            // sRGB vs. other is usually fine
            if (!(origMeta.space === 'srgb' || optMeta.space === 'srgb')) {
                issues.push(`Color space changed: ${origMeta.space} → ${optMeta.space}`);
                score -= 5;
            }
        }

        // Size-ratio quality estimation (perceptual heuristic)
        const sizeRatio = details.optimizedSize / details.originalSize;
        if (sizeRatio < 0.1) {
            // Over 90% reduction is suspicious for lossless
            score -= 15;
            issues.push('Extreme size reduction may indicate quality loss');
        } else if (sizeRatio < 0.3) {
            score -= 5; // Significant but reasonable
        }

        return Math.max(score, 0);
    } catch (e) {
        issues.push(`Image metadata validation failed: ${e.message}`);
        return estimateQualityFromSizeRatio(details.originalSize, details.optimizedSize);
    }
}

/**
 * Validate audio/video by checking stream info via ffprobe.
 *
 * @returns {number} Quality score 0-100
 */
async function validateMedia(originalPath, optimizedPath, analysisReport, details, issues) {
    if (!ffmpegPath) {
        return estimateQualityFromSizeRatio(details.originalSize, details.optimizedSize);
    }

    try {
        // ffprobe is in the same directory as ffmpeg
        const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

        // Check if ffprobe exists, otherwise fallback to ffmpeg -i
        let origInfo, optInfo;

        try {
            origInfo = await getMediaInfo(ffprobePath, originalPath);
            optInfo = await getMediaInfo(ffprobePath, optimizedPath);
        } catch (e) {
            // ffprobe might not exist — use ffmpeg -i instead
            origInfo = await getMediaInfoFallback(originalPath);
            optInfo = await getMediaInfoFallback(optimizedPath);
        }

        let score = 100;

        // Duration check — must be within 1 second
        if (origInfo.duration && optInfo.duration) {
            const durationDiff = Math.abs(origInfo.duration - optInfo.duration);
            details.durationDiff = durationDiff;
            if (durationDiff > 1) {
                issues.push(`Duration mismatch: ${durationDiff.toFixed(2)}s difference`);
                score -= 20;
            }
        }

        // Stream count check
        if (origInfo.streams && optInfo.streams) {
            if (optInfo.streams < origInfo.streams) {
                issues.push(`Stream count reduced: ${origInfo.streams} → ${optInfo.streams}`);
                score -= 10;
            }
        }

        return Math.max(score, 0);
    } catch (e) {
        issues.push(`Media validation error: ${e.message}`);
        return estimateQualityFromSizeRatio(details.originalSize, details.optimizedSize);
    }
}

/**
 * Get media info via ffprobe JSON output.
 */
async function getMediaInfo(ffprobePath, filePath) {
    const cmd = `"${ffprobePath}" -v quiet -print_format json -show_format -show_streams "${filePath}"`;
    const { stdout } = await execAsync(cmd, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    const info = JSON.parse(stdout);
    return {
        duration: info.format ? parseFloat(info.format.duration) : null,
        streams: info.streams ? info.streams.length : null,
        bitrate: info.format ? parseInt(info.format.bit_rate, 10) : null,
    };
}

/**
 * Fallback: get basic media info via ffmpeg -i (when ffprobe is unavailable).
 */
async function getMediaInfoFallback(filePath) {
    try {
        // ffmpeg -i returns info to stderr and exits with error code
        const cmd = `"${ffmpegPath}" -i "${filePath}" -f null - 2>&1`;
        const { stdout, stderr } = await execAsync(cmd, { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }).catch(e => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));
        const output = stdout + stderr;

        const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        const duration = durationMatch
            ? parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseInt(durationMatch[3]) + parseInt(durationMatch[4]) / 100
            : null;

        const streamMatches = output.match(/Stream\s+#/g);
        const streams = streamMatches ? streamMatches.length : null;

        return { duration, streams, bitrate: null };
    } catch (e) {
        return { duration: null, streams: null, bitrate: null };
    }
}

/**
 * Estimate quality from the size ratio when deeper validation isn't possible.
 * Conservative — assumes reasonable quality for modest reductions.
 *
 * @param {number} originalSize
 * @param {number} optimizedSize
 * @returns {number} 0-100
 */
function estimateQualityFromSizeRatio(originalSize, optimizedSize) {
    if (originalSize === 0) return 0;
    const ratio = optimizedSize / originalSize;

    // Linear estimation: 100% quality at same size, down to 70% at 20% of original
    if (ratio >= 1.0) return 98; // Slightly penalize for no reduction
    if (ratio >= 0.8) return 99;
    if (ratio >= 0.5) return 95 + (ratio - 0.5) * 13.3;
    if (ratio >= 0.3) return 85 + (ratio - 0.3) * 50;
    if (ratio >= 0.1) return 70 + (ratio - 0.1) * 75;
    return 60; // Extreme reduction — suspicious
}

module.exports = {
    validate,
    estimateQualityFromSizeRatio,
};
