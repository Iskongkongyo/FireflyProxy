const fs = require("node:fs");
const path = require("node:path");

function browserCandidates() {
    if (process.env.PROXYWEB_E2E_BROWSER_PATH) return [process.env.PROXYWEB_E2E_BROWSER_PATH];
    if (process.platform === "win32") {
        return [
            path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
        ];
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium"
        ];
    }
    return [
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser"
    ];
}

function findBrowserExecutable() {
    const executablePath = browserCandidates().find(candidate => candidate && fs.existsSync(candidate));
    if (executablePath) return executablePath;
    throw new Error(
        "No Chromium browser was found. Install Chrome/Edge/Chromium or set PROXYWEB_E2E_BROWSER_PATH."
    );
}

module.exports = {
    browserCandidates,
    findBrowserExecutable
};
