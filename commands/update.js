const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const settings = require('../settings');
const isOwnerOrSudo = require('../lib/isOwner');

// ============================================
// COMMAND RUNNER - Safe execution with timeout
// ============================================
function run(cmd, timeout = 60000) {
    return new Promise((resolve, reject) => {
        const child = exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || stdout || err.message || '').toString()));
            resolve((stdout || '').toString());
        });
        
        // Timeout safeguard - agar command zyada time le to kill kar do
        setTimeout(() => {
            child.kill();
            reject(new Error(`Command timeout after ${timeout}ms: ${cmd.substring(0, 50)}...`));
        }, timeout);
    });
}

// ============================================
// CHECK IF GIT REPO EXISTS
// ============================================
async function hasGitRepo() {
    const gitDir = path.join(process.cwd(), '.git');
    if (!fs.existsSync(gitDir)) return false;
    try {
        await run('git --version');
        return true;
    } catch {
        return false;
    }
}

// ============================================
// UPDATE VIA GIT
// ============================================
async function updateViaGit() {
    const oldRev = (await run('git rev-parse HEAD').catch(() => 'unknown')).trim();
    await run('git fetch --all --prune');
    const newRev = (await run('git rev-parse origin/main')).trim();
    const alreadyUpToDate = oldRev === newRev;

    const commits = alreadyUpToDate
        ? ''
        : await run(`git log --pretty=format:"%h %s (%an)" ${oldRev}..${newRev}`).catch(() => '');

    const files = alreadyUpToDate
        ? ''
        : await run(`git diff --name-status ${oldRev} ${newRev}`).catch(() => '');

    await run(`git reset --hard ${newRev}`);
    await run('git clean -fd');

    return { oldRev, newRev, alreadyUpToDate, commits, files };
}

// ============================================
// DOWNLOAD FILE WITH REDIRECT HANDLING
// ============================================
function downloadFile(url, dest, visited = new Set()) {
    return new Promise((resolve, reject) => {
        try {
            if (visited.has(url) || visited.size > 5) {
                return reject(new Error('Too many redirects'));
            }

            visited.add(url);

            const useHttps = url.startsWith('https://');
            const client = useHttps ? require('https') : require('http');

            const req = client.get(url, {
                headers: {
                    'User-Agent': 'CODE-BREAKER-Updater/1.0',
                    'Accept': '*/*'
                },
                timeout: 30000 // 30 second timeout
            }, res => {

                if ([301,302,303,307,308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    if (!location) return reject(new Error(`HTTP ${res.statusCode} without Location`));

                    const nextUrl = new URL(location, url).toString();
                    res.resume();

                    return downloadFile(nextUrl, dest, visited)
                        .then(resolve)
                        .catch(reject);
                }

                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const file = fs.createWriteStream(dest);

                res.pipe(file);

                file.on('finish', () => file.close(resolve));

                file.on('error', err => {
                    try { file.close(() => {}); } catch {}
                    fs.unlink(dest, () => reject(err));
                });

            });

            req.on('error', err => {
                fs.unlink(dest, () => reject(err));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Download timeout'));
            });

        } catch (e) {
            reject(e);
        }
    });
}

// ============================================
// EXTRACT ZIP FILE (Cross-platform)
// ============================================
async function extractZip(zipPath, outDir) {

    if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir.replace(/\\/g,'/')}' -Force"`;
        await run(cmd);
        return;
    }

    try {
        await run('command -v unzip');
        await run(`unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}

    try {
        await run('command -v 7z');
        await run(`7z x -y '${zipPath}' -o'${outDir}'`);
        return;
    } catch {}

    try {
        await run('busybox unzip -h');
        await run(`busybox unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}

    throw new Error("No system unzip tool found");
}

// ============================================
// COPY FILES RECURSIVELY (Async version)
// ============================================
async function copyRecursive(src, dest, ignore = [], relative = '', outList = []) {
    if (!fs.existsSync(dest)) await fs.promises.mkdir(dest, { recursive: true });

    const entries = await fs.promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        if (ignore.includes(entry.name)) continue;

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await copyRecursive(
                srcPath,
                destPath,
                ignore,
                path.join(relative, entry.name),
                outList
            );
        } else {
            await fs.promises.copyFile(srcPath, destPath);
            if (outList)
                outList.push(path.join(relative, entry.name).replace(/\\/g, '/'));
        }
    }
}

