/**
 * Optimization Engine — Multi-stage pipeline for file optimization.
 * Uses sharp (images) and ffmpeg (audio/video) — both already in the project.
 *
 * All operations write to temp files. Original files are NEVER modified.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

let ffmpegPath;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { ffmpegPath = null; }

const TEMP_PREFIX = 'leela_opt_';
const CHUNK_THRESHOLD = 50 * 1024 * 1024; // 50MB — switch to chunk mode
const TIMEOUT_MS = 60000; // 60s per operation

/**
 * Create a temp file path for optimization output.
 * @param {string} originalPath
 * @param {string} [newExt] Optional new extension
 * @returns {string}
 */
function getTempPath(originalPath, newExt = null) {
    const ext = newExt || path.extname(originalPath);
    const name = `${TEMP_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    return path.join(os.tmpdir(), name);
}

/**
 * Check available disk space (best-effort, Windows + Unix).
 * @returns {number} Available bytes (-1 if check fails)
 */
async function getAvailableSpace() {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execAsync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /value', { timeout: 5000 });
            const match = stdout.match(/FreeSpace=(\d+)/);
            return match ? parseInt(match[1], 10) : -1;
        } else {
            const { stdout } = await execAsync('df -k /tmp | tail -1 | awk \'{print $4}\'', { timeout: 5000 });
            return parseInt(stdout.trim(), 10) * 1024;
        }
    } catch (e) {
        return -1;
    }
}

/**
 * Strip metadata from an image using sharp.
 * @param {string} inputPath
 * @returns {Promise<string>} Output temp path
 */
async function stripImageMetadata(inputPath) {
    if (!sharp) throw new Error('sharp not available');

    const outputPath = getTempPath(inputPath);
    const metadata = await sharp(inputPath).metadata();

    let pipeline = sharp(inputPath).withMetadata(false); // Strip EXIF, ICC, etc.

    // Preserve format
    switch (metadata.format) {
        case 'png':
            pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
            break;
        case 'jpeg':
            pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
            break;
        case 'webp':
            pipeline = pipeline.webp({ quality: 90, effort: 6 });
            break;
        case 'gif':
            pipeline = pipeline.gif();
            break;
        default:
            pipeline = pipeline.png({ compressionLevel: 9 });
    }

    await pipeline.toFile(outputPath);
    return outputPath;
}

/**
 * Lossless image compression — optimize encoding without quality loss.
 * @param {string} inputPath
 * @returns {Promise<string>} Output temp path
 */
async function losslessImageCompress(inputPath) {
    if (!sharp) throw new Error('sharp not available');

    const outputPath = getTempPath(inputPath);
    const metadata = await sharp(inputPath).metadata();

    let pipeline = sharp(inputPath);

    switch (metadata.format) {
        case 'png':
            pipeline = pipeline.png({
                compressionLevel: 9,
                adaptiveFiltering: true,
                palette: metadata.channels <= 3 && metadata.width * metadata.height < 256 * 256,
            });
            break;
        case 'jpeg':
            pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true, trellisQuantisation: true });
            break;
        case 'webp':
            pipeline = pipeline.webp({ quality: 95, effort: 6, lossless: false });
            break;
        default:
            pipeline = pipeline.png({ compressionLevel: 9 });
    }

    await pipeline.toFile(outputPath);
    return outputPath;
}

/**
 * Perceptual image compression — controlled quality loss for significant size reduction.
 * @param {string} inputPath
 * @param {Object} qualitySettings
 * @returns {Promise<string>} Output temp path
 */
async function perceptualImageCompress(inputPath, qualitySettings = {}) {
    if (!sharp) throw new Error('sharp not available');

    const quality = qualitySettings.imageQuality || 80;
    const outputPath = getTempPath(inputPath, '.webp');

    await sharp(inputPath)
        .webp({ quality, effort: 6, smartSubsample: true })
        .toFile(outputPath);

    return outputPath;
}

/**
 * Convert image format (e.g., BMP → PNG, TIFF → PNG).
 * @param {string} inputPath
 * @param {string} targetFormat
 * @returns {Promise<string>} Output temp path
 */
async function convertImageFormat(inputPath, targetFormat) {
    if (!sharp) throw new Error('sharp not available');

    const extMap = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' };
    const ext = extMap[targetFormat] || '.png';
    const outputPath = getTempPath(inputPath, ext);

    let pipeline = sharp(inputPath);

    switch (targetFormat) {
        case 'png':
            pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
            break;
        case 'jpeg':
            pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
            break;
        case 'webp':
            pipeline = pipeline.webp({ quality: 90, effort: 6 });
            break;
        default:
            pipeline = pipeline.png({ compressionLevel: 9 });
    }

    await pipeline.toFile(outputPath);
    return outputPath;
}

/**
 * Strip metadata from audio/video using ffmpeg.
 * @param {string} inputPath
 * @returns {Promise<string>} Output temp path
 */
async function stripMediaMetadata(inputPath) {
    if (!ffmpegPath) throw new Error('ffmpeg not available');

    const outputPath = getTempPath(inputPath);
    const cmd = `"${ffmpegPath}" -i "${inputPath}" -map_metadata -1 -c copy -y "${outputPath}"`;
    await execAsync(cmd, { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return outputPath;
}

/**
 * Optimize audio encoding (e.g., WAV → FLAC lossless, or re-encode MP3).
 * @param {string} inputPath
 * @param {string} format
 * @param {Object} qualitySettings
 * @param {string|null} targetFormat
 * @returns {Promise<string>} Output temp path
 */
async function optimizeAudio(inputPath, format, qualitySettings = {}, targetFormat = null) {
    if (!ffmpegPath) throw new Error('ffmpeg not available');

    const kbps = qualitySettings.audioKbps || 192;
    let outputExt, codec, args;

    if (targetFormat === 'flac' || (format === 'wav' && !targetFormat)) {
        // Lossless conversion
        outputExt = '.flac';
        codec = 'flac';
        args = `-compression_level 8`;
    } else if (format === 'mp3' || targetFormat === 'mp3') {
        outputExt = '.mp3';
        codec = 'libmp3lame';
        args = `-b:a ${kbps}k`;
    } else {
        outputExt = '.m4a';
        codec = 'aac';
        args = `-b:a ${kbps}k`;
    }

    const outputPath = getTempPath(inputPath, outputExt);
    const cmd = `"${ffmpegPath}" -i "${inputPath}" -c:a ${codec} ${args} -map_metadata -1 -y "${outputPath}"`;
    await execAsync(cmd, { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return outputPath;
}

/**
 * Optimize video — re-encode with better compression settings.
 * @param {string} inputPath
 * @param {Object} qualitySettings
 * @returns {Promise<string>} Output temp path
 */
async function optimizeVideo(inputPath, qualitySettings = {}) {
    if (!ffmpegPath) throw new Error('ffmpeg not available');

    const kbps = qualitySettings.videoKbps || 2500;
    const outputPath = getTempPath(inputPath, '.mp4');

    // CRF-based encoding for quality consistency
    const crf = kbps >= 8000 ? 18 : kbps >= 4000 ? 23 : kbps >= 2500 ? 26 : 28;

    const cmd = `"${ffmpegPath}" -i "${inputPath}" -c:v libx264 -crf ${crf} -preset medium -c:a aac -b:a 128k -movflags +faststart -map_metadata -1 -y "${outputPath}"`;
    await execAsync(cmd, { timeout: TIMEOUT_MS * 5, maxBuffer: 50 * 1024 * 1024 }); // 5x timeout for video
    return outputPath;
}

/**
 * Restructure video container (move moov atom for streaming).
 * @param {string} inputPath
 * @returns {Promise<string>} Output temp path
 */
async function restructureContainer(inputPath) {
    if (!ffmpegPath) throw new Error('ffmpeg not available');

    const outputPath = getTempPath(inputPath);
    const cmd = `"${ffmpegPath}" -i "${inputPath}" -c copy -movflags +faststart -map_metadata -1 -y "${outputPath}"`;
    await execAsync(cmd, { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    return outputPath;
}

/**
 * Execute the optimization pipeline based on the plan from strategy selector.
 *
 * @param {string} filePath — original file
 * @param {Object} analysisReport — from analyzer
 * @param {Object} optimizationPlan — from strategy selector
 * @returns {Promise<Object>} { outputPath, stages, processingTimeMs }
 */
async function execute(filePath, analysisReport, optimizationPlan) {
    const startTime = Date.now();
    const stagesExecuted = [];

    if (optimizationPlan.strategy === 'skip') {
        return {
            outputPath: filePath,
            stages: [],
            processingTimeMs: Date.now() - startTime,
            skipped: true,
        };
    }

    // Space check
    const available = await getAvailableSpace();
    if (available > 0 && available < analysisReport.fileSize * 3) {
        throw new Error(`Insufficient disk space. Need ~${Math.ceil(analysisReport.fileSize * 3 / 1024 / 1024)}MB, have ${Math.ceil(available / 1024 / 1024)}MB`);
    }

    let currentPath = filePath;
    const tempFiles = []; // Track for cleanup

    try {
        for (const stage of optimizationPlan.stages) {
            const stageStart = Date.now();
            let outputPath;

            try {
                outputPath = await executeStage(
                    stage,
                    currentPath,
                    analysisReport,
                    optimizationPlan
                );

                // Verify stage output exists and is non-empty
                if (!outputPath || !fs.existsSync(outputPath)) {
                    console.warn(`[Optimizer] Stage "${stage}" produced no output, skipping`);
                    continue;
                }

                const outputStat = fs.statSync(outputPath);
                if (outputStat.size === 0) {
                    console.warn(`[Optimizer] Stage "${stage}" produced empty file, skipping`);
                    cleanupFile(outputPath);
                    continue;
                }

                // Only advance if output is smaller (or conversion)
                const inputStat = fs.statSync(currentPath);
                const isConversion = stage === 'convert_format';
                if (outputStat.size < inputStat.size || isConversion) {
                    if (currentPath !== filePath) {
                        tempFiles.push(currentPath); // Mark old temp for cleanup
                    }
                    currentPath = outputPath;
                    stagesExecuted.push({
                        stage,
                        durationMs: Date.now() - stageStart,
                        inputSize: inputStat.size,
                        outputSize: outputStat.size,
                    });
                } else {
                    // Stage didn't help — discard output
                    cleanupFile(outputPath);
                    stagesExecuted.push({
                        stage,
                        durationMs: Date.now() - stageStart,
                        skipped: true,
                        reason: 'no_improvement',
                    });
                }
            } catch (stageErr) {
                console.error(`[Optimizer] Stage "${stage}" failed: ${stageErr.message}`);
                stagesExecuted.push({
                    stage,
                    durationMs: Date.now() - stageStart,
                    error: stageErr.message,
                });
                // Continue with next stage — don't abort the whole pipeline
            }
        }
    } finally {
        // Cleanup intermediate temp files (keep final output)
        for (const tempFile of tempFiles) {
            cleanupFile(tempFile);
        }
    }

    return {
        outputPath: currentPath,
        stages: stagesExecuted,
        processingTimeMs: Date.now() - startTime,
        skipped: currentPath === filePath,
    };
}

/**
 * Execute a single optimization stage.
 */
async function executeStage(stage, inputPath, analysisReport, plan) {
    const { fileType, format } = analysisReport;
    const qs = plan.qualitySettings;
    const ct = plan.conversionTarget;

    switch (stage) {
        case 'strip_metadata':
            if (fileType === 'image') return await stripImageMetadata(inputPath);
            if (fileType === 'audio' || fileType === 'video') return await stripMediaMetadata(inputPath);
            return null;

        case 'normalize_headers':
            // For media, stripping metadata also normalizes — skip redundant step
            return null;

        case 'lossless_compress':
            if (fileType === 'image') return await losslessImageCompress(inputPath);
            return null;

        case 'restructure_container':
            if (fileType === 'video') return await restructureContainer(inputPath);
            return null;

        case 'optimize_encoding':
            if (fileType === 'image') return await losslessImageCompress(inputPath);
            if (fileType === 'audio') return await optimizeAudio(inputPath, format, qs);
            if (fileType === 'video') return await optimizeVideo(inputPath, qs);
            return null;

        case 'convert_format':
            if (fileType === 'image' && ct) return await convertImageFormat(inputPath, ct.target);
            if (fileType === 'audio' && ct) return await optimizeAudio(inputPath, format, qs, ct.target);
            if (fileType === 'video' && ct) return await optimizeVideo(inputPath, qs);
            return null;

        case 'perceptual_compress':
            if (fileType === 'image') return await perceptualImageCompress(inputPath, qs);
            if (fileType === 'video') return await optimizeVideo(inputPath, qs);
            return null;

        case 'quality_tune':
            // Applied during perceptual compression — no separate step needed
            return null;

        default:
            console.warn(`[Optimizer] Unknown stage: ${stage}`);
            return null;
    }
}

/**
 * Safely delete a temp file.
 */
function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath) && path.basename(filePath).startsWith(TEMP_PREFIX)) {
            fs.unlinkSync(filePath);
        }
    } catch (e) {
        // Silent — cleanup is best-effort
    }
}

/**
 * Cleanup all optimizer temp files (can be called periodically).
 */
function cleanupAllTemp() {
    try {
        const tmpDir = os.tmpdir();
        const files = fs.readdirSync(tmpDir);
        let cleaned = 0;
        for (const file of files) {
            if (file.startsWith(TEMP_PREFIX)) {
                try {
                    fs.unlinkSync(path.join(tmpDir, file));
                    cleaned++;
                } catch (e) { }
            }
        }
        if (cleaned > 0) {
            console.log(`[Optimizer] Cleaned ${cleaned} temp files`);
        }
    } catch (e) {
        // Silent
    }
}

module.exports = {
    execute,
    cleanupFile,
    cleanupAllTemp,
    getTempPath,
};
