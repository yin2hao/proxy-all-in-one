// src/main.js
import express from 'express';
import { Readable } from 'stream';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 80;

// 加载配置文件
function loadConfig() {
  try {
    const configPath = join(__dirname, '..', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    console.error('Failed to load config.json:', err.message);
    return normalizeConfig({});
  }
}

function normalizeConfig(config) {
  const normalized = config && typeof config === 'object' ? config : {};
  return {
    ...normalized,
    proxies: Array.isArray(normalized.proxies) ? normalized.proxies : [],
    globalBypassConfig: Boolean(normalized.globalBypassConfig)
  };
}

function normalizeHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .toLowerCase();
  }
}

function normalizeAbsoluteUrlCandidate(value) {
  return String(value || '').replace(/^(https?):\/(?!\/)/i, '$1://');
}

function parseRegexLiteral(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return null;

  let end = -1;
  for (let i = raw.length - 1; i > 0; i--) {
    if (raw[i] === '/' && raw[i - 1] !== '\\') {
      end = i;
      break;
    }
  }

  if (end <= 0) return null;

  const pattern = raw.slice(1, end);
  const flags = raw.slice(end + 1);
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseTargetRule(target) {
  const raw = String(target || '').trim();

  if (/^regex:/i.test(raw)) {
    const body = raw.slice(6).trim();
    const separatorIndex = body.indexOf('=>');
    if (separatorIndex < 0) {
      throw new Error('Regex target must use: regex:/pattern/flags => replacement');
    }

    const regexPart = body.slice(0, separatorIndex).trim();
    const replacement = body.slice(separatorIndex + 2).trim();
    const regex = parseRegexLiteral(regexPart);

    if (!regex) {
      throw new Error(`Invalid target regex: ${regexPart}`);
    }
    if (!replacement) {
      throw new Error('Regex target replacement cannot be empty');
    }

    return { type: 'regex-rewrite', regex, replacement };
  }

  if (!isValidHttpUrl(raw)) {
    throw new Error(`Invalid target URL: ${raw}`);
  }

  return { type: 'url', value: raw };
}

function getOriginalRequestAbsoluteUrl(parsed) {
  if (parsed.absoluteTargetUrl) {
    return parsed.absoluteTargetUrl;
  }
  return `https://${parsed.domain}${parsed.path.startsWith('/') ? parsed.path : `/${parsed.path}`}`;
}

function resolveTargetUrl(targetRule, parsed) {
  const parsedRule = parseTargetRule(targetRule);

  if (parsedRule.type === 'url') {
    return buildTargetUrl(parsedRule.value, parsed.path);
  }

  const sourceUrl = getOriginalRequestAbsoluteUrl(parsed);
  const rewritten = normalizeAbsoluteUrlCandidate(sourceUrl.replace(parsedRule.regex, parsedRule.replacement));

  if (rewritten === sourceUrl) {
    throw new Error(`Target regex did not match source URL: ${sourceUrl}`);
  }

  if (!isValidHttpUrl(rewritten)) {
    throw new Error(`Regex target rewrite result must be http/https URL: ${rewritten}`);
  }

  return new URL(rewritten).toString();
}

function domainMatches(rule, domain) {
  const host = normalizeHost(domain);
  const regex = parseRegexLiteral(rule);
  if (regex) {
    return regex.test(host);
  }

  const proxyDomain = normalizeHost(rule);
  return proxyDomain && (host === proxyDomain || host.endsWith(`.${proxyDomain}`));
}

// 根据域名查找代理配置
function findProxyByDomain(config, domain) {
  return config.proxies.find(p => {
    return domainMatches(p.domain, domain);
  });
}

// 解析 URL，提取目标域名和剩余路径
function parseProxyUrl(url) {
  const rawUrl = String(url || '').trim();
  const withoutPrefix = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl;
  const absoluteCandidates = [normalizeAbsoluteUrlCandidate(withoutPrefix)];

  try {
    absoluteCandidates.push(normalizeAbsoluteUrlCandidate(decodeURIComponent(withoutPrefix)));
  } catch {
    // Keep the raw candidate when the path is not URI-encoded.
  }

  for (const candidate of absoluteCandidates) {
    if (!/^https?:\/\//i.test(candidate)) continue;

    try {
      const targetUrl = new URL(candidate);
      return {
        domain: targetUrl.hostname.toLowerCase(),
        path: `${targetUrl.pathname || '/'}${targetUrl.search || ''}`,
        absoluteTargetUrl: targetUrl.toString()
      };
    } catch {
      // Fall through to the legacy domain/path format.
    }
  }

  // 格式: /domain.com/path/to/resource
  const match = rawUrl.match(/^\/([^\/?#]+)([\/?#].*)?$/);
  if (!match) return null;

  const suffix = match[2] || '/';
  return {
    domain: normalizeHost(match[1]),
    path: suffix,
    absoluteTargetUrl: ''
  };
}

function buildTargetUrl(target, path) {
  const normalizedTarget = String(target || '').replace(/\/+$/, '');
  if (!path) return normalizedTarget;
  if (path.startsWith('?') || path.startsWith('#')) {
    return `${normalizedTarget}${path}`;
  }
  return `${normalizedTarget}${path.startsWith('/') ? path : `/${path}`}`;
}

function buildBypassTargetUrl(parsed) {
  if (parsed.absoluteTargetUrl) {
    return parsed.absoluteTargetUrl;
  }
  const base = `https://${parsed.domain}`;
  return buildTargetUrl(base, parsed.path);
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

app.all('*', async (req, res) => {
  const config = loadConfig();
  
  // 健康检查
  if (req.url === '/') {
    return res.json({
      status: 'running',
      proxies: config.proxies.map(p => ({
        name: p.name,
        domain: p.domain,
        mode: p.mode
      }))
    });
  }
  
  // 解析请求 URL
  const parsed = parseProxyUrl(req.url);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid proxy URL format' });
  }
  
  const { domain } = parsed;
  const bypassEnabled = config.globalBypassConfig;
  const proxyConfig = bypassEnabled
    ? {
        name: '__global_bypass__',
        mode: 'simple',
        headers: {
          removeRequest: ['host', 'content-length', 'connection'],
          removeResponse: ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
        }
      }
    : findProxyByDomain(config, domain);

  if (!proxyConfig) {
    return res.status(404).json({
      error: 'No proxy configured for this domain',
      domain,
      availableProxies: config.proxies.map(p => p.domain)
    });
  }

  // 构建目标 URL
  let targetUrl = '';
  try {
    targetUrl = bypassEnabled ? buildBypassTargetUrl(parsed) : resolveTargetUrl(proxyConfig.target, parsed);
  } catch (err) {
    return res.status(500).json({
      error: 'Invalid proxy target rule',
      proxy: proxyConfig.name || 'unknown',
      message: err.message
    });
  }

  if (bypassEnabled) {
    console.log(`[proxy] ${req.method} ${req.url} -> ${targetUrl} (global bypass simple mode)`);
  } else {
    console.log(`[proxy] ${req.method} ${req.url} -> ${targetUrl} (${proxyConfig.mode} mode)`);
  }
  
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
    const resolvedTarget = new URL(targetUrl);
    const vars = {
      target_hostname: resolvedTarget.hostname,
      target_origin: resolvedTarget.origin,
      target_url: targetUrl
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
  let body = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readBody(req);
  }
  
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
});

// 读取请求体
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

app.listen(PORT, () => {
  const config = loadConfig();
  console.log(`API proxy server started on http://localhost:${PORT}`);
  console.log(`Loaded ${config.proxies.length} proxy configurations:`);
  config.proxies.forEach(p => {
    console.log(`  - ${p.name}: ${p.domain} -> ${p.target} (${p.mode} mode)`);
  });
});
