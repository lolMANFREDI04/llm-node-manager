const express = require('express');
const basicAuth = require('express-basic-auth');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Persistenza Configurazione (Cartella Modelli)
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let config = { modelsDir: path.join(__dirname, 'models') };
if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {}
} else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
let modelsDir = config.modelsDir;
if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

// Persistenza API Keys
const KEYS_FILE = path.join(DATA_DIR, 'apikeys.json');
let apiKeys = {};
if (fs.existsSync(KEYS_FILE)) {
    apiKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
} else {
    apiKeys['sk-my-super-secret-key'] = { name: 'Admin Default', calls: 0, tokens: 0, created: new Date().toISOString() };
    fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2));
}
const saveKeys = () => fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2));

let serverLogs = [];
const MAX_LOGS = 200;

function addLog(data) {
    const lines = data.toString().split('\n').filter(Boolean);
    serverLogs.push(...lines);
    if (serverLogs.length > MAX_LOGS) serverLogs = serverLogs.slice(serverLogs.length - MAX_LOGS);
}

const uiAuth = basicAuth({
    users: { 'admin': 'admin123' },
    challenge: true
});

const isServerRunning = (callback) => {
    exec("pgrep -f llama-server", (err, stdout) => {
        callback(!err && stdout.trim().length > 0);
    });
};

// Trova il binario corretto di llama-server
const getLlamaServerBin = () => {
    const localBin = path.join(__dirname, 'llama-server');
    const parentBin = path.resolve(__dirname, '../../llama.cpp/build/bin/llama-server');
    if (fs.existsSync(localBin)) return localBin;
    if (fs.existsSync(parentBin)) return parentBin;
    return 'llama-server'; // Fallback su PATH globale
};

app.post('/v1/chat/completions', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "API Key mancante" });
    
    const key = authHeader.split(' ')[1];
    if (!apiKeys[key]) return res.status(401).json({ error: "API Key non autorizzata" });

    apiKeys[key].calls = (apiKeys[key].calls || 0) + 1;
    apiKeys[key].tokens = (apiKeys[key].tokens || 0) + Math.ceil(JSON.stringify(req.body).length / 4);
    saveKeys();

    try {
        const llamaRes = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        
        res.status(llamaRes.status);
        llamaRes.headers.forEach((val, k) => res.setHeader(k, val));
        
        if (llamaRes.body) {
            for await (const chunk of llamaRes.body) {
                res.write(Buffer.from(chunk));
            }
        }
        res.end();
    } catch(e) {
        res.status(500).json({error: "Server locale offline"});
    }
});

app.use('/', uiAuth, express.static(path.join(__dirname, 'public')));

app.get('/api/keys', uiAuth, (req, res) => res.json(apiKeys));
app.post('/api/keys', uiAuth, (req, res) => {
    const name = req.body.name || 'Nuova Chiave';
    const newKey = 'sk-' + Math.random().toString(36).substr(2, 10) + Math.random().toString(36).substr(2, 10);
    apiKeys[newKey] = { name, calls: 0, tokens: 0, created: new Date().toISOString() };
    saveKeys();
    res.json(apiKeys);
});
app.delete('/api/keys/:key', uiAuth, (req, res) => {
    if (apiKeys[req.params.key]) { delete apiKeys[req.params.key]; saveKeys(); }
    res.json(apiKeys);
});

app.get('/api/models/path', uiAuth, (req, res) => res.json({ path: modelsDir }));
app.post('/api/models/path', uiAuth, (req, res) => {
    if (req.body.path) {
        const resolvedPath = path.resolve(req.body.path);
        if (fs.existsSync(resolvedPath)) {
            modelsDir = resolvedPath;
            config.modelsDir = modelsDir;
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
            return res.json({ success: true, path: modelsDir });
        }
    }
    res.status(400).json({ success: false, error: "Cartella non esistente" });
});

app.get('/api/models', uiAuth, (req, res) => {
    fs.readdir(modelsDir, (err, files) => {
        if (err) return res.json([]);
        res.json(files.filter(f => f.endsWith('.gguf')));
    });
});

