const os = require('os');
const path = require('path');

/**
 * PlatformHelper handles OS-specific command generation and asset paths
 * to ensure Leela V1 runs seamlessly on both Windows and macOS.
 */
class PlatformHelper {
    constructor() {
        this.platform = process.platform; // 'win32' or 'darwin'
        this.isWin = this.platform === 'win32';
        this.isMac = this.platform === 'darwin';
    }

    /**
     * Returns the command to simulate Ctrl+C (Win) or Cmd+C (Mac)
     */
    getCopyScript() {
        if (this.isWin) {
            // Windows VBScript for Ctrl+C
            return `Set WshShell = CreateObject("WScript.Shell")\nWshShell.SendKeys "^c"\n`;
        } else if (this.isMac) {
            // Mac AppleScript for Cmd+C
            return `tell application "System Events" to keystroke "c" using {command down}`;
        }
        return '';
    }

    /**
     * Returns the command to simulate Ctrl+X (Win) or Cmd+X (Mac)
     */
    getCutScript() {
        if (this.isWin) {
            // Windows VBScript for Ctrl+X
            return `Set WshShell = CreateObject("WScript.Shell")\nWshShell.SendKeys "^x"\n`;
        } else if (this.isMac) {
            // Mac AppleScript for Cmd+X
            return `tell application "System Events" to keystroke "x" using {command down}`;
        }
        return '';
    }

    /**
     * Returns the command to simulate Ctrl+V (Win) or Cmd+V (Mac)
     */
    getPasteScript() {
        if (this.isWin) {
            // Windows VBScript for Ctrl+V
            return `Set WshShell = CreateObject("WScript.Shell")\nWshShell.SendKeys "^v"\n`;
        } else if (this.isMac) {
            // Mac AppleScript for Cmd+V
            return `tell application "System Events" to keystroke "v" using {command down}`;
        }
        return '';
    }

    /**
     * Returns the command to simulate Ctrl+Z (Win) or Cmd+Z (Mac)
     */
    getUndoScript() {
        if (this.isWin) {
            // Windows VBScript for Ctrl+Z
            return `Set WshShell = CreateObject("WScript.Shell")\nWshShell.SendKeys "^z"\n`;
        } else if (this.isMac) {
            // Mac AppleScript for Cmd+Z
            return `tell application "System Events" to keystroke "z" using {command down}`;
        }
        return '';
    }

    /**
     * Returns the command to execute a script file
     */
    getExecutionCommand(scriptPath) {
        if (this.isWin) {
            return `wscript //B "${scriptPath}"`;
        } else if (this.isMac) {
            return `osascript "${scriptPath}"`;
        }
        return '';
    }

    /**
     * Returns the appropriate extension for script files
     */
    getScriptExtension() {
        return this.isWin ? 'vbs' : 'scpt';
    }

    /**
     * Returns the appropriate icon path for Tray/Windows
     */
    getIconPath(baseDir) {
        // Windows prefers .ico for taskbar/tray, Mac/Linux prefer .png
        const iconFile = this.isWin ? 'icon.ico' : 'icon.png';
        return path.join(baseDir, 'assets', iconFile);
    }
}

module.exports = new PlatformHelper();
