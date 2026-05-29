import { FileIndex, slugify, type FileRecord } from './file-index';

// Left-rail sidebar listing every file this browser has touched. Clicking a
// file changes the URL hash, which the existing `hashchange` handler in
// main.ts catches and reloads on. "+ New" opens a modal that takes a name,
// slugifies it into a fileId, and navigates.
export class FileSidebar {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private fileIndex: FileIndex;
  private currentFileId: string;

  constructor(parent: HTMLElement, fileIndex: FileIndex, currentFileId: string) {
    this.fileIndex = fileIndex;
    this.currentFileId = currentFileId;

    this.el = document.createElement('aside');
    this.el.className = 'sidebar';
    this.el.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-title">Files</span>
        <button class="sidebar-new-btn" type="button">+ New</button>
      </div>
      <div class="sidebar-list"></div>
    `;
    this.listEl = this.el.querySelector('.sidebar-list')!;
    parent.appendChild(this.el);

    this.el.querySelector<HTMLButtonElement>('.sidebar-new-btn')!
      .addEventListener('click', () => this.openNewFileModal());

    void this.refresh();
  }

  async refresh(): Promise<void> {
    const files = await this.fileIndex.list();
    files.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));

    if (files.length === 0) {
      this.listEl.innerHTML = '<div class="sidebar-empty">No files yet — click + New to create one.</div>';
      return;
    }

    this.listEl.innerHTML = files
      .map((f) => this.renderItem(f))
      .join('');

    for (const btn of this.listEl.querySelectorAll<HTMLButtonElement>('.sidebar-item')) {
      btn.addEventListener('click', () => {
        const fileId = btn.dataset.file!;
        if (fileId !== this.currentFileId) window.location.hash = fileId;
      });
    }
  }

  private renderItem(f: FileRecord): string {
    const isActive = f.fileId === this.currentFileId;
    const showSlug = f.displayName !== f.fileId;
    return `
      <button class="sidebar-item ${isActive ? 'active' : ''}" data-file="${escapeAttr(f.fileId)}" title="${escapeAttr(f.displayName)}">
        <div class="sidebar-item-name">${escapeHtml(f.displayName)}</div>
        ${showSlug ? `<div class="sidebar-item-id">#${escapeHtml(f.fileId)}</div>` : ''}
      </button>
    `;
  }

  private openNewFileModal(): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const panel = document.createElement('div');
    panel.className = 'modal-panel';
    panel.innerHTML = `
      <h2 class="modal-title">New file</h2>
      <p class="modal-sub">
        Give the file a name. Collaborators on the same URL share the same document, so pick
        something everyone can agree on.
      </p>
      <label class="modal-label">File name</label>
      <input type="text" class="modal-input new-file-input" placeholder="e.g. Chapter 3 — Methodology" maxlength="120" />
      <p class="modal-hint new-file-preview">URL: …/#</p>
      <div class="modal-actions">
        <button class="btn cancel-btn">Cancel</button>
        <button class="btn btn-primary create-btn">Create</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const input = panel.querySelector<HTMLInputElement>('.new-file-input')!;
    const preview = panel.querySelector<HTMLParagraphElement>('.new-file-preview')!;
    const cancel = panel.querySelector<HTMLButtonElement>('.cancel-btn')!;
    const create = panel.querySelector<HTMLButtonElement>('.create-btn')!;

    const updatePreview = () => {
      const slug = slugify(input.value);
      preview.textContent = `URL: …/#${slug}`;
    };
    input.addEventListener('input', updatePreview);
    updatePreview();

    const submit = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const slug = slugify(name);
      create.disabled = true;
      try {
        await this.fileIndex.recordVisit(slug, name);
        overlay.remove();
        if (slug === this.currentFileId) {
          // Already here — just refresh the list so the rename shows.
          void this.refresh();
        } else {
          window.location.hash = slug;
        }
      } catch (err) {
        create.disabled = false;
        alert(`Failed to create file: ${err instanceof Error ? err.message : err}`);
      }
    };

    create.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    cancel.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    setTimeout(() => input.focus(), 0);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