app.delete('/api/models/:name', uiAuth, (req, res) => {
    const filePath = path.join(modelsDir, req.params.name);
    fs.unlink(filePath, (err) => res.json({ success: !err }));
});

app.post('/api/models/download', uiAuth, (req, res) => {
    const url = req.body.url;
    if (!url || !url.startsWith('http')) return res.end("URL non valido.");
    let filename = url.split('/').pop().split('?')[0];
    if (!filename || !filename.endsWith('.gguf')) filename += '.gguf';
    const dest = path.join(modelsDir, filename);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(`Inizio download di ${filename}...\n`);

    const dlProcess = spawn('curl', ['-L', '--progress-bar', url, '-o', dest]);
    dlProcess.stderr.on('data', data => res.write(data));
    dlProcess.stdout.on('data', data => res.write(data));
    dlProcess.on('close', (code) => {
        if(code === 0) res.write(`\n[OK] Download completato!\n`);
        else res.write(`\n[!] Errore download (Codice ${code}).\n`);
        res.end();
    });
});

app.get('/api/server/logs', uiAuth, (req, res) => res.json(serverLogs));

app.get('/api/server/status', uiAuth, (req, res) => {
    isServerRunning((running) => {
        res.json({ status: running ? 'started' : 'stopped' });
    });
});

app.post('/api/server/toggle', uiAuth, (req, res) => {
    isServerRunning((running) => {
        if (running) {
            exec("pkill -f llama-server", (err) => {
                addLog("[SISTEMA] Processo arrestato.");
                res.json({ status: "stopped" });
            });
        } else {
            serverLogs = [];
            const modelPath = path.join(modelsDir, req.body.model);
            addLog(`[SISTEMA] Avvio server con modello: ${req.body.model}...`);
            
            const serverBin = getLlamaServerBin();
            
            const llamaProcess = spawn(serverBin, [
                '-m', modelPath, '-c', '2048', '-np', '1', '-t', '1', '--port', '8080', '--host', '127.0.0.1'
            ], {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            llamaProcess.stdout.on('data', addLog);
            llamaProcess.stderr.on('data', addLog);
            llamaProcess.unref();

            res.json({ status: "started" });
        }
    });
});

app.post('/api/chat', uiAuth, async (req, res) => {
    const prompt = req.body.prompt;
    const useMcp = req.body.useMcp;
    const useStream = req.body.useStream;
    
    if (useMcp) {
        if (useStream) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Transfer-Encoding', 'chunked');
            const mcpProcess = spawn('./mcp-bridge.sh', [prompt]);
            mcpProcess.stdout.on('data', data => res.write(data));
            mcpProcess.stderr.on('data', data => res.write(data));
            mcpProcess.on('close', () => res.end());
        } else {
            const safePrompt = prompt.replace(/"/g, '\\"');
            exec(`./mcp-bridge.sh "${safePrompt}"`, (err, stdout) => res.json({ reply: stdout || "Nessun output" }));
        }
    } else {
        if (useStream) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Transfer-Encoding', 'chunked');
            try {
                const llamaRes = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], stream: true })
                });
                if (!llamaRes.ok) return res.end("Errore server Llama");
                let buffer = '';
                for await (const chunk of llamaRes.body) {
                    buffer += Buffer.from(chunk).toString('utf-8');
                    let parts = buffer.split('\n');
                    buffer = parts.pop(); 
                    for (const line of parts) {
                        const trimLine = line.trim();
                        if (trimLine.startsWith('data: ') && !trimLine.includes('[DONE]')) {
                            try {
                                const parsed = JSON.parse(trimLine.slice(6));
                                const content = parsed.choices[0].delta?.content;
                                if (content) res.write(content);
                            } catch(e) {}
                        }
                    }
                }
                res.end();
            } catch(e) { res.end("Server offline"); }
        } else {
            try {
                const llamaRes = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], stream: false })
                });
                const data = await llamaRes.json();
                res.json({ reply: data.choices[0].message.content });
            } catch(e) { res.json({ reply: "Server offline" }); }
        }
    }
});

app.listen(3000, '0.0.0.0', () => console.log('Manager attivo sulla porta 3000'));
