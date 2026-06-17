window.AppModules = window.AppModules || {};

window.AppModules.files = {
  state() {
    return {
      fileRoots: [],
      fileRoot: 'workspaces',
      filePath: '',
      fileParentPath: null,
      fileEntries: [],
      filesLoading: false,
      filesError: '',
      fileFilter: '',
      selectedFile: null,
      filePreview: null,
      filePreviewLoading: false,
      filePreviewError: '',
      fileEditMode: false,
      fileEditContent: '',
      fileSaving: false,
      fileSearchResults: [],
      fileSearching: false,
      fileFavorites: [],
      showFileAction: false,
      fileActionType: 'file',
      fileActionName: '',
      fileActionError: '',
      fileActionSaving: false,
    };
  },

  methods: {
    async loadFileRoots() {
      try {
        const r = await fetch('api/files/roots');
        this.fileRoots = await r.json();
        this.markApiOk();
        this.loadFileFavorites();
        if (!this.fileRoots.some(root => root.id === this.fileRoot)) {
          this.fileRoot = (this.fileRoots[0] && this.fileRoots[0].id) || 'workspaces';
        }
        if (this.fileEntries.length === 0) await this.loadFiles(this.filePath || '');
      } catch (err) {
        this.filesError = err.message;
        this.reportApiError('File roots load failed', err);
      }
    },

    currentFileRootLabel() {
      const root = this.fileRoots.find(r => r.id === this.fileRoot);
      return root ? root.label : this.fileRoot;
    },

    async openFileRoot(rootId) {
      this.fileRoot = rootId;
      this.fileFilter = '';
      this.selectedFile = null;
      this.filePreview = null;
      await this.loadFiles('');
    },

    async loadFiles(pathValue = this.filePath) {
      this.filesLoading = true;
      this.filesError = '';
      try {
        const params = new URLSearchParams({ root: this.fileRoot, path: pathValue || '' });
        const r = await fetch(`api/files?${params}`);
        const data = await r.json();
        if (!r.ok) { this.filesError = data.error || 'Failed to load folder'; return; }
        this.markApiOk();
        this.filePath = data.path || '';
        this.fileParentPath = data.parentPath;
        this.fileEntries = data.entries || [];
        this.selectedFile = null;
        this.filePreview = null;
        this.filePreviewError = '';
        this.fileEditMode = false;
        this.fileSearchResults = [];
      } catch (err) {
        this.filesError = err.message;
        this.reportApiError('Folder load failed', err);
      } finally {
        this.filesLoading = false;
      }
    },

    filteredFileEntries() {
      const q = this.fileFilter.trim().toLowerCase();
      if (this.fileSearchResults.length > 0) return this.fileSearchResults;
      if (!q) return this.fileEntries;
      return this.fileEntries.filter(entry => entry.name.toLowerCase().includes(q));
    },

    fileBreadcrumbs() {
      if (!this.filePath) return [];
      const parts = this.filePath.split('/').filter(Boolean);
      return parts.map((name, idx) => ({
        name,
        path: parts.slice(0, idx + 1).join('/'),
      }));
    },

    openFileEntry(entry) {
      this.selectedFile = entry;
      this.filePreview = null;
      this.filePreviewError = '';
      this.fileEditMode = false;
      this.fileEditContent = '';
      if (entry.isDirectory) return;
      this.loadFilePreview(entry);
    },

    async loadFilePreview(entry) {
      this.filePreviewLoading = true;
      this.filePreviewError = '';
      try {
        const params = new URLSearchParams({ root: this.fileRoot, path: entry.path });
        const r = await fetch(`api/files/content?${params}`);
        const data = await r.json();
        if (!r.ok) { this.filePreviewError = data.error || 'Preview failed'; return; }
        this.markApiOk();
        this.filePreview = data;
        this.fileEditContent = data.content || '';
      } catch (err) {
        this.filePreviewError = err.message;
        this.notify('File preview failed', 'error');
      } finally {
        this.filePreviewLoading = false;
      }
    },

    fileRawUrl(entry) {
      const params = new URLSearchParams({ root: this.fileRoot, path: entry.path });
      return `api/files/raw?${params}`;
    },

    isMarkdownFile(entry) {
      return entry && entry.extension === 'md';
    },

    renderedMarkdown() {
      if (!this.filePreview?.content) return '';
      return this.filePreview.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/^### (.*)$/gm, '<h3 class="text-sm text-white font-semibold mt-3 mb-1">$1</h3>')
        .replace(/^## (.*)$/gm, '<h2 class="text-base text-white font-semibold mt-4 mb-2">$1</h2>')
        .replace(/^# (.*)$/gm, '<h1 class="text-lg text-white font-semibold mb-2">$1</h1>')
        .replace(/\n/g, '<br>');
    },

    async saveFileContent() {
      if (!this.selectedFile) return;
      this.fileSaving = true;
      this.filePreviewError = '';
      try {
        const params = new URLSearchParams({ root: this.fileRoot, path: this.selectedFile.path });
        const r = await fetch(`api/files/content?${params}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: this.fileEditContent }),
        });
        const data = await r.json();
        if (!r.ok) { this.filePreviewError = data.error || 'Save failed'; return; }
        this.filePreview.content = this.fileEditContent;
        this.selectedFile.size = data.size;
        this.selectedFile.modifiedAt = data.modifiedAt;
        this.fileEditMode = false;
        this.notify('File saved');
      } catch (err) {
        this.filePreviewError = err.message;
        this.notify('File save failed', 'error');
      } finally {
        this.fileSaving = false;
      }
    },

    async searchFiles() {
      const q = this.fileFilter.trim();
      if (!q) { this.fileSearchResults = []; return; }
      this.fileSearching = true;
      this.filesError = '';
      try {
        const params = new URLSearchParams({ root: this.fileRoot, path: this.filePath || '', q, limit: '80' });
        const r = await fetch(`api/files/search?${params}`);
        const data = await r.json();
        if (!r.ok) { this.filesError = data.error || 'Search failed'; return; }
        this.markApiOk();
        this.fileSearchResults = data.results || [];
      } catch (err) {
        this.filesError = err.message;
        this.notify('File search failed', 'error');
      } finally {
        this.fileSearching = false;
      }
    },

    fileFavoriteKey(entry = this.selectedFile) {
      return entry ? `${this.fileRoot}:${entry.path}` : '';
    },

    loadFileFavorites() {
      try {
        this.fileFavorites = JSON.parse(localStorage.getItem('system-file-favorites') || '[]');
      } catch {
        this.fileFavorites = [];
      }
    },

    saveFileFavorites() {
      localStorage.setItem('system-file-favorites', JSON.stringify(this.fileFavorites));
    },

    isFavoriteFile(entry = this.selectedFile) {
      const key = this.fileFavoriteKey(entry);
      return Boolean(key && this.fileFavorites.some(fav => fav.key === key));
    },

    toggleFileFavorite(entry = this.selectedFile) {
      if (!entry) return;
      const key = this.fileFavoriteKey(entry);
      if (this.isFavoriteFile(entry)) {
        this.fileFavorites = this.fileFavorites.filter(fav => fav.key !== key);
      } else {
        this.fileFavorites.unshift({ key, root: this.fileRoot, path: entry.path, name: entry.name, isDirectory: entry.isDirectory });
      }
      this.saveFileFavorites();
    },

    async openFileFavorite(fav) {
      this.fileRoot = fav.root;
      const parent = fav.isDirectory ? fav.path : fav.path.split('/').slice(0, -1).join('/');
      await this.loadFiles(parent);
      const entry = this.fileEntries.find(item => item.path === fav.path);
      if (entry) this.openFileEntry(entry);
    },

    async copyFilePath(entry = this.selectedFile) {
      if (!entry) return;
      try {
        await navigator.clipboard.writeText(entry.path);
        this.notify('Copied file path');
      } catch {
        this.notify('Could not copy file path', 'error');
      }
    },

    openCreateFileAction(type) {
      this.fileActionType = type;
      this.fileActionName = '';
      this.fileActionError = '';
      this.showFileAction = true;
    },

    async submitFileAction() {
      this.fileActionError = '';
      this.fileActionSaving = true;
      try {
        const r = await fetch('api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: this.fileRoot, parentPath: this.filePath || '', name: this.fileActionName, type: this.fileActionType }),
        });
        const data = await r.json();
        if (!r.ok) { this.fileActionError = data.error || 'Create failed'; return; }
        this.showFileAction = false;
        await this.loadFiles(this.filePath);
        const entry = this.fileEntries.find(item => item.path === data.path);
        if (entry) this.openFileEntry(entry);
        this.notify(`${this.fileActionType === 'folder' ? 'Folder' : 'File'} created`);
      } catch (err) {
        this.fileActionError = err.message;
      } finally {
        this.fileActionSaving = false;
      }
    },

    async renameSelectedFile() {
      if (!this.selectedFile) return;
      const newName = prompt('Rename to:', this.selectedFile.name);
      if (!newName || newName === this.selectedFile.name) return;
      try {
        const r = await fetch('api/files', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: this.fileRoot, path: this.selectedFile.path, newName }),
        });
        const data = await r.json();
        if (!r.ok) { this.notify(data.error || 'Rename failed', 'error'); return; }
        await this.loadFiles(this.filePath);
        const entry = this.fileEntries.find(item => item.path === data.path);
        if (entry) this.openFileEntry(entry);
        this.notify('Renamed');
      } catch (err) {
        this.notify(err.message, 'error');
      }
    },

    confirmDeleteSelectedFile() {
      if (!this.selectedFile) return;
      this.confirmDelete = {
        show: true,
        name: `${this.selectedFile.isDirectory ? 'folder' : 'file'}: ${this.selectedFile.name}`,
        action: async () => {
          const r = await fetch('api/files', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root: this.fileRoot, path: this.selectedFile.path }),
          });
          if (!r.ok) throw new Error((await r.json()).error || 'Delete failed');
          this.confirmDelete.show = false;
          await this.loadFiles(this.filePath);
          this.notify('Deleted');
        },
      };
    },
  },
};