// ============================================
// UPDATE VIA ZIP DOWNLOAD
// ============================================
async function updateViaZip(sock, chatId, message, zipOverride) {

    const zipUrl = (zipOverride || settings.updateZipUrl || process.env.UPDATE_ZIP_URL || '').trim();

    if (!zipUrl)
        throw new Error('No ZIP URL configured.');

    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir))
        await fs.promises.mkdir(tmpDir, { recursive: true });

    const zipPath = path.join(tmpDir, 'update.zip');
    await downloadFile(zipUrl, zipPath);

    const extractTo = path.join(tmpDir, 'update_extract');
    if (fs.existsSync(extractTo))
        await fs.promises.rm(extractTo, { recursive: true, force: true });

    await extractZip(zipPath, extractTo);

    const [root] = await fs.promises.readdir(extractTo).then(files => files.map(n => path.join(extractTo, n)));

    const srcRoot = fs.existsSync(root) && (await fs.promises.lstat(root)).isDirectory() ? root : extractTo;

    const ignore = ['node_modules', '.git', 'session', 'tmp', 'data', 'baileys_store.json'];
    const copied = [];

    await copyRecursive(srcRoot, process.cwd(), ignore, '', copied);

    // Cleanup
    try { await fs.promises.rm(extractTo, { recursive: true, force: true }); } catch {}
    try { await fs.promises.rm(zipPath, { force: true }); } catch {}

    return { copiedFiles: copied };
}

// ============================================
// DELAY FUNCTION
// ============================================
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// RESTART PROCESS - YAHAN HAI SABSE IMPORTANT CHANGE
// ============================================
async function restartProcess(sock, chatId, message) {
    try {
        // Pehle update complete ka message bhejo
        await sock.sendMessage(chatId, { 
            text: '✅ *UPDATE COMPLETE!* ✅\n\n' +
                  '⚠️ *Hosting provider ki vajah se bot automatically restart nahi ho raha.*\n\n' +
                  '👉 *Kripya hosting panel mein jakar MANUAL RESTART karein.*\n' +
                  '👉 Restart ke baad naye features kaam karenge.\n\n' +
                  '🔴 Bot abhi band ho raha hai...'
        }, { quoted: message });
    } catch {}
    
    console.log('🔄 Update completed. Exiting process - manual restart required.');
    
    // Thoda delay do message send hone ke liye
    await delay(3000);
    
    // ===== FUTURE FIX =====
    // Jab hosting provider crash detection enable kar de, to ye line uncomment kar do
    // Tab automatic restart kaam karega
    
    // setTimeout(() => process.exit(0), 2000);  // <-- ISKO UNCOMMENT KARO JAB HOSTING FIX HO JAYE
    
    // Abhi ke liye - process exit karo (server band hoga)
    process.exit(0);
}

// ============================================
// MAIN UPDATE COMMAND
// ============================================
async function updateCommand(sock, chatId, message, zipOverride) {

    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

    // Sirf owner ya sudo user hi update kar sakta hai
    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owner or sudo can use .update' }, { quoted: message });
        return;
    }

    try {
        // Update start message
        await sock.sendMessage(chatId, { text: '🔄 *Updating the bot, please wait...*\n⏱️ This may take a few minutes.' }, { quoted: message });

        let updateResult;
        
        // Check if git repo exists
        if (await hasGitRepo()) {
            // Git se update
            updateResult = await updateViaGit();
            const { oldRev, newRev, alreadyUpToDate } = updateResult;
            
            const summary = alreadyUpToDate ? `✅ Already up to date: ${newRev}` : `✅ Updated from ${oldRev} to ${newRev}`;
            console.log('[update]', summary);
            
            // Dependencies install karo
            await sock.sendMessage(chatId, { text: '📦 Installing dependencies...' }, { quoted: message });
            await run('npm install --no-audit --no-fund');
            
        } else {
            // ZIP se update
            await sock.sendMessage(chatId, { text: '📥 Downloading update via ZIP...' }, { quoted: message });
            updateResult = await updateViaZip(sock, chatId, message, zipOverride);
            
            // Dependencies install karo
            await sock.sendMessage(chatId, { text: '📦 Installing dependencies...' }, { quoted: message });
            await run('npm install --no-audit --no-fund');
        }

        // Ab restart process call karo
        await restartProcess(sock, chatId, message);

    } catch (err) {
        console.error('Update failed:', err);
        
        // Error message bhejo
        await sock.sendMessage(chatId, { 
            text: `❌ *Update Failed*\n\nError: ${String(err.message || err)}\n\nPlease try again or contact admin.` 
        }, { quoted: message });
    }
}

