Bircan Migration final matched backend package

Included:
- server.js (DOCX knowledgebase + scored retrieval + knowledgebase citations)
- public/admin.html (professional operations console)
- knowledgebase/README.txt
- package.json

How it works:
1. Install dependencies: npm install
2. Put your policy manuals in /knowledgebase
3. Start the backend: npm start
4. Open the admin panel at: /admin/admin.html

Important:
- The backend serves the public folder at /admin
- The admin panel can read health, submissions, status, resend email, and knowledgebase metadata endpoints
- DOCX knowledgebase support requires mammoth
