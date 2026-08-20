class NotesPage {
    constructor() {
      this.dbName = 'NotesScratchpadDB';
      this.storeName = 'notes';
      this.dbVersion = 1;
      this.db = null;
      this.notesList = [];
      this.activeDialogs = new Map(); // Track DOM instances of active dialogs
    }

    // Initialize the page view
    render(app) {
      this.app = app;
      this.applyStyles();

      // Core workspace container
      const container = makeElement('div', { className: 'notes-page-container' });

      // Create toolbar and canvas area
      this.toolbar = this.buildToolbar();
      this.canvas = makeElement('div', { className: 'notes-canvas-area' });
      
      container.appendChild(this.toolbar);
      container.appendChild(this.canvas);

      // Connect database and load notes
      this.initDB().then(() => {
        this.loadAndDisplayNotes();
      });

      // Add a paste event listener on the container to streamline pasting anywhere
      container.addEventListener('paste', (e) => this.handleGlobalPasteEvent(e));

      return container;
    }

    // --- INDEXEDDB DATA LAYER ---
    async initDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.dbVersion);

        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
          }
        };

        request.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this.db);
        };

        request.onerror = (e) => {
          console.error('IndexedDB open error:', e);
          reject(e);
        };
      });
    }

    async getAllNotesFromDB() {
      return new Promise((resolve) => {
        const tx = this.db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(tx.objectStoreNames[0]);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      });
    }

    // --- PERSISTENCE TRANSACTION LAYER FIXED FOR AUTOINCREMENTS ---
    async saveNoteToDB(note) {
      return new Promise((resolve) => {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(tx.objectStoreNames[0]);
        
        // Deep clone object to avoid mutating internal reference keys before saving
        const noteToSave = { ...note };
        
        // If ID is null, undefined, or temporary, omit it so IndexedDB auto-increments
        if (noteToSave.id === undefined || noteToSave.id === null) {
          delete noteToSave.id;
        }

        const request = store.put(noteToSave);
        request.onsuccess = (e) => {
          note.id = e.target.result; // Bind the generated ID back to memory reference
          resolve(note);
        };
        request.onerror = (err) => {
          console.error('IndexedDB Put Error:', err);
          resolve(null);
        };
      });
    }

    async deleteNoteFromDB(id) {
      return new Promise((resolve) => {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(tx.objectStoreNames[0]);
        const request = store.delete(id);
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
      });
    }

    async clearAllNotesFromDB() {
      return new Promise((resolve) => {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(tx.objectStoreNames[0]);
        const request = store.clear();
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
      });
    }

    // --- PROGRAMMATIC EXPOSURE ---
    loadAndDisplayNotes() {
      // Expose a public API on window so LLMs can dynamically run commands to inject notes
      window.Scratchpad = {
        addNote: (options) => {
          this.createNoteFromParsedObj(options || {});
          return 'Note created in scratchpad';
        },
        clearAll: () => {
          this.handleClearAllClick();
          return 'Clearing database requested';
        },
        getAll: () => this.getAllNotesFromDB()
      };

      return this.getAllNotesFromDB().then(list => {
        this.notesList = list;
        
        // If DB is completely empty, initialize with helper defaults
        if (this.notesList.length === 0) {
          return this.loadDefaultInstructions().then(() => {
            return this.getAllNotesFromDB().then(freshList => {
              this.notesList = freshList;
              this.rebuildCanvasFromList();
            });
          });
        } else {
          this.rebuildCanvasFromList();
        }
      });
    }

    async loadDefaultInstructions() {
      const defaults = [
        {
          content: "Welcome to your Scratchpad!\n\nThis workspace lets you keep random notes. They are stored safely inside your browser's IndexedDB database.\n\nYou can drag these dialog boxes around, resize them, copy text easily, or close them.",
          x: 50,
          y: 30,
          width: 320,
          height: 240,
          isOpen: true,
          timestamp: Date.now()
        },
        {
          content: "Programmatic Creations (JSON Mode):\n\nIf you paste a JSON string of a note, the scratchpad automatically parses coordinates, sizes, and content to place it precisely.\n\nTry copying note JSON and clicking 'Global Paste'!",
          x: 420,
          y: 80,
          width: 300,
          height: 220,
          isOpen: true,
          timestamp: Date.now()
        }
      ];
      for (const item of defaults) {
        await this.saveNoteToDB(item);
      }
    }

    // --- ENHANCED TOOLBAR WITH IMPORT/EXPORT ---
    buildToolbar() {
      const pasteBtn = makeElement('button', {
        className: 'notes-toolbar-btn primary',
        onclick: () => this.handleGlobalPasteClick()
      }, [
        makeElement('span', { style: { marginRight: '6px' } }, '📋'),
        'Global Paste'
      ]);

      const createBtn = makeElement('button', {
        className: 'notes-toolbar-btn secondary',
        onclick: () => this.handleInteractiveCreate()
      }, [
        makeElement('span', { style: { marginRight: '6px' } }, '➕'),
        'New Note'
      ]);

      const restoreBtn = makeElement('button', {
        className: 'notes-toolbar-btn secondary',
        onclick: () => this.handleRestoreClosedNotes()
      }, [
        makeElement('span', { style: { marginRight: '6px' } }, '🔄'),
        'Reopen Closed'
      ]);

      // NEW: Export to JSON file
      const exportBtn = makeElement('button', {
        className: 'notes-toolbar-btn secondary',
        title: 'Export notes to a JSON file',
        onclick: () => this.exportNotesToFile()
      }, [
        makeElement('span', { style: { marginRight: '6px' } }, '💾'),
        'Export File'
      ]);

      // NEW: Import from JSON file
      const fileInput = makeElement('input', {
        type: 'file',
        accept: '.json',
        style: { display: 'none' },
        onchange: (e) => this.handleFileImportSelection(e)
      });

      const importBtn = makeElement('button', {
        className: 'notes-toolbar-btn secondary',
        title: 'Import notes from a JSON file',
        onclick: () => fileInput.click()
      }, [
        makeElement('span', { style: { marginRight: '6px' } }, '📂'),
        'Import File',
        fileInput
      ]);

      const clearBtn = makeElement('button', {
        className: 'notes-toolbar-btn danger',
        onclick: () => this.handleClearAllClick()
      }, [
        makeElement('span', { style: { marginRight: '6px' } }, '🗑️'),
        'Clear All'
      ]);

      return makeElement('div', { className: 'notes-toolbar' }, [
        makeElement('div', { className: 'notes-toolbar-left' }, [
          makeElement('h3', { className: 'notes-toolbar-title' }, 'Scratchpad Notes'),
          makeElement('span', { className: 'notes-toolbar-subtitle' }, 'Persistent browser-level scratchpad')
        ]),
        makeElement('div', { className: 'notes-toolbar-actions' }, [
          pasteBtn,
          createBtn,
          restoreBtn,
          exportBtn,
          importBtn,
          clearBtn
        ])
      ]);
    }

    // --- ENHANCED SPAN DIALOG (CLEAN FIT & REMOVED REDUNDANT CLOSE BUTTONS) ---
    spawnNoteDialog(note) {
      if (this.activeDialogs.has(note.id)) {
        return;
      }

      if (!note.colorTheme) {
        note.colorTheme = 'slate';
      }
      
      if (note.isMinimized === undefined) {
        note.isMinimized = false;
      }

      // Default title value
      const noteTitle = note.title || `Note #${note.id}`;

      if (typeof UITools !== 'undefined' && typeof UITools.makeDialog === 'function') {
        const textElement = makeElement('textarea', {
          className: 'note-textarea',
          value: note.content || '',
          oninput: (e) => {
            note.content = e.target.value;
            this.saveNoteToDB(note);
          }
        });

        // Copy note contents
        const copyBtn = makeElement('button', {
          className: 'note-dialog-action-btn',
          title: 'Copy note text to clipboard',
          onclick: () => {
            navigator.clipboard.writeText(note.content || '').then(() => {
              this.app.showToastMessage('Copied note text!');
            });
          }
        }, 'Copy');

        // Paste note contents
        const pasteBtn = makeElement('button', {
          className: 'note-dialog-action-btn',
          title: 'Overwrite note with clipboard content',
          onclick: () => {
            navigator.clipboard.readText().then(text => {
              if (text) {
                textElement.value = text;
                note.content = text;
                this.saveNoteToDB(note);
                this.app.showToastMessage('Pasted into note!');
              }
            }).catch(() => {
              this.app.showToastMessage('Unable to access clipboard. Press Ctrl+V.');
            });
          }
        }, 'Paste');

        // Delete note dialog
        const deleteBtn = makeElement('button', {
          className: 'note-dialog-action-btn note-delete-btn',
          onclick: () => {
            this.promptCustomConfirm('Are you sure you want to permanently delete this note?', () => {
              this.deleteNoteFromDB(note.id);
              dialogObj.destroy();
              this.activeDialogs.delete(note.id);
              this.app.showToastMessage('Note deleted');
            });
          }
        }, 'Delete');

        // Palette selector
        const colors = ['slate', 'emerald', 'amber', 'blue', 'ruby'];
        const colorButtons = colors.map(c => {
          return makeElement('button', {
            className: `note-color-dot color-${c} ${note.colorTheme === c ? 'is-active' : ''}`,
            title: `Set ${c} theme`,
            onclick: (e) => {
              note.colorTheme = c;
              this.saveNoteToDB(note);
              this.updateNoteDialogColorClass(dialogObj.dialogElement, c);
              
              colorButtons.forEach(btn => btn.classList.remove('is-active'));
              e.currentTarget.classList.add('is-active');
            }
          });
        });

        const paletteContainer = makeElement('div', { className: 'note-color-palette' }, ...colorButtons);

        // Minimize / Expand toggle button
        const minimizeBtn = makeElement('button', {
          className: 'note-dialog-action-btn note-minimize-toggle-btn',
          title: note.isMinimized ? 'Expand note content' : 'Minimize note content',
          onclick: () => {
            note.isMinimized = !note.isMinimized;
            this.saveNoteToDB(note);
            
            this.applyNoteMinimizedState(dialogEl, note.isMinimized, note.width, note.height);
            minimizeBtn.title = note.isMinimized ? 'Expand note content' : 'Minimize note content';
            minimizeBtn.textContent = note.isMinimized ? 'Expand ⛶' : 'Minimize ⎯';
          }
        }, note.isMinimized ? 'Expand ⛶' : 'Minimize ⎯');

        // Clean layout: No redundant close button inside content
        const controlsWrapper = makeElement('div', { className: 'note-dialog-controls' }, [
          makeElement('div', { className: 'flex gap-2' }, [copyBtn, pasteBtn, paletteContainer]),
          makeElement('div', { className: 'flex gap-2' }, [minimizeBtn, deleteBtn])
        ]);

        // Strict sizing box constraints prevents horizontal scrollbars
        const innerBody = makeElement('div', { className: 'note-dialog-inner-body' }, [
          textElement,
          controlsWrapper
        ]);

        const bodyContainer = makeElement('div', { className: 'note-dialog-body' }, [
          innerBody
        ]);

        // Construct dialog via UITools
        const targetHeight = note.isMinimized ? 44 : (note.height || 220);
        const dialogObj = UITools.makeDialog({
          env: this.app.env,
          title: noteTitle,
          size: [note.width || 300, targetHeight],
          position: [note.x || 100, note.y || 100],
          contentElement: bodyContainer
        });

        const dialogEl = dialogObj.dialogElement;
        if (dialogEl) {
          dialogEl.addEventListener('mousedown', () => {
            this.bringNoteToFront(dialogEl);
          });

          dialogEl.addEventListener('click', (e) => {
            if (e.target !== textElement && e.target.tagName !== 'BUTTON' && !note.isMinimized) {
              textElement.focus();
            }
          });

          dialogEl.classList.add('note-workspace-dialog');
          this.updateNoteDialogColorClass(dialogEl, note.colorTheme);
          
          // Apply initial minimized state immediately on render
          this.applyNoteMinimizedState(dialogEl, note.isMinimized, note.width || 300, note.height || 220);

          // NEW: Make the title bar editable
          this.makeTitleEditable(dialogEl, note);
        }

        this.activeDialogs.set(note.id, dialogObj);
      } else {
        this.spawnFallbackNoteElement(note);
      }
    }

    spawnFallbackNoteElement(note) {
      const textElement = makeElement('textarea', {
        className: 'note-textarea',
        value: note.content || '',
        oninput: (e) => {
          note.content = e.target.value;
          this.saveNoteToDB(note);
        }
      });

      const element = makeElement('div', {
        className: 'fallback-note-dialog',
        style: {
          position: 'absolute',
          left: `${note.x}px`,
          top: `${note.y}px`,
          width: `${note.width || 280}px`,
          height: `${note.height || 200}px`
        }
      }, [
        makeElement('div', { className: 'fallback-note-header' }, `Note #${note.id}`),
        textElement
      ]);

      this.canvas.appendChild(element);
    }

    // --- COORDINATE ALIGNMENT (FREE-SPACE DETECTOR) ---
    findFreeSpace(desiredWidth = 300, desiredHeight = 220) {
      const margin = 20;
      const startX = 50;
      const startY = 40;
      const gridStepX = desiredWidth + margin;
      const gridStepY = desiredHeight + margin;

      const viewportWidth = this.canvas.offsetWidth || window.innerWidth - 100;
      const viewportHeight = this.canvas.offsetHeight || window.innerHeight - 300;

      const columns = Math.max(1, Math.floor(viewportWidth / gridStepX));
      const rows = Math.max(1, Math.floor(viewportHeight / gridStepY));

      // Map grid slots
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
          const testX = startX + c * gridStepX;
          const testY = startY + r * gridStepY;

          // Check if test coordinate overlaps with existing notes
          let hasOverlap = false;
          this.notesList.forEach(existing => {
            if (!existing.isOpen) return;
            const exX = existing.x || 0;
            const exY = existing.y || 0;
            const exW = existing.width || desiredWidth;
            const exH = existing.height || desiredHeight;

            const overlap = (testX < exX + exW && testX + desiredWidth > exX &&
                             testY < exY + exH && testY + desiredHeight > exY);
            if (overlap) {
              hasOverlap = true;
            }
          });

          if (!hasOverlap) {
            return { x: testX, y: testY };
          }
        }
      }

      // Default cascade fallback if grid is saturated
      const offset = (this.notesList.filter(n => n.isOpen).length % 10) * 25;
      return { x: startX + offset, y: startY + offset };
    }

    // --- CLIPBOARD & PASTING STRATEGY ---
    handleGlobalPasteEvent(e) {
      const clipboardData = e.clipboardData || window.clipboardData;
      if (!clipboardData) return;

      const text = clipboardData.getData('text');
      if (text) {
        this.processInputText(text);
      }
    }

    handleGlobalPasteClick() {
      navigator.clipboard.readText().then(text => {
        if (text) {
          this.processInputText(text);
        } else {
          this.app.showToastMessage('Clipboard is empty');
        }
      }).catch(() => {
        // Fallback notification for browsers requiring user key shortcuts
        this.promptCustomAlert('To read clipboard, please paste using Ctrl+V or Command+V inside this page.');
      });
    }

    // --- ROBUST CLIPBOARD PARSER (HANDLES JSON PRECISELY) ---
    processInputText(text) {
      let isParsed = false;
      const cleanText = text.trim();
      
      // Try parsing loose or standard JSON formats
      try {
        if (cleanText.startsWith('{') || cleanText.startsWith('[')) {
          const parsed = JSON.parse(cleanText);
          
          if (Array.isArray(parsed)) {
            // Bulk array creation
            parsed.forEach(item => this.createNoteFromParsedObj(item));
            isParsed = true;
            this.app.showToastMessage(`Imported ${parsed.length} notes`);
            this.loadAndDisplayNotes();
          } else if (typeof parsed === 'object') {
            // Single object creation
            this.createNoteFromParsedObj(parsed);
            isParsed = true;
            this.app.showToastMessage('Imported JSON note');
            this.loadAndDisplayNotes();
          }
        }
      } catch (err) {
        console.warn('JSON parsing failed, falling back to plain text:', err);
      }

      // Plain Text Fallback
      if (!isParsed) {
        this.promptCustomConfirm(`Do you want to save this text as a new note?\n\n"${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`, () => {
          const coords = this.findFreeSpace();
          const newNote = {
            content: text,
            x: coords.x,
            y: coords.y,
            width: 300,
            height: 220,
            isOpen: true,
            title: 'Pasted Note',
            timestamp: Date.now()
          };
          this.saveNoteToDB(newNote).then(saved => {
            this.notesList.push(saved);
            this.spawnNoteDialog(saved);
            this.app.showToastMessage('Created note from text');
          });
        });
      }
    }

    createNoteFromParsedObj(obj) {
      const coords = this.findFreeSpace(obj.width || 300, obj.height || 220);
      const newNote = {
        content: obj.content || obj.message || obj.text || 'Empty Note',
        x: typeof obj.x === 'number' ? obj.x : coords.x,
        y: typeof obj.y === 'number' ? obj.y : coords.y,
        width: obj.width || 300,
        height: obj.height || 220,
        isOpen: true,
        title: obj.title || 'Imported Note',
        colorTheme: obj.colorTheme || 'slate',
        timestamp: Date.now()
      };
      this.saveNoteToDB(newNote).then(saved => {
        this.notesList.push(saved);
        this.spawnNoteDialog(saved);
      });
    }

    handleInteractiveCreate() {
      const coords = this.findFreeSpace();
      const newNote = {
        content: 'New draft note...',
        x: coords.x,
        y: coords.y,
        width: 300,
        height: 220,
        isOpen: true,
        timestamp: Date.now()
      };
      this.saveNoteToDB(newNote).then(saved => {
        this.notesList.push(saved);
        this.spawnNoteDialog(saved);
      });
    }

    async handleRestoreClosedNotes() {
      const closed = this.notesList.filter(n => !n.isOpen);
      if (closed.length === 0) {
        this.app.showToastMessage('No closed notes to restore');
        return;
      }

      for (const note of closed) {
        note.isOpen = true;
        const coords = this.findFreeSpace(note.width, note.height);
        note.x = coords.x;
        note.y = coords.y;
        await this.saveNoteToDB(note);
        this.spawnNoteDialog(note);
      }
      this.app.showToastMessage(`Restored ${closed.length} closed notes`);
    }

    handleClearAllClick() {
      this.promptCustomConfirm('Are you sure you want to permanently clear all scratchpad data from this browser?', () => {
        this.clearAllNotesFromDB().then(() => {
          // Tear down active dialog instances
          this.activeDialogs.forEach(dialogObj => {
            if (dialogObj && typeof dialogObj.destroy === 'function') {
              dialogObj.destroy();
            }
          });
          this.activeDialogs.clear();
          this.canvas.innerHTML = '';
          this.notesList = [];
          this.app.showToastMessage('Cleared notes database');
        });
      });
    }

    // --- CUSTOM DECORATIVE DIALOG MODAL (NO ALERT BOXES) ---
    promptCustomConfirm(message, onConfirm) {
      const overlay = makeElement('div', { className: 'notes-modal-overlay' });
      
      const confirmBox = makeElement('div', { className: 'notes-modal-box' }, [
        makeElement('h4', { className: 'notes-modal-title' }, 'Action Request'),
        makeElement('p', { className: 'notes-modal-message' }, message),
        makeElement('div', { className: 'notes-modal-buttons' }, [
          makeElement('button', {
            className: 'notes-modal-btn cancel-btn',
            onclick: () => overlay.remove()
          }, 'Cancel'),
          makeElement('button', {
            className: 'notes-modal-btn confirm-btn',
            onclick: () => {
              overlay.remove();
              onConfirm();
            }
          }, 'Confirm')
        ])
      ]);

      overlay.appendChild(confirmBox);
      document.body.appendChild(overlay);
    }

    promptCustomAlert(message) {
      const overlay = makeElement('div', { className: 'notes-modal-overlay' });
      
      const alertBox = makeElement('div', { className: 'notes-modal-box' }, [
        makeElement('h4', { className: 'notes-modal-title' }, 'Notification'),
        makeElement('p', { className: 'notes-modal-message' }, message),
        makeElement('div', { className: 'notes-modal-buttons' }, [
          makeElement('button', {
            className: 'notes-modal-btn confirm-btn',
            onclick: () => overlay.remove()
          }, 'OK')
        ])
      ]);

      overlay.appendChild(alertBox);
      document.body.appendChild(overlay);
    }

    // --- ENHANCED FIT LAYOUT CLASSES (NO OVERFLOW SCROLLBARS) ---
    applyStyles() {
      applyCss(`
        .notes-page-container {
          display: flex;
          flex-direction: column;
          gap: 24px;
          min-height: calc(100vh - 200px);
          width: 100%;
        }

        .notes-toolbar {
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 16px;
          padding: 20px;
          background-color: var(--bg-panel);
          border: 1px solid var(--border-color);
          border-radius: 12px;
        }

        @media (min-width: 768px) {
          .notes-toolbar {
            flex-direction: row;
            align-items: center;
          }
        }

        .notes-toolbar-left {
          display: flex;
          flex-direction: column;
        }

        .notes-toolbar-title {
          font-size: 20px;
          font-weight: 800;
          color: var(--text-title);
          font-family: ui-monospace, monospace;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .notes-toolbar-subtitle {
          font-size: 12px;
          color: var(--text-secondary);
          margin-top: 2px;
        }

        .notes-toolbar-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .notes-toolbar-btn {
          padding: 8px 16px;
          font-size: 11px;
          font-family: ui-monospace, monospace;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-radius: 6px;
          border: 1px solid transparent;
          cursor: pointer;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
        }

        .notes-toolbar-btn.primary {
          background-color: #3b82f6;
          color: #ffffff;
        }

        .notes-toolbar-btn.primary:hover {
          background-color: #2563eb;
        }

        .notes-toolbar-btn.secondary {
          background-color: var(--btn-bg);
          border-color: var(--border-color);
          color: var(--btn-text);
        }

        .notes-toolbar-btn.secondary:hover {
          background-color: var(--btn-hover);
          color: var(--text-title);
        }

        .notes-toolbar-btn.danger {
          background-color: rgba(239, 68, 68, 0.1);
          border-color: rgba(239, 68, 68, 0.3);
          color: #ef4444;
        }

        .notes-toolbar-btn.danger:hover {
          background-color: #ef4444;
          color: #ffffff;
        }

        .notes-canvas-area {
          position: relative;
          flex: 1;
          min-height: 500px;
          background-color: var(--bg-panel-inner);
          border: 1px dashed var(--border-color);
          border-radius: 12px;
          overflow: auto;
          background-size: 20px 20px;
          background-image: 
            linear-gradient(to right, rgba(255, 255, 255, 0.015) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
        }

        .theme-light .notes-canvas-area {
          background-image: 
            linear-gradient(to right, rgba(100, 116, 139, 0.03) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(100, 116, 139, 0.03) 1px, transparent 1px);
        }

        /* Strict dialog sizing layout removes scrollbars */
        .note-dialog-body {
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          padding: 8px;
          box-sizing: border-box;
          overflow: hidden !important;
        }

        .note-dialog-inner-body {
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          gap: 10px;
          flex: 1;
          box-sizing: border-box;
          overflow: hidden !important;
        }

        .note-textarea {
          flex: 1;
          width: 100% !important;
          background-color: rgba(0, 0, 0, 0.2);
          border: 1px solid var(--border-color);
          border-radius: 6px;
          color: var(--text-primary);
          padding: 10px;
          font-size: 13.5px;
          line-height: 1.5;
          resize: none;
          outline: none;
          font-family: inherit;
          box-sizing: border-box !important;
          margin: 0;
        }

        .theme-light .note-textarea {
          background-color: rgba(255, 255, 255, 0.7);
        }

        .note-textarea:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
        }

        .note-dialog-controls {
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 100%;
          box-sizing: border-box;
        }

        .note-dialog-action-btn {
          padding: 5px 10px;
          font-size: 10.5px;
          font-family: ui-monospace, monospace;
          font-weight: 700;
          text-transform: uppercase;
          background-color: var(--btn-bg);
          border: 1px solid var(--border-color);
          color: var(--btn-text);
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .note-dialog-action-btn:hover {
          background-color: var(--btn-hover);
          color: var(--text-title);
        }

        .note-close-btn {
          color: #94a3b8;
        }

        .note-delete-btn {
          color: #f87171;
          border-color: rgba(239, 68, 68, 0.2);
        }

        .note-delete-btn:hover {
          background-color: rgba(239, 68, 68, 0.15);
          color: #ef4444;
        }

        .note-minimize-toggle-btn {
          color: #3b82f6;
          border-color: rgba(59, 130, 246, 0.2);
        }

        .note-minimize-toggle-btn:hover {
          background-color: rgba(59, 130, 246, 0.1);
        }

        /* Dialog Window Theme Customizations */
        .note-workspace-dialog {
          border: 1px solid var(--border-color) !important;
          transition: border-color 0.2s, box-shadow 0.2s, height 0.2s cubic-bezier(0.25, 1, 0.5, 1) !important;
          overflow: hidden !important;
        }

        .note-workspace-dialog.is-minimized {
          overflow: hidden !important;
        }

        /* Slate theme */
        .theme-color-slate {
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.45) !important;
        }
        
        /* Emerald theme */
        .theme-color-emerald {
          border-color: rgba(16, 185, 129, 0.3) !important;
          box-shadow: 0 10px 25px rgba(16, 185, 129, 0.12) !important;
        }

        /* Amber theme */
        .theme-color-amber {
          border-color: rgba(245, 158, 11, 0.3) !important;
          box-shadow: 0 10px 25px rgba(245, 158, 11, 0.12) !important;
        }

        /* Blue theme */
        .theme-color-blue {
          border-color: rgba(59, 130, 246, 0.3) !important;
          box-shadow: 0 10px 25px rgba(59, 130, 246, 0.12) !important;
        }

        /* Ruby theme */
        .theme-color-ruby {
          border-color: rgba(239, 68, 68, 0.3) !important;
          box-shadow: 0 10px 25px rgba(239, 68, 68, 0.12) !important;
        }

        /* Mini Color Picker dots */
        .note-color-palette {
          display: inline-flex;
          gap: 4px;
          align-items: center;
          margin-left: 8px;
        }

        .note-color-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          border: 1px solid rgba(255, 255, 255, 0.2);
          cursor: pointer;
          padding: 0;
          transition: transform 0.1s, box-shadow 0.1s;
        }

        .note-color-dot:hover {
          transform: scale(1.2);
        }

        .note-color-dot.is-active {
          transform: scale(1.3);
          border-color: #ffffff;
          box-shadow: 0 0 4px #ffffff;
        }

        .note-color-dot.color-slate { background-color: #475569; }
        .note-color-dot.color-emerald { background-color: #10b981; }
        .note-color-dot.color-amber { background-color: #f59e0b; }
        .note-color-dot.color-blue { background-color: #3b82f6; }
        .note-color-dot.color-ruby { background-color: #ef4444; }

        /* Prompt Overlay */
        .notes-modal-overlay {
          position: fixed;
          inset: 0;
          background-color: rgba(2, 3, 6, 0.85);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100050;
          animation: notesOverlayIn 0.2s ease-out;
        }

        .notes-modal-box {
          background-color: var(--bg-panel);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          max-width: 440px;
          width: 90%;
          padding: 24px;
          box-shadow: 0 20px 40px rgba(0,0,0,0.5);
          display: flex;
          flex-direction: column;
          gap: 16px;
          animation: notesBoxIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .notes-modal-title {
          font-size: 14px;
          font-family: ui-monospace, monospace;
          text-transform: uppercase;
          color: #3b82f6;
          font-weight: bold;
          letter-spacing: 0.05em;
        }

        .notes-modal-message {
          font-size: 14.5px;
          line-height: 1.6;
          color: var(--text-primary);
          white-space: pre-wrap;
        }

        .notes-modal-buttons {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 8px;
        }

        .notes-modal-btn {
          padding: 8px 16px;
          font-size: 11px;
          font-family: ui-monospace, monospace;
          font-weight: bold;
          text-transform: uppercase;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
          border: 1px solid transparent;
        }

        .notes-modal-btn.cancel-btn {
          background-color: transparent;
          border-color: var(--border-color);
          color: var(--text-secondary);
        }

        .notes-modal-btn.cancel-btn:hover {
          background-color: var(--btn-bg);
          color: var(--text-title);
        }

        .notes-modal-btn.confirm-btn {
          background-color: #3b82f6;
          color: #ffffff;
        }

        .notes-modal-btn.confirm-btn:hover {
          background-color: #2563eb;
        }

        @keyframes notesOverlayIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes notesBoxIn {
          from { transform: scale(0.9) translateY(12px); opacity: 0; }
          to { transform: scale(1) translateY(0); opacity: 1; }
        }
      `, 'notes-page-core-styles');
    }
  
  rebuildCanvasFromList() {
      this.canvas.innerHTML = '';
      this.activeDialogs.forEach(dialogObj => {
        if (dialogObj && typeof dialogObj.destroy === 'function') {
          dialogObj.destroy();
        }
      });
      this.activeDialogs.clear();

      this.notesList.forEach(note => {
        if (note.isOpen) {
          this.spawnNoteDialog(note);
        }
      });
    }

  // --- DISK EXPORT AND IMPORT HANDLERS ---
    exportNotesToFile() {
      this.getAllNotesFromDB().then(notes => {
        if (notes.length === 0) {
          this.app.showToastMessage('No notes to export');
          return;
        }

        try {
          const serialized = JSON.stringify(notes, null, 2);
          const blob = new Blob([serialized], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          
          const downloader = makeElement('a', {
            href: url,
            download: 'scratchpad_notes.json'
          });
          
          document.body.appendChild(downloader);
          downloader.click();
          downloader.remove();
          
          URL.revokeObjectURL(url);
          this.app.showToastMessage('Saved notes to scratchpad_notes.json');
        } catch (err) {
          console.error('File export failure:', err);
          this.app.showToastMessage('Error exporting file');
        }
      });
    }

  handleFileImportSelection(e) {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target.result);
          this.processImportedJSON(parsed);
        } catch (err) {
          this.promptCustomAlert('Invalid file structure. Make sure you select a valid JSON backup file.');
        }
      };
      reader.readAsText(file);
      
      // Reset input value so same file can be selected again
      e.target.value = '';
    }

  async processImportedJSON(data) {
      const itemsToImport = Array.isArray(data) ? data : [data];
      let importCount = 0;

      for (const item of itemsToImport) {
        // Validate if item has basic note content or parameters
        if (item && (item.content !== undefined || item.message !== undefined)) {
          // If the imported note has coordinates, respect them or cascade safely
          const coords = this.findFreeSpace(item.width || 300, item.height || 220);
          
          const newNote = {
            content: item.content || item.message || item.text || '',
            x: typeof item.x === 'number' ? item.x : coords.x,
            y: typeof item.y === 'number' ? item.y : coords.y,
            width: item.width || 300,
            height: item.height || 220,
            isOpen: item.isOpen !== undefined ? item.isOpen : true,
            colorTheme: item.colorTheme || 'slate',
            timestamp: item.timestamp || Date.now()
          };

          await this.saveNoteToDB(newNote);
          importCount++;
        }
      }

      if (importCount > 0) {
        this.app.showToastMessage(`Successfully imported ${importCount} notes!`);
        this.loadAndDisplayNotes();
      } else {
        this.promptCustomAlert('Could not find any valid notes to import in the file.');
      }
    }

  // --- SELF-CONTAINED OBSERVER WITH AUTOMATIC CLOSE DETECTION ---
    startCoordinateObserver() {
      if (this.observerInterval) {
        clearInterval(this.observerInterval);
      }

      this.observerInterval = setInterval(() => {
        // Lifecycle Check: If canvas is unmounted from the DOM, clean up all window listeners and stop
        if (!this.canvas || !document.body.contains(this.canvas)) {
          this.destroyLifecycle();
          return;
        }

        const canvasRect = this.canvas.getBoundingClientRect();

        this.activeDialogs.forEach((dialogObj, id) => {
          const dialogEl = dialogObj.dialogElement;
          
          // Detect Native Close: If the dialog element is no longer in the document, it was closed by the user
          if (!dialogEl || !document.body.contains(dialogEl)) {
            const note = this.notesList.find(n => n.id === id);
            if (note && note.isOpen) {
              note.isOpen = false;
              this.saveNoteToDB(note);
              this.activeDialogs.delete(id);
              this.app.showToastMessage(`Note closed`);
            }
            return;
          }

          const rect = dialogEl.getBoundingClientRect();
          
          const currentX = Math.round(rect.left - canvasRect.left);
          const currentY = Math.round(rect.top - canvasRect.top);
          const currentW = Math.round(rect.width);
          const currentH = Math.round(rect.height);

          const note = this.notesList.find(n => n.id === id);
          if (note) {
            // Only update sizes in DB if the note is NOT minimized (minimizing overrides target height)
            if (!note.isMinimized) {
              if (note.x !== currentX || note.y !== currentY || note.width !== currentW || note.height !== currentH) {
                note.x = currentX;
                note.y = currentY;
                note.width = currentW;
                note.height = currentH;
                this.saveNoteToDB(note);
              }
            } else {
              // If minimized, only track movements (x, y)
              if (note.x !== currentX || note.y !== currentY) {
                note.x = currentX;
                note.y = currentY;
                this.saveNoteToDB(note);
              }
            }
          }
        });
      }, 800);
    }

  destroyLifecycle() {
      if (this.observerInterval) {
        clearInterval(this.observerInterval);
        this.observerInterval = null;
      }
      if (this.modalKeyHandler) {
        window.removeEventListener('keydown', this.modalKeyHandler);
        this.modalKeyHandler = null;
      }
      // Remove global programmatic window reference
      if (window.Scratchpad) {
        delete window.Scratchpad;
      }
    }

  // Controls dialog sizing and layout styling based on minimized status
    applyNoteMinimizedState(dialogEl, isMinimized, targetWidth, targetExpandedHeight) {
      if (!dialogEl) return;

      const innerBody = dialogEl.querySelector('.note-dialog-inner-body');
      if (isMinimized) {
        dialogEl.classList.add('is-minimized');
        dialogEl.style.height = '44px';
        dialogEl.style.minHeight = '44px';
        if (innerBody) {
          innerBody.style.display = 'none'; // Hide content securely
        }
      } else {
        dialogEl.classList.remove('is-minimized');
        dialogEl.style.height = `${targetExpandedHeight}px`;
        dialogEl.style.minHeight = '140px'; // Prevent collapsing past comfortable editing bounds
        if (innerBody) {
          innerBody.style.display = 'flex';
        }
      }
    }

  // --- HOOK FOR MAKING THE TITLE BAR EDITABLE ---
    makeTitleEditable(dialogEl, note) {
      if (!dialogEl) return;

      // Attempt to query any common title element tags inside the dialog's header
      const titleEl = dialogEl.querySelector('.dialog-title') || 
                      dialogEl.querySelector('.title') || 
                      dialogEl.querySelector('.modal-title') ||
                      dialogEl.querySelector('[class*="title"]') ||
                      dialogEl.querySelector('[class*="header"] span') ||
                      dialogEl.querySelector('[class*="header"]');

      if (titleEl) {
        titleEl.contentEditable = "true";
        titleEl.style.cursor = "text";
        titleEl.style.outline = "none";
        titleEl.style.borderBottom = "1px dashed rgba(255,255,255,0.4)";
        titleEl.style.paddingBottom = "1px";
        titleEl.title = "Click to rename this note";

        // Avoid drag event propagation when clicking/editing text inside header title
        titleEl.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });

        titleEl.addEventListener('blur', () => {
          const newTitle = titleEl.textContent.trim();
          if (newTitle) {
            note.title = newTitle;
            this.saveNoteToDB(note);
          }
        });

        titleEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            titleEl.blur(); // Triggers save on enter
          }
        });
      }
    }
}