// /api/index.js
import { Readable } from 'stream';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载配置文件
function loadConfig() {
  try {
    const configPath = join(__dirname, '..', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load config.json:', err.message);
    return { proxies: [] };
  }
}

// 根据域名查找代理配置
function findProxyByDomain(config, domain) {
  return config.proxies.find(p => p.domain === domain || domain.endsWith(`.${p.domain}`));
}

// 解析 URL，提取目标域名和剩余路径
function parseProxyUrl(url) {
  // 格式: /domain.com/path/to/resource
  const match = url.match(/^\/([^\/]+)(\/.*)?$/);
  if (!match) return null;
  
  return {
    domain: match[1],
    path: match[2] || '/'
  };
}

// 替换模板变量
function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
}

// 处理 API Key
function extractApiKey(headers, authConfig) {
  if (!authConfig) return { key: '', source: '' };
  
  let rawKey = '';
  let source = '';
  
  for (const src of authConfig.sources) {
    if (src === 'x-goog-api-key' && headers['x-goog-api-key']) {
      rawKey = headers['x-goog-api-key'];
      source = 'x-goog';
      break;
    }
    if (src === 'authorization-bearer' && headers.authorization?.toLowerCase().startsWith('bearer ')) {
      rawKey = headers.authorization.substring(7);
      source = 'auth';
      break;
    }
  }
  
  const key = String(rawKey).trim();
  if (!key) return { key: '', source: '' };
  
  return { key, source };
}

export default async function handler(req, res) {
  const config = loadConfig();
  
  // 解析请求 URL（Vercel 通过 query.url 传递原始路径）
  const requestUrl = req.query.url || req.url;
  const parsed = parseProxyUrl(requestUrl);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid proxy URL format' });
  }
  
  const { domain, path } = parsed;
  
  // 查找对应的代理配置
  const proxyConfig = findProxyByDomain(config, domain);
  if (!proxyConfig) {
    return res.status(404).json({
      error: 'No proxy configured for this domain',
      domain,
      availableProxies: config.proxies.map(p => p.domain)
    });
  }
  
  // 构建目标 URL
  const targetUrl = `${proxyConfig.target}${path}`;
  
  console.log(`[proxy] ${req.method} ${requestUrl} -> ${targetUrl} (${proxyConfig.mode} mode)`);
  
  // 根据模式处理请求头
  let headers = {};
  
  if (proxyConfig.mode === 'simple') {
    // 简单模式：直接复制，删除指定的头
    headers = { ...req.headers };
    for (const h of (proxyConfig.headers?.removeRequest || [])) {
      delete headers[h.toLowerCase()];
    }
  } else if (proxyConfig.mode === 'filtered') {
    // 过滤模式：更严格的处理
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      // 跳过需要删除的认证头
      if ((proxyConfig.headers?.removeRequest || []).includes(lowerKey)) continue;
      headers[key] = value;
    }
    
    // 处理 API Key
    if (proxyConfig.auth) {
      const { key, source } = extractApiKey(req.headers, proxyConfig.auth);
      if (key) {
        if (source === 'x-goog') {
          headers['x-goog-api-key'] = key;
        } else if (source === 'auth') {
          headers['Authorization'] = `Bearer ${key}`;
        }
        console.log(`[proxy] Selected API Key: ${key}`);
      }
    }
    
    // 设置模板化的头
    const vars = {
      target_hostname: new URL(proxyConfig.target).hostname,
      target_origin: new URL(proxyConfig.target).origin,
      target_url: proxyConfig.target
    };
    
    if (proxyConfig.headers?.set) {
      for (const [key, template] of Object.entries(proxyConfig.headers.set)) {
        headers[key] = interpolate(template, vars);
      }
    }
    
    // 保留转发头
    if (proxyConfig.forwardedHeaders) {
      headers['x-forwarded-for'] = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || req.protocol;
    }
    
    // 删除 hop-by-hop 头
    const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'];
    for (const h of hopByHop) {
      delete headers[h];
    }
  }
  
  // 准备请求体
  const body = (req.method !== 'GET' && req.method !== 'HEAD')
    ? await readBody(req)
    : undefined;
  
  try {
    const start = Date.now();
    const apiResponse = await fetch(targetUrl, {
      method: req.method,
      headers,
      body
    });
    
    console.log(`[proxy] status=${apiResponse.status} cost=${Date.now() - start}ms`);
    
    // 处理响应头
    const responseHeaders = {};
    const removeResponse = proxyConfig.headers?.removeResponse || [];
    
    apiResponse.headers.forEach((value, key) => {
      if (!removeResponse.includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });
    
    res.writeHead(apiResponse.status, responseHeaders);
    
    // 流式传输响应
    if (apiResponse.body) {
      Readable.fromWeb(apiResponse.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error(`[proxy] error:`, err);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Proxy request failed',
        message: err.message
      });
    }
  }
}

// 读取请求体
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
