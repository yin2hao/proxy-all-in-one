// /api/login.js
import crypto from 'crypto';

// 从环境变量获取密码
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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

// 生成简单的 token（生产环境建议用 JWT）
function generateToken(password) {
  const timestamp = Date.now();
  const hash = crypto.createHash('sha256').update(`${password}:${timestamp}`).digest('hex');
  return `${timestamp}:${hash}`;
}

// 验证 token
export function verifyToken(token) {
  if (!ADMIN_PASSWORD || !token) return false;
  
  try {
    const [timestamp, hash] = token.split(':');
    const expectedHash = crypto.createHash('sha256')
      .update(`${ADMIN_PASSWORD}:${timestamp}`)
      .digest('hex');
    
    // 验证 hash 是否匹配
    if (hash !== expectedHash) return false;
    
    // 验证是否过期（24小时）
    const age = Date.now() - parseInt(timestamp);
    return age < 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  // 只允许 POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isLocalRequest(req)) {
    return res.status(403).json({
      error: 'Admin login disabled in cloud mode',
      message: 'Proxy Manager editing is only available from localhost.'
    });
  }
  
  // 检查是否设置了密码
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ 
      error: 'Admin password not configured',
      message: 'Please set ADMIN_PASSWORD environment variable in Vercel'
    });
  }
  
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  // 生成 token
  const token = generateToken(password);
  
  return res.json({ 
    success: true, 
    token,
    expiresIn: '24h'
  });
}
