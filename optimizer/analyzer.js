/**
 * Analyzer Engine — File type detection, metadata inspection, entropy analysis.
 * Produces structured analysis reports for the Strategy Selector.
 *
 * Zero external dependencies — uses magic bytes for type detection
 * and Shannon entropy for compressibility estimation.
 */
const fs = require('fs');
const path = require('path');

// Magic byte signatures for common file types
const MAGIC_SIGNATURES = [
    // Images
    { bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0, type: 'image', format: 'png', mime: 'image/png' },
    { bytes: [0xFF, 0xD8, 0xFF], offset: 0, type: 'image', format: 'jpeg', mime: 'image/jpeg' },
    { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, type: 'image', format: 'gif', mime: 'image/gif' },
    { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, type: 'image', format: 'webp', mime: 'image/webp', extra: { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 } },
    { bytes: [0x42, 0x4D], offset: 0, type: 'image', format: 'bmp', mime: 'image/bmp' },
    { bytes: [0x00, 0x00, 0x01, 0x00], offset: 0, type: 'image', format: 'ico', mime: 'image/x-icon' },

    // Audio
    { bytes: [0x49, 0x44, 0x33], offset: 0, type: 'audio', format: 'mp3', mime: 'audio/mpeg' },
    { bytes: [0xFF, 0xFB], offset: 0, type: 'audio', format: 'mp3', mime: 'audio/mpeg' },
    { bytes: [0xFF, 0xF3], offset: 0, type: 'audio', format: 'mp3', mime: 'audio/mpeg' },
    { bytes: [0x66, 0x4C, 0x61, 0x43], offset: 0, type: 'audio', format: 'flac', mime: 'audio/flac' },
    { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, type: 'audio', format: 'wav', mime: 'audio/wav', extra: { bytes: [0x57, 0x41, 0x56, 0x45], offset: 8 } },
    { bytes: [0x4F, 0x67, 0x67, 0x53], offset: 0, type: 'audio', format: 'ogg', mime: 'audio/ogg' },

    // Video
    { bytes: [0x00, 0x00, 0x00], offset: 0, type: 'video', format: 'mp4', mime: 'video/mp4', extra: { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 } },
    { bytes: [0x1A, 0x45, 0xDF, 0xA3], offset: 0, type: 'video', format: 'webm', mime: 'video/webm' },
    { bytes: [0x1A, 0x45, 0xDF, 0xA3], offset: 0, type: 'video', format: 'mkv', mime: 'video/x-matroska' },

    // Documents
    { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0, type: 'document', format: 'pdf', mime: 'application/pdf' },
    { bytes: [0x50, 0x4B, 0x03, 0x04], offset: 0, type: 'archive', format: 'zip', mime: 'application/zip' },

    // Compressed
    { bytes: [0x1F, 0x8B], offset: 0, type: 'compressed', format: 'gzip', mime: 'application/gzip' },
    { bytes: [0x42, 0x5A, 0x68], offset: 0, type: 'compressed', format: 'bzip2', mime: 'application/x-bzip2' },
];

// Extension-based fallback mapping
const EXT_MAP = {
    '.png': { type: 'image', format: 'png', mime: 'image/png' },
    '.jpg': { type: 'image', format: 'jpeg', mime: 'image/jpeg' },
    '.jpeg': { type: 'image', format: 'jpeg', mime: 'image/jpeg' },
    '.gif': { type: 'image', format: 'gif', mime: 'image/gif' },
    '.webp': { type: 'image', format: 'webp', mime: 'image/webp' },
    '.bmp': { type: 'image', format: 'bmp', mime: 'image/bmp' },
    '.ico': { type: 'image', format: 'ico', mime: 'image/x-icon' },
    '.svg': { type: 'image', format: 'svg', mime: 'image/svg+xml' },
    '.tiff': { type: 'image', format: 'tiff', mime: 'image/tiff' },
    '.tif': { type: 'image', format: 'tiff', mime: 'image/tiff' },
    '.mp3': { type: 'audio', format: 'mp3', mime: 'audio/mpeg' },
    '.wav': { type: 'audio', format: 'wav', mime: 'audio/wav' },
    '.flac': { type: 'audio', format: 'flac', mime: 'audio/flac' },
    '.ogg': { type: 'audio', format: 'ogg', mime: 'audio/ogg' },
    '.aac': { type: 'audio', format: 'aac', mime: 'audio/aac' },
    '.m4a': { type: 'audio', format: 'm4a', mime: 'audio/mp4' },
    '.wma': { type: 'audio', format: 'wma', mime: 'audio/x-ms-wma' },
    '.mp4': { type: 'video', format: 'mp4', mime: 'video/mp4' },
    '.webm': { type: 'video', format: 'webm', mime: 'video/webm' },
    '.mkv': { type: 'video', format: 'mkv', mime: 'video/x-matroska' },
    '.avi': { type: 'video', format: 'avi', mime: 'video/x-msvideo' },
    '.mov': { type: 'video', format: 'mov', mime: 'video/quicktime' },
    '.wmv': { type: 'video', format: 'wmv', mime: 'video/x-ms-wmv' },
    '.flv': { type: 'video', format: 'flv', mime: 'video/x-flv' },
    '.pdf': { type: 'document', format: 'pdf', mime: 'application/pdf' },
    '.json': { type: 'text', format: 'json', mime: 'application/json' },
    '.xml': { type: 'text', format: 'xml', mime: 'application/xml' },
    '.html': { type: 'text', format: 'html', mime: 'text/html' },
    '.css': { type: 'text', format: 'css', mime: 'text/css' },
    '.js': { type: 'text', format: 'javascript', mime: 'text/javascript' },
    '.txt': { type: 'text', format: 'text', mime: 'text/plain' },
    '.md': { type: 'text', format: 'markdown', mime: 'text/markdown' },
    '.csv': { type: 'text', format: 'csv', mime: 'text/csv' },
    '.zip': { type: 'archive', format: 'zip', mime: 'application/zip' },
    '.gz': { type: 'compressed', format: 'gzip', mime: 'application/gzip' },
    '.bz2': { type: 'compressed', format: 'bzip2', mime: 'application/x-bzip2' },
    '.tar': { type: 'archive', format: 'tar', mime: 'application/x-tar' },
    '.rar': { type: 'archive', format: 'rar', mime: 'application/x-rar-compressed' },
    '.7z': { type: 'archive', format: '7z', mime: 'application/x-7z-compressed' },
};

