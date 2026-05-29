import { IdentityStore, shortThumb, type IdentityBundle, type SelfIdentity } from './identity-store';

export class IdentityUI {
  private store: IdentityStore;
  private badge: HTMLElement | null = null;
  private onChange?: () => void;

  constructor(store: IdentityStore, onChange?: () => void) {
    this.store = store;
    this.onChange = onChange;
  }

  mountBadge(container: HTMLElement): HTMLElement {
    const badge = document.createElement('button');
    badge.className = 'identity-badge';
    badge.type = 'button';
    container.appendChild(badge);
    this.badge = badge;
    this.refreshBadge();
    badge.addEventListener('click', () => this.openManagePanel());
    return badge;
  }

  private refreshBadge(): void {
    if (!this.badge) return;
    const self = this.store.getSelf();
    this.badge.innerHTML = `
      <span class="identity-badge-handle">${escapeHtml(self.handle)}</span>
      <span class="identity-badge-thumb">${shortThumb(self.thumbprint)}</span>
    `;
  }

  showFirstRunModal(): Promise<SelfIdentity> {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const panel = document.createElement('div');
      panel.className = 'modal-panel';
      panel.innerHTML = `
        <h2 class="modal-title">Welcome to thesis</h2>
        <p class="modal-sub">
          We'll generate a cryptographic identity for you. Every keystroke you make in a session
          gets signed with this identity — that's how your authorship gets proven.
        </p>
        <label class="modal-label">Your handle</label>
        <input type="text" class="modal-input" placeholder="e.g. david" maxlength="40" />
        <p class="modal-hint">
          Display name only. The real proof is your cryptographic key, generated next.
          You'll want to back it up after.
        </p>
        <div class="modal-actions">
          <button class="btn" id="restore-backup">Restore from backup</button>
          <button class="btn btn-primary" id="confirm-handle">Generate Identity</button>
        </div>
      `;
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      const input = panel.querySelector<HTMLInputElement>('.modal-input')!;
      const confirm = panel.querySelector<HTMLButtonElement>('#confirm-handle')!;
      const restore = panel.querySelector<HTMLButtonElement>('#restore-backup')!;

      const submit = async () => {
        const handle = input.value.trim();
        if (!handle) {
          input.focus();
          return;
        }
        confirm.disabled = true;
        restore.disabled = true;
        confirm.textContent = 'Generating…';
        try {
          const self = await this.store.createSelf(handle);
          overlay.remove();
          resolve(self);
        } catch (err) {
          confirm.disabled = false;
          restore.disabled = false;
          confirm.textContent = 'Generate Identity';
          alert(`Failed to create identity: ${err instanceof Error ? err.message : err}`);
        }
      };

      restore.addEventListener('click', async () => {
        const file = await pickFile('.json');
        if (!file) return;
        try {
          const bundle = JSON.parse(await file.text()) as IdentityBundle;
          const self = await this.store.restoreFromBackup(bundle);
          overlay.remove();
          resolve(self);
        } catch (err) {
          alert(`Failed to restore: ${err instanceof Error ? err.message : err}`);
        }
      });

      confirm.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });

      setTimeout(() => input.focus(), 0);
    });
  }

  // Public entry point: opens the manage panel. Used both by the badge click
  // and the backup-nag banner's "Back up now" button.
  openBackupFlow(): void {
    this.openManagePanel();
  }

  openManagePanel(): void {
    const overlay = createOverlay();
    const panel = document.createElement('div');
    panel.className = 'modal-panel modal-panel-wide';
    const self = this.store.getSelf();
    panel.innerHTML = `
      <h2 class="modal-title">Identity</h2>

      <section class="modal-section">
        <h3 class="modal-section-title">YOU</h3>
        <div class="identity-card">
          <div class="identity-card-handle">${escapeHtml(self.handle)}</div>
          <div class="identity-card-thumb" title="${self.thumbprint}">${shortThumb(self.thumbprint)}</div>
        </div>
        <div class="modal-button-row">
          <button class="btn" id="share-public">Share Public Identity</button>
          <button class="btn btn-primary" id="backup-private">Backup My Identity (PRIVATE)</button>
        </div>
        <p class="modal-hint" id="backup-warning">
          You haven't backed up your identity yet. If you lose this browser's data, the key is gone forever.
        </p>
      </section>

      <section class="modal-section">
        <h3 class="modal-section-title">CO-AUTHORS</h3>
        <div id="coauthor-list"></div>
        <div class="modal-button-row">
          <button class="btn" id="import-coauthor">Import Co-Author Identity</button>
        </div>
      </section>

      <div class="modal-actions">
        <button class="btn" id="close-panel">Close</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    panel.querySelector<HTMLButtonElement>('#close-panel')!.addEventListener('click', () => overlay.remove());

    panel.querySelector<HTMLButtonElement>('#share-public')!.addEventListener('click', () => {
      const bundle = this.store.exportPublicBundle();
      downloadJson(`${self.handle}-public-identity.json`, bundle);
    });

    panel.querySelector<HTMLButtonElement>('#backup-private')!.addEventListener('click', async () => {
      const ok = window.confirm(
        'This file contains your PRIVATE KEY. Anyone with this file can sign as you.\n\n' +
        'Save it somewhere safe (encrypted disk, password manager) and never share it.\n\n' +
        'Continue?'
      );
      if (!ok) return;
      const bundle = this.store.exportBackupBundle();
      downloadJson(`${self.handle}-PRIVATE-identity-backup.json`, bundle);
      await this.store.markBackedUp();
      const warning = panel.querySelector<HTMLParagraphElement>('#backup-warning');
      if (warning) warning.style.display = 'none';
    });

    panel.querySelector<HTMLButtonElement>('#import-coauthor')!.addEventListener('click', async () => {
      const file = await pickFile('.json');
      if (!file) return;
      try {
        const bundle = JSON.parse(await file.text()) as IdentityBundle;
        const added = await this.store.addCoAuthor(bundle);
        await refreshCoAuthors();
        this.onChange?.();
        alert(`Added co-author: ${added.handle} (${shortThumb(added.thumbprint)})`);
      } catch (err) {
        alert(`Failed to import co-author: ${err instanceof Error ? err.message : err}`);
      }
    });

    const refreshCoAuthors = async () => {
      const list = panel.querySelector<HTMLDivElement>('#coauthor-list')!;
      const coAuthors = await this.store.listCoAuthors();
      if (coAuthors.length === 0) {
        list.innerHTML = '<div class="modal-empty">No co-authors yet. Import their Public Identity bundle to add them.</div>';
      } else {
        list.innerHTML = coAuthors.map((c) => `
          <div class="identity-card">
            <div class="identity-card-handle">${escapeHtml(c.handle)}</div>
            <div class="identity-card-thumb" title="${c.thumbprint}">${shortThumb(c.thumbprint)}</div>
          </div>
        `).join('');
      }
    };
    refreshCoAuthors();
  }
}

function createOverlay(): HTMLDivElement {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  return o;
}

function downloadJson(filename: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
    });
    input.click();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
