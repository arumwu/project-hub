'use strict';
// Explicit file list: never copy Git metadata, local files or private documents.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public-release', 'ProjectHub');
const files = [
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'scripts/export-public.js', 'scripts/public.gitignore',
  'hub/.gitignore', 'hub/README.md', 'hub/CHANGELOG.md',
  'hub/package.json', 'hub/package-lock.json', 'hub/server.js',
  'hub/setup.sh', 'hub/start.command',
  'hub/lib/ai-tools.js', 'hub/lib/chat.js', 'hub/lib/frontmatter.js',
  'hub/lib/git.js', 'hub/lib/launch.js', 'hub/lib/roles.js',
  'hub/lib/sessions.js', 'hub/lib/store.js', 'hub/lib/transcript.js',
  'hub/public/app.js', 'hub/public/app.css', 'hub/public/index.html',
  'hub/public/vendor/LICENSE-xterm', 'hub/public/vendor/xterm.js',
  'hub/public/vendor/xterm.css', 'hub/public/vendor/addon-fit.js',
  'hub/app/build-app.sh', 'hub/app/run.sh', 'hub/app/window.swift',
  'hub/app/icon-concept.png', 'hub/app/icon-concept.svg',
  'hub/test/ai-tools.test.js', 'hub/test/app-ui.test.js',
  'hub/test/git.test.js', 'hub/test/hub.test.js',
  'hub/test/io.test.js', 'hub/test/transcript.test.js',
  'docs/project-hub/templates/_hub/roles.yaml',
  'docs/project-hub/templates/project/.gitignore',
  'docs/project-hub/templates/project/PROJECT.md',
  'docs/project-hub/templates/project/AGENTS.md',
  'docs/project-hub/templates/project/CLAUDE.md',
  'docs/project-hub/templates/project/.ai/rules.md',
  'docs/project-hub/templates/project/.ai/board.md',
  'docs/project-hub/templates/project/.ai/memory/INDEX.md',
  'docs/project-hub/templates/project/.ai/tasks/_template.md',
  'docs/project-hub/templates/project/資料/.gitkeep',
  'docs/project-hub/templates/project/作業/.gitkeep',
  'docs/project-hub/templates/project/成果物/.gitkeep',
  'hub/seed/サンプルアプリ/PROJECT.md',
  'hub/seed/サンプルアプリ/.ai/tasks/sample-app-01.md',
  'hub/seed/サンプルサイト/PROJECT.md',
  'hub/seed/サンプルサイト/.ai/tasks/sample-site-01.md',
  'hub/seed/サンプル文書/PROJECT.md',
  'hub/seed/サンプル文書/.ai/tasks/sample-doc-01.md',
  'hub/seed/Project Hub/PROJECT.md',
  'hub/seed/Project Hub/.ai/tasks/sample-hub-01.md',
];

// Read and validate everything before changing an existing export.
const entries = files.map(name => {
  const source = path.join(root, name);
  if (!fs.lstatSync(source).isFile()) throw new Error(`Not a regular file: ${name}`);
  let content = fs.readFileSync(source);
  if (name === 'hub/CHANGELOG.md') {
    const text = content.toString('utf8');
    const next = text.indexOf('\n## ', text.indexOf('\n## ') + 1);
    content = Buffer.from(next < 0 ? text : text.slice(0, next) + '\n');
  }
  return { name, content, mode: fs.statSync(source).mode & 0o777 };
});
entries.push({ name: '.gitignore', content: fs.readFileSync(path.join(root, 'scripts/public.gitignore')), mode: 0o644 });
if (fs.existsSync(output)) {
  // Preserve previous output instead of deleting it; it is outside the public folder.
  const previous = path.join(root, 'public-release', '.previous');
  fs.mkdirSync(previous, { recursive: true });
  fs.renameSync(output, path.join(previous, `ProjectHub-${Date.now()}`));
}
fs.mkdirSync(output, { recursive: true });
for (const { name, content, mode } of entries) {
  const target = path.join(output, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
}
console.log(`Exported ${entries.length} files to public-release/ProjectHub (no Git history).`);
