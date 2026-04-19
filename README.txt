DOCX knowledgebase backend

1. Put large policy manuals into /knowledgebase (subfolders supported)
2. Recommended formats: .docx primarily; .txt/.md/.json/.csv/.html also supported
3. Install dependencies: npm install
4. Start: npm start

Important:
- DOCX extraction requires the mammoth package included in package.json
- The backend reads the knowledgebase folder recursively, chunks large documents,
  retrieves relevant excerpts per assessment, and injects only selected policy
  excerpts into the OpenAI analysis prompt.
