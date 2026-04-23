Patched from uploaded server(48).js

Changes made:
- Added multer require
- Added kbUpload multer storage config
- Added POST /api/admin/knowledgebase/upload protected by adminGuard
- Route accepts both 'files' and 'file' multipart fields to match the admin page
- Route reloads knowledgebase index via loadKnowledgebaseIndex(true)

Important:
- Run: npm install multer
- Redeploy after replacing server.js