module.exports = updateCommand;           reject(e);
        }
    });
}

async function extractZip(zipPath, outDir) {

    if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir.replace(/\\/g,'/')}' -Force"`;
        await run(cmd);
        return;
    }

    try {
        await run('command -v unzip');
        await run(`unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}

    try {
        await run('command -v 7z');
        await run(`7z x -y '${zipPath}' -o'${outDir}'`);
        return;
    } catch {}

    try {
        await run('busybox unzip -h');
        await run(`busybox unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}

    throw new Error("No system unzip tool found");
}

function copyRecursive(src, dest, ignore = [], relative = '', outList = []) {

    if (!fs.existsSync(dest)) fs.mkdirSync(dest,{recursive:true});

    for (const entry of fs.readdirSync(src)) {

        if (ignore.includes(entry)) continue;

        const s = path.join(src, entry);
        const d = path.join(dest, entry);

        const stat = fs.lstatSync(s);

        if (stat.isDirectory()) {

            copyRecursive(
                s,
                d,
                ignore,
                path.join(relative, entry),
                outList
            );

        } else {

            fs.copyFileSync(s, d);

            if (outList)
                outList.push(path.join(relative, entry).replace(/\\/g,'/'));
        }
    }
}

async function updateViaZip(sock, chatId, message, zipOverride) {

    const zipUrl =
        (zipOverride || settings.updateZipUrl || process.env.UPDATE_ZIP_URL || '').trim();

    if (!zipUrl)
        throw new Error('No ZIP URL configured.');

    const tmpDir = path.join(process.cwd(), 'tmp');

    if (!fs.existsSync(tmpDir))
        fs.mkdirSync(tmpDir,{recursive:true});

    const zipPath = path.join(tmpDir, 'update.zip');

    await downloadFile(zipUrl, zipPath);

    const extractTo = path.join(tmpDir, 'update_extract');

    if (fs.existsSync(extractTo))
        fs.rmSync(extractTo,{recursive:true,force:true});

    await extractZip(zipPath, extractTo);

    const [root] = fs.readdirSync(extractTo).map(n => path.join(extractTo,n));

    const srcRoot =
        fs.existsSync(root) && fs.lstatSync(root).isDirectory()
            ? root
            : extractTo;

    const ignore = [
        'node_modules',
        '.git',
        'session',
        'tmp',
        'data',
        'baileys_store.json'
    ];

    const copied = [];

    copyRecursive(srcRoot, process.cwd(), ignore, '', copied);

    try { fs.rmSync(extractTo,{recursive:true,force:true}); } catch {}
    try { fs.rmSync(zipPath,{force:true}); } catch {}

    return { copiedFiles: copied };
}

async function restartProcess(sock, chatId, message) {

    try {
        await sock.sendMessage(
            chatId,
            { text: '✅ Update complete! Restarting…' },
            { quoted: message }
        );
    } catch {}

    try {
        await run('pm2 restart all');
        return;
    } catch {}

    setTimeout(()=>{
        process.exit(1);
    },1500);
}

async function updateCommand(sock, chatId, message, zipOverride) {

    const senderId = message.key.participant || message.key.remoteJid;

    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(
            chatId,
            { text:'Only bot owner or sudo can use .update' },
            { quoted:message }
        );
        return;
    }

    try {

        await sock.sendMessage(
            chatId,
            { text:'🔄 Updating the bot, please wait…' },
            { quoted:message }
        );

        if (await hasGitRepo()) {

            const { oldRev,newRev,alreadyUpToDate } = await updateViaGit();

            const summary =
                alreadyUpToDate
                    ? `✅ Already up to date: ${newRev}`
                    : `✅ Updated to ${newRev}`;

            console.log('[update]', summary);

            await run('npm install --no-audit --no-fund');

        } else {

            await updateViaZip(sock,chatId,message,zipOverride);

        }

        await sock.sendMessage(
            chatId,
            { text:'✅ Update done. Restarting…' },
            { quoted:message }
        );

        await restartProcess(sock,chatId,message);

    } catch(err) {

        console.error('Update failed:',err);

        await sock.sendMessage(
            chatId,
            { text:`❌ Update failed:\n${String(err.message || err)}` },
            { quoted:message }
        );
    }
}

