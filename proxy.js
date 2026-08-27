const http = require('http');

const PROXY_PORT = parseInt(process.argv[2], 10);
const BACKEND_PORT = parseInt(process.argv[3], 10);

if (isNaN(PROXY_PORT) || isNaN(BACKEND_PORT)) {
    console.error("Usage: node proxy.js <proxy_port> <backend_port>");
    process.exit(1);
}

console.log(`Proxy starting... Port: ${PROXY_PORT} -> Backend: ${BACKEND_PORT}`);

const server = http.createServer((req, res) => {
    const isGeneration = req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/completion');

    if (isGeneration) {
        // Check health of backend with fail_on_no_slot=true
        const healthReq = http.request({
            host: '127.0.0.1',
            port: BACKEND_PORT,
            path: '/health?fail_on_no_slot=true',
            method: 'GET'
        }, (healthRes) => {
            let body = '';
            healthRes.on('data', chunk => body += chunk);
            healthRes.on('end', () => {
                if (healthRes.statusCode === 503) {
                    console.log(`[${new Date().toISOString()}] Rejected request (503): Backend busy.`);
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: "Service Unavailable: The model is currently busy processing another request.",
                            type: "service_unavailable",
                            param: null,
                            code: 503
                        }
                    }));
                    return;
                }
                // Forward request
                forwardRequest(req, res);
            });
        });

        healthReq.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] Health check connection error:`, err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "Bad Gateway: Backend server is unreachable.", details: err.message, code: 502 } }));
        });
        healthReq.end();
    } else {
        // Non-generation requests are forwarded directly
        forwardRequest(req, res);
    }
});

function forwardRequest(req, res) {
    const proxyReq = http.request({
        host: '127.0.0.1',
        port: BACKEND_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] Proxy forward connection error:`, err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Proxy Error: Failed to connect to backend.", details: err.message } }));
    });

    req.pipe(proxyReq);
}

server.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`Proxy server listening on port ${PROXY_PORT}, forwarding to ${BACKEND_PORT}`);
});
