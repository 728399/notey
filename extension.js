const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const NOTY_MIME = 'application/vnd.code.tree.notyview';

const pad = n => String(n).padStart(2, '0');
const cfg = () => vscode.workspace.getConfiguration('noty');
const getFolder = () => cfg().get('folder');

const INVALID = /[\\/:*?"<>|]/;
const INVALID_MSG = 'Cannot contain these characters: \\ / : * ? " < > |';
const sanitizeExt = e => (e || '').replace(/^\.+/, '').trim();

function formatDate(fmt, d) {
  const tokens = {
    'YYYY': String(d.getFullYear()),
    'YY': pad(d.getFullYear() % 100),
    'MMMM': MONTHS[d.getMonth()],
    'MMM': MONTHS_SHORT[d.getMonth()],
    'MM': pad(d.getMonth() + 1),
    'DD': pad(d.getDate()),
    'dddd': DAYS[d.getDay()],
    'ddd': DAYS_SHORT[d.getDay()]
  };
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|DD|dddd|ddd/g, m => tokens[m]);
}

class NotesProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() { this._emitter.fire(); }
  getTreeItem(el) { return el; }
  async getChildren(el) {
    const root = getFolder();
    if (!root) return [];
    const dir = el ? el.resourceUri.fsPath : root;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return []; }
    const folders = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile()).sort((a, b) => b.name.localeCompare(a.name));
    const items = [];
    for (const f of folders) {
      const uri = vscode.Uri.file(path.join(dir, f.name));
      const it = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Collapsed);
      it.contextValue = 'folder';
      it.resourceUri = uri;
      items.push(it);
    }
    for (const f of files) {
      const uri = vscode.Uri.file(path.join(dir, f.name));
      const it = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
      it.contextValue = 'file';
      it.resourceUri = uri;
      it.command = { command: 'noty.openItem', title: 'Open', arguments: [uri] };
      items.push(it);
    }
    return items;
  }
}

class NotesDragAndDrop {
  constructor() {
    this.dropMimeTypes = [NOTY_MIME];
    this.dragMimeTypes = [NOTY_MIME];
  }
  handleDrag(source, dataTransfer) {
    const paths = source.filter(s => s.resourceUri).map(s => s.resourceUri.fsPath);
    dataTransfer.set(NOTY_MIME, new vscode.DataTransferItem(paths));
  }
  async handleDrop(target, dataTransfer) {
    const transfer = dataTransfer.get(NOTY_MIME);
    if (!transfer) return;
    const sources = transfer.value;
    if (!Array.isArray(sources) || !sources.length) return;
    let destDir;
    if (target && target.resourceUri) {
      destDir = target.contextValue === 'folder' ? target.resourceUri.fsPath : path.dirname(target.resourceUri.fsPath);
    } else {
      destDir = getFolder();
    }
    if (!destDir) return;
    const skipped = [];
    for (const src of sources) {
      try {
        const dest = path.join(destDir, path.basename(src));
        if (dest === src) continue;
        const isDir = fs.statSync(src).isDirectory();
        if (isDir && (dest === src || dest.startsWith(src + path.sep))) { skipped.push(path.basename(src)); continue; }
        if (fs.existsSync(dest)) { skipped.push(path.basename(src)); continue; }
        fs.renameSync(src, dest);
      } catch (e) { skipped.push(path.basename(src)); }
    }
    provider.refresh();
    if (skipped.length) vscode.window.showWarningMessage('Noty could not move (name already exists or invalid target): ' + skipped.join(', '));
  }
}

let provider;
let extensionId = 'local.noty';

const folderOf = item => (item && item.contextValue === 'folder' && item.resourceUri) ? item.resourceUri.fsPath : getFolder();

async function chooseFolder() {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this notes folder' });
  if (!picked) return;
  await cfg().update('folder', picked[0].fsPath, vscode.ConfigurationTarget.Global);
  provider.refresh();
}

async function openItem(uri) {
  await vscode.commands.executeCommand('vscode.open', uri);
}

async function promptCreateNote(dir) {
  const name = await vscode.window.showInputBox({
    prompt: 'New note name (you can include an extension)',
    placeHolder: 'my-note',
    validateInput: v => !v || !v.trim() ? 'Name cannot be empty.' : (INVALID.test(v) ? INVALID_MSG : undefined)
  });
  if (!name) return;
  const ext = sanitizeExt(cfg().get('fileExtension') || 'txt') || 'txt';
  const finalName = path.extname(name) ? name : `${name}.${ext}`;
  const file = path.join(dir, finalName);
  if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, '', 'utf8'); }
  provider.refresh();
  await openItem(vscode.Uri.file(file));
}

async function promptCreateFolder(dir) {
  const name = await vscode.window.showInputBox({
    prompt: 'New folder name',
    validateInput: v => !v || !v.trim() ? 'Name cannot be empty.' : (INVALID.test(v) ? INVALID_MSG : undefined)
  });
  if (!name) return;
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  provider.refresh();
}