module.exports = updateCommand;
    const files = alreadyUpToDate
        ? ''
        : await run(`git diff --name-status ${oldRev} ${newRev}`).catch(() => '');

    await run(`git reset --hard ${newRev}`);
    await run('git clean -fd');

    return { oldRev, newRev, alreadyUpToDate, commits, files };
}

function downloadFile(url, dest, visited = new Set()) {
    return new Promise((resolve, reject) => {
        try {
            if (visited.has(url) || visited.size > 5) {
                return reject(new Error('Too many redirects'));
            }

            visited.add(url);

            const useHttps = url.startsWith('https://');
            const client = useHttps ? require('https') : require('http');

            const req = client.get(url, {
                headers: {
                    'User-Agent': 'dexBotmd-Updater/1.0',
                    'Accept': '*/*'
                }
            }, res => {

                if ([301,302,303,307,308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    if (!location) return reject(new Error(`HTTP ${res.statusCode} without Location`));

                    const nextUrl = new URL(location, url).toString();
                    res.resume();

                    return downloadFile(nextUrl, dest, visited)
                        .then(resolve)
                        .catch(reject);
                }

                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const file = fs.createWriteStream(dest);

                res.pipe(file);

                file.on('finish', () => file.close(resolve));

                file.on('error', err => {
                    try { file.close(() => {}); } catch {}
                    fs.unlink(dest, () => reject(err));
                });

            });

            req.on('error', err => {
                fs.unlink(dest, () => reject(err));
            });

        } catch (e) {
            reject(e);
        }
    });
}

async function extractZip(zipPath, outDir) {

    if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir.replace(/\\/g,'/')}' -Force"`;
        await run(cmd);
        return;
    }

    try {
        await run('command -v unzip');
        await run(`unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}

    try {
        await run('command -v 7z');
        await run(`7z x -y '${zipPath}' -o'${outDir}'`);
        return;
    } catch {}

    try {
        await run('busybox unzip -h');
        await run(`busybox unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}

    throw new Error("No system unzip tool found");
}

function copyRecursive(src, dest, ignore = [], relative = '', outList = []) {

    if (!fs.existsSync(dest)) fs.mkdirSync(dest,{recursive:true});

    for (const entry of fs.readdirSync(src)) {

        if (ignore.includes(entry)) continue;

        const s = path.join(src, entry);
        const d = path.join(dest, entry);

        const stat = fs.lstatSync(s);

        if (stat.isDirectory()) {

            copyRecursive(
                s,
                d,
                ignore,
                path.join(relative, entry),
                outList
            );

        } else {

            fs.copyFileSync(s, d);

            if (outList)
                outList.push(path.join(relative, entry).replace(/\\/g,'/'));
        }
    }
}

async function updateViaZip(sock, chatId, message, zipOverride) {

    const zipUrl =
        (zipOverride || settings.updateZipUrl || process.env.UPDATE_ZIP_URL || '').trim();

    if (!zipUrl)
        throw new Error('No ZIP URL configured.');

    const tmpDir = path.join(process.cwd(), 'tmp');

    if (!fs.existsSync(tmpDir))
        fs.mkdirSync(tmpDir,{recursive:true});

    const zipPath = path.join(tmpDir, 'update.zip');

    await downloadFile(zipUrl, zipPath);

    const extractTo = path.join(tmpDir, 'update_extract');

    if (fs.existsSync(extractTo))
        fs.rmSync(extractTo,{recursive:true,force:true});

    await extractZip(zipPath, extractTo);

    const [root] = fs.readdirSync(extractTo).map(n => path.join(extractTo,n));

    const srcRoot =
        fs.existsSync(root) && fs.lstatSync(root).isDirectory()
            ? root
            : extractTo;

    const ignore = [
        'node_modules',
        '.git',
        'session',
        'tmp',
        'data',
        'baileys_store.json'
    ];

    const copied = [];

    copyRecursive(srcRoot, process.cwd(), ignore, '', copied);

    try { fs.rmSync(extractTo,{recursive:true,force:true}); } catch {}
    try { fs.rmSync(zipPath,{force:true}); } catch {}

    return { copiedFiles: copied };
}

async function restartProcess(sock, chatId, message) {

    try {
        await sock.sendMessage(
            chatId,
            { text: '✅ Update complete! Restarting…' },
            { quoted: message }
        );
    } catch {}

    try {
        await run('pm2 restart all');
        return;
    } catch {}

    setTimeout(()=>{
        process.exit(0);
    },500);
}

