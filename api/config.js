// /api/config.js
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyToken } from './login.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

function extractHost(value) {
  if (!value) return '';
  const raw = String(value).split(',')[0].trim().toLowerCase();

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end >= 0 ? raw.slice(1, end) : raw.slice(1);
  }

  const parts = raw.split(':');
  return parts.length === 2 ? parts[0] : raw;
}

function isLoopback(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1'
  );
}

function isLocalRequest(req) {
  const hosts = [
    extractHost(req.headers['x-forwarded-host']),
    extractHost(req.headers.host),
    extractHost(req.headers['x-real-host'])
  ].filter(Boolean);

  if (hosts.some(isLoopback)) {
    return true;
  }

  return isLoopback(req.socket?.remoteAddress);
}

// 读取配置
function getConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return normalizeConfig({});
    }
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    console.error('Failed to read config:', err.message);
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

// 保存配置
function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(normalizeConfig(config), null, 2), 'utf-8');
}

// 验证代理配置
function validateProxy(proxy) {
  const errors = [];
  
  if (!proxy.name || typeof proxy.name !== 'string') {
    errors.push('name is required and must be a string');
  }
  if (!proxy.domain || typeof proxy.domain !== 'string') {
    errors.push('domain is required and must be a string');
  }
  if (!proxy.target || typeof proxy.target !== 'string') {
    errors.push('target is required and must be a string');
  }
  if (!['simple', 'filtered'].includes(proxy.mode)) {
    errors.push('mode must be "simple" or "filtered"');
  }
  
  return errors;
}

// 验证认证 token
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.substring(7);
  return verifyToken(token);
}

export default async function handler(req, res) {
  const editable = isLocalRequest(req);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'X-Config-Editable, X-Config-Mode');
  res.setHeader('X-Config-Editable', editable ? 'true' : 'false');
  res.setHeader('X-Config-Mode', editable ? 'local' : 'cloud');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // GET - 获取配置（不需要认证）
  if (req.method === 'GET') {
    const config = getConfig();
    return res.json(config);
  }

  if (!editable) {
    return res.status(403).json({
      error: 'Config is read-only in cloud mode',
      message: 'Proxy Manager can only modify config.json from localhost.'
    });
  }
  
  // POST/PUT/DELETE 需要认证
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid token required' });
  }
  
  // POST - 更新整个配置
  if (req.method === 'POST') {
    try {
      const newConfig = req.body;
      
      if (!newConfig || !Array.isArray(newConfig.proxies)) {
        return res.status(400).json({ error: 'Invalid config format, expected { proxies: [...] }' });
      }

      newConfig.globalBypassConfig = Boolean(newConfig.globalBypassConfig);
      
      // 验证每个代理
      for (const proxy of newConfig.proxies) {
        const errors = validateProxy(proxy);
        if (errors.length > 0) {
          return res.status(400).json({ 
            error: 'Validation failed', 
            proxy: proxy.name || 'unknown',
            errors 
          });
        }
      }
      
      saveConfig(newConfig);
      return res.json({ success: true, message: 'Config saved' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save config', message: err.message });
    }
  }
  
  // PUT - 添加/更新单个代理
  if (req.method === 'PUT') {
    try {
      const proxy = req.body;
      const errors = validateProxy(proxy);
      if (errors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', errors });
      }
      
      const config = getConfig();
      const index = config.proxies.findIndex(p => p.name === proxy.name);
      
      if (index >= 0) {
        config.proxies[index] = proxy;
      } else {
        config.proxies.push(proxy);
      }
      
      saveConfig(config);
      return res.json({ success: true, message: `Proxy "${proxy.name}" saved` });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save proxy', message: err.message });
    }
  }
  
  // DELETE - 删除代理
  if (req.method === 'DELETE') {
    try {
      const { name } = req.query;
      if (!name) {
        return res.status(400).json({ error: 'Missing "name" query parameter' });
      }
      
      const config = getConfig();
      const index = config.proxies.findIndex(p => p.name === name);
      
      if (index < 0) {
        return res.status(404).json({ error: `Proxy "${name}" not found` });
      }
      
      config.proxies.splice(index, 1);
      saveConfig(config);
      return res.json({ success: true, message: `Proxy "${name}" deleted` });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete proxy', message: err.message });
    }
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}