/**
 * Detect file type from magic bytes, with extension fallback.
 * @param {string} filePath
 * @returns {{ type: string, format: string, mime: string }}
 */
function detectFileType(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(16);
        fs.readSync(fd, header, 0, 16, 0);
        fs.closeSync(fd);

        for (const sig of MAGIC_SIGNATURES) {
            let match = true;
            for (let i = 0; i < sig.bytes.length; i++) {
                if (header[sig.offset + i] !== sig.bytes[i]) {
                    match = false;
                    break;
                }
            }

            if (match && sig.extra) {
                // Verify secondary signature
                for (let i = 0; i < sig.extra.bytes.length; i++) {
                    if (header[sig.extra.offset + i] !== sig.extra.bytes[i]) {
                        match = false;
                        break;
                    }
                }
            }

            if (match) {
                return { type: sig.type, format: sig.format, mime: sig.mime };
            }
        }
    } catch (e) {
        // Fall through to extension-based detection
    }

    // Extension-based fallback
    const ext = path.extname(filePath).toLowerCase();
    if (EXT_MAP[ext]) {
        return { ...EXT_MAP[ext] };
    }

    return { type: 'unknown', format: 'unknown', mime: 'application/octet-stream' };
}

/**
 * Calculate Shannon entropy of a file (sampled for performance on large files).
 * Returns a value between 0 (perfectly uniform) and 8 (maximum entropy).
 * Higher entropy = less compressible.
 *
 * @param {string} filePath
 * @returns {number}
 */
function calculateEntropy(filePath) {
    try {
        const stat = fs.statSync(filePath);
        const sampleSize = Math.min(stat.size, 1024 * 1024); // Sample first 1MB max

        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(sampleSize);
        fs.readSync(fd, buffer, 0, sampleSize, 0);
        fs.closeSync(fd);

        // Count byte frequencies
        const freq = new Array(256).fill(0);
        for (let i = 0; i < sampleSize; i++) {
            freq[buffer[i]]++;
        }

        // Calculate Shannon entropy
        let entropy = 0;
        for (let i = 0; i < 256; i++) {
            if (freq[i] > 0) {
                const p = freq[i] / sampleSize;
                entropy -= p * Math.log2(p);
            }
        }

        return Math.round(entropy * 1000) / 1000; // 3 decimal places
    } catch (e) {
        return -1; // Error indicator
    }
}

/**
 * Estimate metadata size by analyzing file header structures.
 * This is a heuristic — exact metadata parsing would require format-specific parsers.
 *
 * @param {string} filePath
 * @param {{ type: string, format: string }} fileInfo
 * @returns {number} Estimated metadata size in bytes
 */
function estimateMetadataSize(filePath, fileInfo) {
    try {
        const stat = fs.statSync(filePath);

        // Heuristic: metadata is typically 1-10% of file for media, near 0 for text
        switch (fileInfo.type) {
            case 'image':
                // EXIF, ICC profiles, etc. — typically 10-50KB for photos
                return Math.min(Math.floor(stat.size * 0.05), 50 * 1024);
            case 'audio':
                // ID3 tags, album art — can be significant
                return Math.min(Math.floor(stat.size * 0.03), 200 * 1024);
            case 'video':
                // Container metadata, chapter info, etc.
                return Math.min(Math.floor(stat.size * 0.02), 500 * 1024);
            case 'document':
                return Math.floor(stat.size * 0.01);
            default:
                return 0;
        }
    } catch (e) {
        return 0;
    }
}

/**
 * Determine current compression level of a file based on entropy and format.
 * Returns: 'none', 'low', 'medium', 'high', 'maximum'
 *
 * @param {number} entropy
 * @param {{ type: string, format: string }} fileInfo
 * @returns {string}
 */