async function updateCommand(sock, chatId, message, zipOverride) {

    const senderId = message.key.participant || message.key.remoteJid;

    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(
            chatId,
            { text:'Only bot owner or sudo can use .update' },
            { quoted:message }
        );
        return;
    }

    try {

        await sock.sendMessage(
            chatId,
            { text:'🔄 Updating the bot, please wait…' },
            { quoted:message }
        );

        if (await hasGitRepo()) {

            const { oldRev,newRev,alreadyUpToDate } = await updateViaGit();

            const summary =
                alreadyUpToDate
                    ? `✅ Already up to date: ${newRev}`
                    : `✅ Updated to ${newRev}`;

            console.log('[update]', summary);

            await run('npm install --no-audit --no-fund');

        } else {

            await updateViaZip(sock,chatId,message,zipOverride);

        }

        await sock.sendMessage(
            chatId,
            { text:'✅ Update done. Restarting…' },
            { quoted:message }
        );

        await restartProcess(sock,chatId,message);

    } catch(err) {

        console.error('Update failed:',err);

        await sock.sendMessage(
            chatId,
            { text:`❌ Update failed:\n${String(err.message || err)}` },
            { quoted:message }
        );
    }
}

module.exports = updateCommand;Ab latest version pull kar raha hun...' }, { quoted: message });
}

async function updateViaGit() {
    await run('git fetch --all --prune');
    const newRev = (await run('git rev-parse origin/main')).trim();
    
    await run(`git reset --hard ${newRev}`);
    await run('git clean -fd');
    ensureTmpFolder();

    // 🔥 VERSION CHANGE REFLECT (cache clear)
    delete require.cache[require.resolve('../settings')];
    
    return newRev;
}

async function updateCommand(sock, chatId, message) {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
    
    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Sirf owner ya sudo use kar sakta hai' }, { quoted: message });
        return;
    }

    try {
        await sock.sendMessage(chatId, { text: '🔄 Updating the bot, please wait…' }, { quoted: message });

        ensureTmpFolder();

        if (!(await hasGitRepo())) {
            await setupGitRepo(sock, chatId, message);
        }

        const newRev = await updateViaGit();
        await run('npm install --no-audit --no-fund');

        // New version load karo (GitHub se aaya hua)
        const newVersion = require('../settings').version || `git-${newRev.substring(0,7)}`;

        await sock.sendMessage(chatId, { 
            text: `✅ Bot successfully updated!\nNew Version: ${newVersion}\n\nRestarting... .ping daal ke check kar lena` 
        }, { quoted: message });

        await run('pm2 restart all').catch(() => {});
        setTimeout(() => process.exit(1), 2000);

    } catch (err) {
        await sock.sendMessage(chatId, { 
            text: `❌ Update failed:\n${String(err.message).substring(0, 300)}` 
        }, { quoted: message });
    }
}

module.exports = updateCommand;e to flush.
    setTimeout(() => {
        process.exit(1);
    }, 3000);
}

async function updateCommand(sock, chatId, message, zipOverride) {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
    
    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(chatId, { text: 'Only bot owner or sudo can use .update' }, { quoted: message });
        return;
    }
    try {
        // Minimal UX
        await sock.sendMessage(chatId, { text: '🔄 Updating the bot, please wait…' }, { quoted: message });
        if (await hasGitRepo()) {
            // silent
            const { oldRev, newRev, alreadyUpToDate, commits, files } = await updateViaGit();
            // Short message only: version info
            const summary = alreadyUpToDate ? `✅ Already up to date: ${newRev}` : `✅ Updated to ${newRev}`;
            console.log('[update] summary generated');
            // silent
            await run('npm install --no-audit --no-fund');
        } else {
            const { copiedFiles } = await updateViaZip(sock, chatId, message, zipOverride);
            // silent
        }
        try {
            const v = require('../settings').version || '';
            await sock.sendMessage(chatId, { text: `✅ Update done. Restarting…` }, { quoted: message });
        } catch {
            await sock.sendMessage(chatId, { text: '✅ Restared Successfully\n Type .ping to check latest version.' }, { quoted: message });
        }
        await restartProcess(sock, chatId, message);
    } catch (err) {
        console.error('Update failed:', err);
        await sock.sendMessage(chatId, { text: `❌ Update failed:\n${String(err.message || err)}` }, { quoted: message });
    }
}

module.exports = updateCommand;


