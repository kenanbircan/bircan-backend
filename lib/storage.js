const fs = require('fs');
const path = require('path');
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function readJson(file, fallback){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
function writeJson(file, data){ ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(data,null,2)); }
function upsertRecord(file, id, patch){ const db=readJson(file,{}); db[id]={...(db[id]||{}),...patch,updatedAt:new Date().toISOString()}; writeJson(file, db); return db[id]; }
module.exports={ensureDir,readJson,writeJson,upsertRecord};