function assessCompressionLevel(entropy, fileInfo) {
    // Already-compressed formats
    const highlyCompressed = ['jpeg', 'mp3', 'mp4', 'webm', 'ogg', 'aac', 'webp', 'flv'];
    const moderatelyCompressed = ['png', 'gif', 'flac'];
    const uncompressed = ['bmp', 'wav', 'tiff', 'raw', 'svg', 'text', 'json', 'csv', 'html', 'css', 'javascript', 'markdown', 'xml'];

    if (highlyCompressed.includes(fileInfo.format)) return 'high';
    if (moderatelyCompressed.includes(fileInfo.format)) return 'medium';
    if (uncompressed.includes(fileInfo.format)) return 'none';

    // Entropy-based fallback
    if (entropy >= 7.5) return 'maximum';
    if (entropy >= 6.5) return 'high';
    if (entropy >= 4.5) return 'medium';
    if (entropy >= 2.0) return 'low';
    return 'none';
}

/**
 * Estimate optimization potential as a percentage (0-100).
 * Higher = more room for improvement.
 *
 * @param {string} compressionLevel
 * @param {{ type: string, format: string }} fileInfo
 * @param {number} fileSize
 * @returns {number}
 */
function estimateOptimizationPotential(compressionLevel, fileInfo, fileSize) {
    // Already highly compressed = little room
    const potentialMap = {
        'none': 75,
        'low': 55,
        'medium': 35,
        'high': 15,
        'maximum': 5,
    };

    let base = potentialMap[compressionLevel] || 20;

    // Format-specific adjustments
    if (fileInfo.format === 'bmp') base = Math.min(base + 30, 95); // BMPs are extremely compressible
    if (fileInfo.format === 'wav') base = Math.min(base + 25, 90); // WAVs are very compressible
    if (fileInfo.format === 'png' && fileSize > 100 * 1024) base = Math.min(base + 15, 70); // Large PNGs can often be optimized
    if (fileInfo.type === 'text' && fileSize > 10 * 1024) base = Math.min(base + 10, 60); // Large text files benefit from minification

    // Small files have less absolute gain potential
    if (fileSize < 1024) base = Math.max(base - 30, 5);

    return base;
}

/**
 * Determine the recommended optimization strategy based on file analysis.
 *
 * @param {{ type: string, format: string }} fileInfo
 * @param {string} compressionLevel
 * @param {number} optimizationPotential
 * @returns {string}
 */
function recommendStrategy(fileInfo, compressionLevel, optimizationPotential) {
    if (optimizationPotential <= 5) return 'skip';

    switch (fileInfo.type) {
        case 'image':
            if (fileInfo.format === 'bmp' || fileInfo.format === 'tiff') return 'format_convert';
            if (compressionLevel === 'none' || compressionLevel === 'low') return 'lossless';
            if (compressionLevel === 'medium') return 'perceptual';
            return 'structural'; // Strip metadata, re-optimize

        case 'audio':
            if (fileInfo.format === 'wav') return 'format_convert';
            if (compressionLevel === 'none' || compressionLevel === 'low') return 'lossless';
            return 'structural';

        case 'video':
            if (compressionLevel === 'none' || compressionLevel === 'low') return 'perceptual';
            return 'structural';

        case 'text':
            return 'lossless'; // Minification/whitespace removal

        case 'compressed':
        case 'archive':
            return 'skip'; // Already compressed

        default:
            return compressionLevel === 'none' ? 'lossless' : 'skip';
    }
}

/**
 * Analyze a file and produce a structured report.
 *
 * @param {string} filePath
 * @returns {Promise<Object>} AnalysisReport
 */
async function analyze(filePath) {
    // Validate file exists and is readable
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
    }

    if (stat.size === 0) {
        throw new Error(`Empty file: ${filePath}`);
    }

    const fileInfo = detectFileType(filePath);
    const entropy = calculateEntropy(filePath);
    const metadataSize = estimateMetadataSize(filePath, fileInfo);
    const compressionLevel = assessCompressionLevel(entropy, fileInfo);
    const optimizationPotential = estimateOptimizationPotential(compressionLevel, fileInfo, stat.size);
    const strategy = recommendStrategy(fileInfo, compressionLevel, optimizationPotential);

    return {
        filePath: filePath,
        fileName: path.basename(filePath),
        fileType: fileInfo.type,
        format: fileInfo.format,
        mimeType: fileInfo.mime,
        fileSize: stat.size,
        fileSizeHuman: formatBytes(stat.size),
        encoding: fileInfo.type === 'text' ? 'utf-8' : 'binary',
        entropy: entropy,
        metadataSize: metadataSize,
        compressionLevel: compressionLevel,
        optimizationPotential: optimizationPotential,
        recommendedStrategy: strategy,
        lastModified: stat.mtime.toISOString(),
        analyzedAt: new Date().toISOString(),
    };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

module.exports = {
    analyze,
    detectFileType,
    calculateEntropy,
    formatBytes,
};
