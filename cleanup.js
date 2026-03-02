const fs = require('fs');
const path = require('path');

/**
 * Cleanup utility to remove temporary video/audio files
 */
const runCleanup = (dir) => {
    try {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            if (file.startsWith('recording-') && (file.endsWith('.webm') || file.endsWith('.wav'))) {
                const filePath = path.join(dir, file);
                try {
                    fs.unlinkSync(filePath);
                    console.log(`[CLEANUP] Deleted temporary file: ${file}`);
                } catch (e) { }
            }
        });
    } catch (err) {
        console.error('[CLEANUP] Error during manual cleanup:', err);
    }
};

module.exports = {
    runCleanup,
    initCleanup: (dir) => {
        // Run an initial cleanup on startup
        runCleanup(dir);

        // Set an interval to clean every 30 minutes
        setInterval(() => {
            runCleanup(dir);
        }, 30 * 60 * 1000);
    }
};
