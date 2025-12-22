// src/main.js
import express from 'express';
import { Readable } from 'stream';

const app = express();
const PORT = process.env.PORT || 80;
const TARGET_API_URL = 'https://generativelanguage.googleapis.com';
const TARGET_HOSTNAME = new URL(TARGET_API_URL).hostname;
const TARGET_ORIGIN = new URL(TARGET_API_URL).origin;

app.all('*', async (req, res) => {
  if (req.url === '/') {
    return res.send('proxy is running, you can see more at https://github.com/spectre-pro/gemini-proxy');
  } 
  const targetUrl = `${TARGET_API_URL}${req.url}`;
  let rawApiKeys = '';
  let apiKeySource = '';
  if (req.headers['x-goog-api-key']) {
    rawApiKeys = req.headers['x-goog-api-key'];
    apiKeySource = 'x-goog';
  } 
  else if (req.headers.authorization && req.headers.authorization.toLowerCase().startsWith('bearer ')) {
    rawApiKeys = req.headers.authorization.substring(7); 
    apiKeySource = 'auth';
  }

  let selectedKey = '';
  if (apiKeySource) {
    const apiKeys = String(rawApiKeys).split(',').map(k => k.trim()).filter(k => k);
    if (apiKeys.length > 0) {
      selectedKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
      console.log(`Gemini Selected API Key: ${selectedKey}`);
    }
  }

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== 'x-goog-api-key' && lowerKey !== 'authorization') {
      headers[key] = value;
    }
  }

  if (selectedKey) {
    if (apiKeySource === 'x-goog') {
      headers['x-goog-api-key'] = selectedKey;
    } else if (apiKeySource === 'auth') {
      headers['Authorization'] = `Bearer ${selectedKey}`;
    }
  }

  headers.host = TARGET_HOSTNAME;
  headers.origin = TARGET_ORIGIN;
  headers.referer = TARGET_API_URL;
  
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || req.protocol;

  const hopByHopHeaders = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade'
  ];
  for (const header of hopByHopHeaders) {
    delete headers[header];
  }

  try {
    const apiResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
      duplex: 'half',
    });

    const responseHeaders = {};
    for (const [key, value] of apiResponse.headers.entries()) {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'strict-transport-security'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }
    res.writeHead(apiResponse.status, responseHeaders);

    if (apiResponse.body) {
      Readable.fromWeb(apiResponse.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).send('代理伺服器错误 (Bad Gateway)');
    }
  }
});

app.listen(PORT, () => {
  console.log(`API 代理伺服器已在 http://localhost:${PORT} 启动`);
  console.log(`所有请求将被转发到: ${TARGET_API_URL}`);
});
