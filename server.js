const express = require('express');
const basicAuth = require('express-basic-auth');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Gestione persistente API Keys
const KEYS_FILE = path.join(__dirname, 'data', 'apikeys.json');
let apiKeys = {};
if (fs.existsSync(KEYS_FILE)) {
    apiKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
} else {
    // Chiave di default iniziale
    apiKeys['sk-my-super-secret-key'] = { name: 'Admin Default', calls: 0, tokens: 0, created: new Date().toISOString() };
    fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2));
}
const saveKeys = () => fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2));

let llamaProcess = null;
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

// Endpoint Pubblico - Proxy per chiamate esterne
app.post('/v1/chat/completions', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "API Key mancante" });
    
    const key = authHeader.split(' ')[1];
    if (!apiKeys[key]) return res.status(401).json({ error: "API Key non autorizzata" });

    // Aggiornamento Statistiche (stima token basata sui byte del payload)
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

// Rotte API Keys per la UI
app.get('/api/keys', uiAuth, (req, res) => res.json(apiKeys));

app.post('/api/keys', uiAuth, (req, res) => {
    const name = req.body.name || 'Nuova Chiave';
    // Genera una chiave stile OpenAI
    const newKey = 'sk-' + Math.random().toString(36).substr(2, 10) + Math.random().toString(36).substr(2, 10);
    apiKeys[newKey] = { name, calls: 0, tokens: 0, created: new Date().toISOString() };
    saveKeys();
    res.json(apiKeys);
});

app.delete('/api/keys/:key', uiAuth, (req, res) => {
    if (apiKeys[req.params.key]) {
        delete apiKeys[req.params.key];
        saveKeys();
    }
    res.json(apiKeys);
});

// Rotte Modelli e Sistema
app.get('/api/models', uiAuth, (req, res) => {
    exec('ls -1 ./models/*.gguf', (err, stdout) => res.json(stdout ? stdout.split('\n').filter(Boolean).map(p => path.basename(p)) : []));
});

app.delete('/api/models/:name', uiAuth, (req, res) => {
    exec(`rm -f ./models/${req.params.name}`, (err) => res.json({ success: !err }));
});

app.post('/api/models/download', uiAuth, (req, res) => {
    const url = req.body.url;
    if (!url || !url.startsWith('http')) return res.end("URL non valido.");
    let filename = url.split('/').pop().split('?')[0];
    if (!filename || !filename.endsWith('.gguf')) filename += '.gguf';

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(`Inizio download di ${filename}...\n`);

    const dlProcess = spawn('curl', ['-L', '--progress-bar', url, '-o', `./models/${filename}`]);
    dlProcess.stderr.on('data', data => res.write(data));
    dlProcess.stdout.on('data', data => res.write(data));
    dlProcess.on('close', (code) => {
        if(code === 0) res.write(`\n[OK] Download completato con successo!\n`);
        else res.write(`\n[!] Errore durante il download (Codice ${code}).\n`);
        res.end();
    });
});

app.get('/api/server/logs', uiAuth, (req, res) => res.json(serverLogs));

app.post('/api/server/toggle', uiAuth, (req, res) => {
    if (llamaProcess) {
        llamaProcess.kill();
        llamaProcess = null;
        addLog("[SISTEMA] Processo arrestato manualmente.");
        res.json({ status: "stopped" });
    } else {
        serverLogs = [];
        addLog(`[SISTEMA] Avvio server con modello: ${req.body.model}...`);
        llamaProcess = spawn('llama-server', [
            '-m', `./models/${req.body.model}`, '-c', '512', '-np', '1', '-t', '1', '--port', '8080', '--host', '127.0.0.1'
        ]);
        llamaProcess.stdout.on('data', addLog);
        llamaProcess.stderr.on('data', addLog);
        llamaProcess.on('close', (code) => { addLog(`[SISTEMA] llama-server terminato con codice: ${code}`); llamaProcess = null; });
        res.json({ status: "started" });
    }
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
                if (!llamaRes.ok) return res.end("Errore dal server Llama");
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