// Toolbar actions always target the notes folder root.
async function newNote() {
  if (!getFolder()) { vscode.window.showWarningMessage('Choose a notes folder first.'); return; }
  await promptCreateNote(getFolder());
}
async function newFolder() {
  if (!getFolder()) { vscode.window.showWarningMessage('Choose a notes folder first.'); return; }
  await promptCreateFolder(getFolder());
}

// Context-menu actions target the right-clicked folder.
async function newNoteInFolder(item) {
  if (!getFolder()) { vscode.window.showWarningMessage('Choose a notes folder first.'); return; }
  await promptCreateNote(folderOf(item));
}
async function newFolderInFolder(item) {
  if (!getFolder()) { vscode.window.showWarningMessage('Choose a notes folder first.'); return; }
  await promptCreateFolder(folderOf(item));
}

async function newDailyNote() {
  if (!getFolder()) { await chooseFolder(); if (!getFolder()) return; }
  const sub = (cfg().get('dailyNoteSubfolder') || '').trim();
  const dir = sub ? path.join(getFolder(), sub) : getFolder();
  const now = new Date();
  const fmt = cfg().get('dailyNoteDateFormat') || 'YYYY-MM-DD';
  const ext = sanitizeExt(cfg().get('fileExtension') || 'txt');
  if (!ext || INVALID.test(ext)) {
    vscode.window.showErrorMessage('Invalid "noty.fileExtension" setting. Use letters and numbers only, e.g. txt.');
    return;
  }
  const base = formatDate(fmt, now);
  if (!base || INVALID.test(base)) {
    vscode.window.showErrorMessage('Invalid "noty.dailyNoteDateFormat" setting: the resulting filename contains illegal characters (\\ / : * ? " < > |).');
    return;
  }
  const file = path.join(dir, `${base}.${ext}`);
  if (!fs.existsSync(file)) {
    const tpl = (cfg().get('dailyNoteTemplate') || '{date} ({day})\n\n')
      .replace(/{date}/g, base)
      .replace(/{day}/g, DAYS[now.getDay()]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, tpl, 'utf8');
  }
  provider.refresh();
  await openItem(vscode.Uri.file(file));
}

async function renameItem(item) {
  if (!item || !item.resourceUri) return;
  const oldPath = item.resourceUri.fsPath;
  const base = path.basename(oldPath);
  const dot = base.lastIndexOf('.');
  const selEnd = dot > 0 ? dot : base.length;
  const name = await vscode.window.showInputBox({
    title: `Rename "${base}"`,
    prompt: 'Type the new name, including the extension.',
    value: base,
    valueSelection: [0, selEnd],
    validateInput: v => {
      if (!v || !v.trim()) return 'Name cannot be empty.';
      if (INVALID.test(v)) return INVALID_MSG;
      if (v !== base && fs.existsSync(path.join(path.dirname(oldPath), v))) return 'A file or folder with that name already exists.';
      return undefined;
    }
  });
  if (!name || name === base) return;
  fs.renameSync(oldPath, path.join(path.dirname(oldPath), name));
  provider.refresh();
}

async function deleteItem(item) {
  if (!item || !item.resourceUri) return;
  const p = item.resourceUri.fsPath;
  const choice = await vscode.window.showWarningMessage(`Delete "${path.basename(p)}"?`, { modal: true }, 'Delete');
  if (choice !== 'Delete') return;
  fs.rmSync(p, { recursive: true, force: true });
  provider.refresh();
}

function openSettings() {
  vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + extensionId);
}

function changeShortcut() {
  vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'Noty: New Daily Note');
}

function editTemplate() {
  vscode.commands.executeCommand('workbench.action.openSettings', '@id:noty.dailyNoteTemplate');
}

function activate(context) {
  extensionId = context.extension.id;
  provider = new NotesProvider();
  context.subscriptions.push(vscode.window.createTreeView('notyView', {
    treeDataProvider: provider,
    showCollapseAll: false,
    dragAndDropController: new NotesDragAndDrop()
  }));
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('noty.chooseFolder', chooseFolder);
  reg('noty.refresh', () => provider.refresh());
  reg('noty.newNote', newNote);
  reg('noty.newNoteInFolder', newNoteInFolder);
  reg('noty.newDailyNote', newDailyNote);
  reg('noty.newFolder', newFolder);
  reg('noty.newFolderInFolder', newFolderInFolder);
  reg('noty.openSettings', openSettings);
  reg('noty.changeShortcut', changeShortcut);
  reg('noty.editTemplate', editTemplate);
  reg('noty.openItem', openItem);
  reg('noty.rename', renameItem);
  reg('noty.delete', deleteItem);
}

function deactivate() {}

module.exports = { activate, deactivate };
