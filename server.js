// REPLACE your existing drawHeader function in server.js with this:

function drawHeader(doc) {
  const letterheadPath = path.join(PUBLIC_DIR, 'letterhead.png');

  if (fs.existsSync(letterheadPath)) {
    doc.image(letterheadPath, 0, 0, {
      width: doc.page.width
    });
    doc.y = 150; // adjust spacing below letterhead
  } else {
    doc.y = 40;
  }
}
